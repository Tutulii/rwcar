import { and, eq } from 'drizzle-orm';
import { chainEvents, indexerCheckpoints, repos, type RwcarDb } from '@rwcar/db';
import { MONAD_TESTNET } from '@rwcar/shared';
import { createPublicClient, defineChain, http, type Address, type PublicClient } from 'viem';
import { repoEventsAbi } from './abi.js';
import type { IndexerConfig } from './config.js';
import { jsonSafe, projectEvent } from './projector.js';

export const REPO_INDEXER_CONSUMER = 'repo-market-v1';

export class RepoIndexer {
  private readonly market: Address;
  private readonly client: PublicClient;
  private running = false;

  constructor(private readonly config: IndexerConfig, private readonly db: RwcarDb) {
    this.market = config.REPO_MARKET_ADDRESS as Address;
    const chain = defineChain({
      id: MONAD_TESTNET.id,
      name: MONAD_TESTNET.name,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
    });
    this.client = createPublicClient({ chain, transport: http(config.MONAD_RPC_URL, { timeout: 15_000, retryCount: 3 }) });
  }

  stop() { this.running = false; }

  private async checkpoint() {
    const [value] = await this.db.select().from(indexerCheckpoints).where(and(
      eq(indexerCheckpoints.chainId, MONAD_TESTNET.id),
      eq(indexerCheckpoints.consumer, REPO_INDEXER_CONSUMER),
    )).limit(1);
    return value;
  }

  private async resetForReorg() {
    await this.db.transaction(async (tx) => {
      await tx.delete(repos).where(and(eq(repos.chainId, MONAD_TESTNET.id), eq(repos.marketAddress, this.market.toLowerCase())));
      await tx.delete(chainEvents).where(and(eq(chainEvents.chainId, MONAD_TESTNET.id), eq(chainEvents.contractAddress, this.market.toLowerCase())));
      await tx.delete(indexerCheckpoints).where(and(
        eq(indexerCheckpoints.chainId, MONAD_TESTNET.id),
        eq(indexerCheckpoints.consumer, REPO_INDEXER_CONSUMER),
      ));
    });
  }

  private async nextBlock() {
    const checkpoint = await this.checkpoint();
    if (!checkpoint) return this.config.REPO_MARKET_DEPLOYMENT_BLOCK;
    const canonical = await this.client.getBlock({ blockNumber: checkpoint.blockNumber });
    if (canonical.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
      console.warn('Indexer checkpoint reorg detected; rebuilding the market projection.');
      await this.resetForReorg();
      return this.config.REPO_MARKET_DEPLOYMENT_BLOCK;
    }
    return checkpoint.blockNumber + 1n;
  }

  async syncOnce() {
    const head = await this.client.getBlockNumber();
    if (head < this.config.INDEXER_CONFIRMATIONS) return { count: 0, caughtUp: true };
    const finalized = head - this.config.INDEXER_CONFIRMATIONS;
    const fromBlock = await this.nextBlock();
    if (fromBlock > finalized) return { count: 0, caughtUp: true };
    const toBlock = fromBlock + this.config.INDEXER_BATCH_SIZE - 1n > finalized
      ? finalized
      : fromBlock + this.config.INDEXER_BATCH_SIZE - 1n;
    const logs = await this.client.getContractEvents({
      address: this.market,
      abi: repoEventsAbi,
      fromBlock,
      toBlock,
      strict: true,
    });
    const timestampCache = new Map<bigint, bigint>();
    for (const log of logs) {
      if (!log.transactionHash || !log.blockHash || log.logIndex === null || !log.eventName) continue;
      let timestamp = timestampCache.get(log.blockNumber);
      if (timestamp === undefined) {
        timestamp = (await this.client.getBlock({ blockNumber: log.blockNumber })).timestamp;
        timestampCache.set(log.blockNumber, timestamp);
      }
      await this.db.transaction(async (tx) => {
        const inserted = await tx.insert(chainEvents).values({
          chainId: MONAD_TESTNET.id,
          txHash: log.transactionHash!.toLowerCase(),
          logIndex: log.logIndex!,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash!.toLowerCase(),
          contractAddress: this.market.toLowerCase(),
          eventName: log.eventName,
          payload: jsonSafe(log.args) as Record<string, unknown>,
        }).onConflictDoNothing().returning({ txHash: chainEvents.txHash });
        if (inserted.length > 0) {
          await projectEvent(tx, {
            eventName: log.eventName,
            args: log.args as Record<string, unknown>,
            chainId: MONAD_TESTNET.id,
            marketAddress: this.market.toLowerCase(),
            transactionHash: log.transactionHash!.toLowerCase(),
            blockNumber: log.blockNumber,
            blockTimestamp: timestamp!,
          });
        }
      });
    }
    const block = await this.client.getBlock({ blockNumber: toBlock });
    await this.db.insert(indexerCheckpoints).values({
      chainId: MONAD_TESTNET.id,
      consumer: REPO_INDEXER_CONSUMER,
      blockNumber: toBlock,
      blockHash: block.hash.toLowerCase(),
    }).onConflictDoUpdate({
      target: [indexerCheckpoints.chainId, indexerCheckpoints.consumer],
      set: { blockNumber: toBlock, blockHash: block.hash.toLowerCase(), updatedAt: new Date() },
    });
    return { count: logs.length, caughtUp: toBlock >= finalized };
  }

  async run() {
    this.running = true;
    while (this.running) {
      let caughtUp = true;
      try {
        const result = await this.syncOnce();
        const { count } = result;
        caughtUp = result.caughtUp;
        if (count > 0) console.log(`Indexed ${count} RepoMarketV1 event(s).`);
      } catch (error) {
        console.error('Indexer sync failed', error);
      }
      if (this.running && caughtUp) {
        await new Promise((resolve) => setTimeout(resolve, this.config.INDEXER_POLL_MS));
      }
    }
  }
}
