import { and, asc, eq, lt } from 'drizzle-orm';
import { indexerCheckpoints, repos, type RwcarDb } from '@rwcar/db';
import { MONAD_TESTNET } from '@rwcar/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { IndexerConfig } from './config.js';
import { REPO_INDEXER_CONSUMER } from './indexer.js';

const keeperAbi = parseAbi([
  'function expireOffer(uint256 repoId)',
  'function markDefault(uint256 repoId)',
]);
const RETRY_COOLDOWN_MS = 120_000;
type KeeperAction = 'expireOffer' | 'markDefault';

export function keeperRetryKey(action: KeeperAction, repoId: string) {
  return `${action}:${repoId}`;
}

export function keeperCheckpointState(
  checkpointBlock: bigint | undefined,
  chainHead: bigint,
  confirmations: bigint,
) {
  const finalizedBlock = chainHead >= confirmations ? chainHead - confirmations : 0n;
  return {
    caughtUp: checkpointBlock !== undefined && checkpointBlock >= finalizedBlock,
    checkpointBlock,
    finalizedBlock,
  };
}

export class DefaultKeeper {
  private readonly market: Address;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly recentlySubmitted = new Map<string, number>();
  private running = false;

  constructor(private readonly config: IndexerConfig, private readonly db: RwcarDb) {
    if (!config.KEEPER_PRIVATE_KEY) throw new Error('KEEPER_PRIVATE_KEY is required to start the lifecycle keeper');
    this.market = config.REPO_MARKET_ADDRESS as Address;
    this.account = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as Hex);
    const chain = defineChain({
      id: MONAD_TESTNET.id,
      name: MONAD_TESTNET.name,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
    });
    const transport = http(config.MONAD_RPC_URL, { timeout: 15_000, retryCount: 3 });
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  stop() { this.running = false; }

  private async checkpointState() {
    const [chainHead, checkpoints] = await Promise.all([
      this.publicClient.getBlockNumber(),
      this.db.select({ blockNumber: indexerCheckpoints.blockNumber }).from(indexerCheckpoints).where(and(
        eq(indexerCheckpoints.chainId, MONAD_TESTNET.id),
        eq(indexerCheckpoints.consumer, REPO_INDEXER_CONSUMER),
      )).limit(1),
    ]);
    return keeperCheckpointState(checkpoints[0]?.blockNumber, chainHead, this.config.INDEXER_CONFIRMATIONS);
  }

  private async dueDefaults() {
    return this.db.select({ repoId: repos.repoId }).from(repos).where(and(
      eq(repos.chainId, MONAD_TESTNET.id),
      eq(repos.marketAddress, this.market.toLowerCase()),
      eq(repos.status, 'ACTIVE'),
      lt(repos.graceEndsAt, new Date()),
    )).orderBy(asc(repos.graceEndsAt)).limit(25);
  }

  private async dueExpiredOffers() {
    return this.db.select({ repoId: repos.repoId }).from(repos).where(and(
      eq(repos.chainId, MONAD_TESTNET.id),
      eq(repos.marketAddress, this.market.toLowerCase()),
      eq(repos.status, 'OPEN'),
      lt(repos.offerExpiry, new Date()),
    )).orderBy(asc(repos.offerExpiry)).limit(25);
  }

  private async submit(action: KeeperAction, repoId: string, now: number) {
    const retryKey = keeperRetryKey(action, repoId);
    const lastSubmission = this.recentlySubmitted.get(retryKey) ?? 0;
    if (now - lastSubmission < RETRY_COOLDOWN_MS) return;

    try {
      const simulation = await this.publicClient.simulateContract({
        account: this.account,
        address: this.market,
        abi: keeperAbi,
        functionName: action,
        args: [BigInt(repoId)],
      });
      const hash = await this.walletClient.writeContract(simulation.request);
      this.recentlySubmitted.set(retryKey, Date.now());
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
      if (receipt.status !== 'success') throw new Error(`Keeper transaction ${hash} reverted`);
      if (action === 'expireOffer') console.log(`Automatically expired offer ${repoId}: ${hash}`);
      else console.log(`Automatically marked repo ${repoId} defaulted: ${hash}`);
    } catch (error) {
      // A concurrent keeper or user may have completed the transition first.
      // The event indexer remains the source of truth and will project that state.
      this.recentlySubmitted.set(retryKey, Date.now());
      const label = action === 'expireOffer' ? 'Expiry keeper' : 'Default keeper';
      console.error(`${label} could not process repo ${repoId}`, error);
    }
  }

  async runOnce() {
    const checkpoint = await this.checkpointState();
    if (!checkpoint.caughtUp) {
      const position = checkpoint.checkpointBlock === undefined
        ? 'checkpoint missing'
        : `checkpoint ${checkpoint.checkpointBlock} < finalized ${checkpoint.finalizedBlock}`;
      console.log(`Repo lifecycle keeper skipped: ${position}.`);
      return;
    }

    const now = Date.now();
    const [expiredOffers, defaults] = await Promise.all([
      this.dueExpiredOffers(),
      this.dueDefaults(),
    ]);
    for (const row of expiredOffers) await this.submit('expireOffer', row.repoId, now);
    for (const row of defaults) await this.submit('markDefault', row.repoId, now);
  }

  async run() {
    this.running = true;
    console.log(`Repo lifecycle keeper active as ${this.account.address}.`);
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        console.error('Repo lifecycle keeper scan failed', error);
      }
      if (this.running) await new Promise((resolve) => setTimeout(resolve, this.config.KEEPER_POLL_MS));
    }
  }
}
