import {
  auctionSettlements,
  auctions,
  automationJobs,
  chainEvents,
  indexerCheckpoints,
  marginAccounts,
  marginCalls,
  marginExposures,
  marginLiquidations,
  oracleValuations,
  protocolDeployments,
  riskConfigurations,
  settlementClaims,
  v2Offers,
  v2Positions,
  vaultBalances,
  vaultLedgerEntries,
  type RwcarDb,
} from '@rwcar/db';
import { CONTRACTS, marginEngineV2Abi, MONAD_TESTNET, v2AbiByModule } from '@rwcar/shared';
import { and, eq, like, notInArray, sql } from 'drizzle-orm';
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import type { IndexerConfig, V2DeploymentSource } from './config.js';
import { jsonSafe } from './projector.js';
import { projectV2Event } from './v2-projector.js';

const enrichmentAbi = [
  { type: 'function', name: 'gracePeriod', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'getOffer', stateMutability: 'view', inputs: [{ name: 'offerId', type: 'uint256' }], outputs: [
    { name: '', type: 'tuple', components: [
      { name: 'seller', type: 'address' }, { name: 'permittedBuyer', type: 'address' }, { name: 'asset', type: 'address' },
      { name: 'vault', type: 'address' }, { name: 'totalCollateral', type: 'uint128' }, { name: 'targetPrincipal', type: 'uint128' },
      { name: 'filledPrincipal', type: 'uint128' }, { name: 'allocatedCollateral', type: 'uint128' }, { name: 'feeCharged', type: 'uint128' },
      { name: 'minimumFill', type: 'uint128' }, { name: 'annualRateBps', type: 'uint32' }, { name: 'defaultAnnualRateBps', type: 'uint32' },
      { name: 'duration', type: 'uint64' }, { name: 'offerExpiry', type: 'uint64' }, { name: 'earlyMinHoldBps', type: 'uint16' },
      { name: 'earlyBreakFeeBps', type: 'uint16' }, { name: 'earlyRepurchaseEnabled', type: 'bool' }, { name: 'status', type: 'uint8' },
      { name: 'valuationDigest', type: 'bytes32' },
    ] },
  ] },
  { type: 'function', name: 'getPosition', stateMutability: 'view', inputs: [{ name: 'positionId', type: 'uint256' }], outputs: [
    { name: '', type: 'tuple', components: [
      { name: 'offerId', type: 'uint256' }, { name: 'auctionId', type: 'uint256' }, { name: 'seller', type: 'address' },
      { name: 'buyer', type: 'address' }, { name: 'asset', type: 'address' }, { name: 'vault', type: 'address' },
      { name: 'collateralAmount', type: 'uint128' }, { name: 'principalAmount', type: 'uint128' }, { name: 'frozenDebt', type: 'uint256' },
      { name: 'annualRateBps', type: 'uint32' }, { name: 'defaultAnnualRateBps', type: 'uint32' }, { name: 'duration', type: 'uint64' },
      { name: 'acceptedAt', type: 'uint64' }, { name: 'maturity', type: 'uint64' }, { name: 'repaymentDeadline', type: 'uint64' },
      { name: 'earlyMinHoldBps', type: 'uint16' }, { name: 'earlyBreakFeeBps', type: 'uint16' }, { name: 'liquidationFeeBps', type: 'uint16' },
      { name: 'auctionStartBps', type: 'uint16' }, { name: 'auctionFloorBps', type: 'uint16' }, { name: 'auctionDuration', type: 'uint64' },
      { name: 'maxOracleAge', type: 'uint64' }, { name: 'staleOracleFallbackDelay', type: 'uint64' },
      { name: 'earlyRepurchaseEnabled', type: 'bool' }, { name: 'status', type: 'uint8' }, { name: 'closeoutValuationDigest', type: 'bytes32' },
    ] },
  ] },
  { type: 'function', name: 'getConfig', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [
    { name: 'config', type: 'tuple', components: [
      { name: 'enabled', type: 'bool' }, { name: 'initialLtvBps', type: 'uint16' }, { name: 'maintenanceLtvBps', type: 'uint16' },
      { name: 'liquidationLtvBps', type: 'uint16' }, { name: 'auctionStartBps', type: 'uint16' }, { name: 'auctionFloorBps', type: 'uint16' },
      { name: 'liquidationFeeBps', type: 'uint16' }, { name: 'earlyMinHoldBps', type: 'uint16' }, { name: 'earlyBreakFeeBps', type: 'uint16' },
      { name: 'defaultSpreadBps', type: 'uint32' }, { name: 'maxDefaultRateBps', type: 'uint32' }, { name: 'maxOracleAge', type: 'uint64' },
      { name: 'auctionDuration', type: 'uint64' }, { name: 'marginCallPeriod', type: 'uint64' },
      { name: 'staleOracleFallbackDelay', type: 'uint64' },
    ] },
  ] },
] as const;

export const v2Consumer = (source: Pick<V2DeploymentSource, 'module' | 'address'>) =>
  `v2:${source.module.toLowerCase()}:${source.address.toLowerCase()}`;

export const activeV2DeploymentAddresses = (sources: Pick<V2DeploymentSource, 'address'>[]) =>
  [...new Set(sources.map((source) => source.address.toLowerCase()))];

export function canonicalCheckpointMatches(checkpointHash: string, canonicalHash: string) {
  return checkpointHash.toLowerCase() === canonicalHash.toLowerCase();
}

function mergeImmutableNumericTerm(
  target: Record<string, unknown>,
  eventArgs: Record<string, unknown>,
  name: string,
  chainValue: unknown,
) {
  if (eventArgs[name] !== undefined && BigInt(String(eventArgs[name])) !== BigInt(String(chainValue))) {
    throw new Error(`OfferFilled ${name} does not match getPosition at the event block`);
  }
  target[name] = chainValue;
}

export class V2ProtocolIndexer {
  private readonly client: PublicClient;
  private running = false;
  private deploymentIds = new Map<string, string>();
  private readonly marketAddress: string;
  private readonly settlementToken: string;

  constructor(
    private readonly config: IndexerConfig,
    private readonly db: RwcarDb,
    private readonly sources: V2DeploymentSource[],
  ) {
    const market = sources.find((source) => source.module === 'REPO_MARKET');
    if (!market) throw new Error('V2 deployment sources require a REPO_MARKET module');
    this.marketAddress = market.address;
    this.settlementToken = (config.V2_SETTLEMENT_TOKEN_ADDRESS ?? CONTRACTS.aUsdc).toLowerCase();
    const chain = defineChain({
      id: MONAD_TESTNET.id,
      name: MONAD_TESTNET.name,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
    });
    this.client = createPublicClient({ chain, transport: http(config.MONAD_RPC_URL, { timeout: 15_000, retryCount: 3 }) });
  }

  stop() { this.running = false; }

  private async ensureDeployments() {
    const activeAddresses = activeV2DeploymentAddresses(this.sources);
    this.deploymentIds.clear();
    await this.db.transaction(async (tx) => {
      await tx.update(protocolDeployments).set({ enabled: false, updatedAt: new Date() }).where(and(
        eq(protocolDeployments.chainId, MONAD_TESTNET.id),
        eq(protocolDeployments.protocolVersion, 'v2'),
        notInArray(protocolDeployments.address, activeAddresses),
      ));
      for (const source of this.sources) {
        const [record] = await tx.insert(protocolDeployments).values({
          chainId: MONAD_TESTNET.id,
          protocolVersion: 'v2',
          module: source.module,
          address: source.address,
          deploymentBlock: source.deploymentBlock,
          metadata: source.metadata,
        }).onConflictDoUpdate({
          target: [protocolDeployments.chainId, protocolDeployments.address],
          set: {
            protocolVersion: 'v2',
            module: source.module,
            deploymentBlock: source.deploymentBlock,
            enabled: true,
            metadata: source.metadata,
            updatedAt: new Date(),
          },
        }).returning({ id: protocolDeployments.id });
        if (!record) throw new Error(`Could not register deployment ${source.address}`);
        this.deploymentIds.set(source.address, record.id);
      }
    });
  }

  private async checkpoint(source: V2DeploymentSource) {
    const [value] = await this.db.select().from(indexerCheckpoints).where(and(
      eq(indexerCheckpoints.chainId, MONAD_TESTNET.id), eq(indexerCheckpoints.consumer, v2Consumer(source)),
    )).limit(1);
    return value;
  }

  private async resetAllV2() {
    await this.db.transaction(async (tx) => {
      await tx.delete(auctionSettlements);
      await tx.delete(auctions);
      await tx.delete(settlementClaims);
      await tx.delete(vaultLedgerEntries);
      await tx.delete(vaultBalances);
      await tx.delete(marginLiquidations);
      await tx.delete(marginCalls);
      await tx.delete(marginExposures);
      await tx.delete(marginAccounts);
      await tx.delete(v2Positions);
      await tx.delete(v2Offers);
      await tx.delete(oracleValuations);
      await tx.delete(riskConfigurations);
      await tx.delete(automationJobs).where(sql`${automationJobs.metadata}->>'protocolVersion' = 'v2'`);
      await tx.delete(chainEvents).where(eq(chainEvents.protocolVersion, 'v2'));
      await tx.delete(indexerCheckpoints).where(and(
        eq(indexerCheckpoints.chainId, MONAD_TESTNET.id), like(indexerCheckpoints.consumer, 'v2:%'),
      ));
    });
  }

  private async nextBlock(source: V2DeploymentSource) {
    const checkpoint = await this.checkpoint(source);
    if (!checkpoint) return source.deploymentBlock;
    const canonical = await this.client.getBlock({ blockNumber: checkpoint.blockNumber });
    if (!canonicalCheckpointMatches(checkpoint.blockHash, canonical.hash)) {
      console.warn(`V2 reorg detected at ${v2Consumer(source)}; rebuilding all correlated V2 projections.`);
      await this.resetAllV2();
      return source.deploymentBlock;
    }
    return checkpoint.blockNumber + 1n;
  }

  private async enrich(
    source: V2DeploymentSource,
    eventName: string,
    args: Record<string, unknown>,
    blockNumber: bigint,
  ) {
    const enriched = { ...args };
    if (source.module === 'REPO_MARKET' && eventName === 'OfferCreated') {
      const [offer, gracePeriod] = await Promise.all([
        this.client.readContract({
          address: source.address as Address,
          abi: enrichmentAbi,
          functionName: 'getOffer',
          args: [BigInt(String(args.offerId))],
          blockNumber,
        }),
        this.client.readContract({ address: source.address as Address, abi: enrichmentAbi, functionName: 'gracePeriod', blockNumber }),
      ]);
      enriched.defaultAnnualRateBps = offer.defaultAnnualRateBps;
      enriched.earlyMinHoldBps = offer.earlyMinHoldBps;
      enriched.earlyBreakFeeBps = offer.earlyBreakFeeBps;
      enriched.gracePeriodSeconds = gracePeriod;
    }
    if (source.module === 'REPO_MARKET' && eventName === 'OfferFilled') {
      const position = await this.client.readContract({
        address: source.address as Address,
        abi: enrichmentAbi,
        functionName: 'getPosition',
        args: [BigInt(String(args.positionId))],
        blockNumber,
      });
      mergeImmutableNumericTerm(enriched, args, 'defaultAnnualRateBps', position.defaultAnnualRateBps);
      mergeImmutableNumericTerm(enriched, args, 'liquidationFeeBps', position.liquidationFeeBps);
      mergeImmutableNumericTerm(enriched, args, 'auctionStartBps', position.auctionStartBps);
      mergeImmutableNumericTerm(enriched, args, 'auctionFloorBps', position.auctionFloorBps);
      mergeImmutableNumericTerm(enriched, args, 'auctionDuration', position.auctionDuration);
      mergeImmutableNumericTerm(enriched, args, 'maxOracleAge', position.maxOracleAge);
      mergeImmutableNumericTerm(enriched, args, 'staleOracleFallbackDelay', position.staleOracleFallbackDelay);
    }
    if (source.module === 'RISK_MANAGER' && eventName === 'ConfigApplied') {
      const config = await this.client.readContract({
        address: source.address as Address,
        abi: enrichmentAbi,
        functionName: 'getConfig',
        args: [String(args.asset) as Address],
        blockNumber,
      });
      Object.assign(enriched, config);
    }
    if (source.module === 'MARGIN_ENGINE') {
      const [asset, settlementToken, vault, auctionHouse, settlementEscrow, gracePeriod] = await Promise.all([
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'asset', blockNumber }),
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'settlementToken', blockNumber }),
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'vault', blockNumber }),
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'auctionHouse', blockNumber }),
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'settlementEscrow', blockNumber }),
        this.client.readContract({ address: source.address as Address, abi: marginEngineV2Abi, functionName: 'gracePeriod', blockNumber }),
      ]);
      enriched.marginAsset = asset;
      enriched.marginSettlementToken = settlementToken;
      enriched.marginVault = vault;
      enriched.marginAuctionHouse = auctionHouse;
      enriched.marginSettlementEscrow = settlementEscrow;
      enriched.marginGracePeriod = gracePeriod;
      if (args.accountId !== undefined) {
        enriched.accountSnapshot = await this.client.readContract({
          address: source.address as Address,
          abi: marginEngineV2Abi,
          functionName: 'getAccount',
          args: [BigInt(String(args.accountId))],
          blockNumber,
        });
      }
      if (args.exposureId !== undefined) {
        enriched.exposureSnapshot = await this.client.readContract({
          address: source.address as Address,
          abi: marginEngineV2Abi,
          functionName: 'getExposure',
          args: [BigInt(String(args.exposureId))],
          blockNumber,
        });
      }
    }
    return enriched;
  }

  private async syncSource(source: V2DeploymentSource, finalized: bigint) {
    const fromBlock = await this.nextBlock(source);
    if (fromBlock > finalized) return { count: 0, caughtUp: true };
    const end = fromBlock + this.config.INDEXER_BATCH_SIZE - 1n;
    const toBlock = end > finalized ? finalized : end;
    const logs = await this.client.getLogs({ address: source.address as Address, fromBlock, toBlock });
    const abi = v2AbiByModule[source.module] as Abi;
    const timestampCache = new Map<bigint, bigint>();
    for (const log of logs) {
      if (!log.transactionHash || !log.blockHash || log.logIndex === null) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (!decoded.eventName) continue;
      const eventName = decoded.eventName;
      let blockTimestamp = timestampCache.get(log.blockNumber);
      if (blockTimestamp === undefined) {
        blockTimestamp = (await this.client.getBlock({ blockNumber: log.blockNumber })).timestamp;
        timestampCache.set(log.blockNumber, blockTimestamp);
      }
      const timestamp = blockTimestamp;
      const rawArgs = decoded.args as unknown as Record<string, unknown>;
      const args = await this.enrich(source, eventName, rawArgs, log.blockNumber);
      const deploymentId = this.deploymentIds.get(source.address);
      if (!deploymentId) throw new Error(`Deployment registry missing ${source.address}`);
      await this.db.transaction(async (tx) => {
        const inserted = await tx.insert(chainEvents).values({
          chainId: MONAD_TESTNET.id,
          txHash: log.transactionHash.toLowerCase(),
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash.toLowerCase(),
          contractAddress: source.address,
          eventName,
          payload: jsonSafe(args) as Record<string, unknown>,
          deploymentId,
          module: source.module,
          protocolVersion: 'v2',
          blockTimestamp: new Date(Number(timestamp) * 1000),
          finalized: true,
        }).onConflictDoNothing().returning({ txHash: chainEvents.txHash });
        if (inserted.length > 0) {
          await projectV2Event(tx, {
            module: source.module,
            eventName,
            args,
            chainId: MONAD_TESTNET.id,
            contractAddress: source.address,
            marketAddress: source.module === 'REPO_MARKET' || source.module === 'MARGIN_ENGINE'
              ? source.address
              : typeof source.metadata.controllerAddress === 'string'
                ? source.metadata.controllerAddress.toLowerCase()
                : this.marketAddress,
            settlementToken: typeof args.marginSettlementToken === 'string'
              ? args.marginSettlementToken.toLowerCase()
              : this.settlementToken,
            transactionHash: log.transactionHash.toLowerCase(),
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            blockTimestamp: timestamp,
          });
        }
      });
    }
    const block = await this.client.getBlock({ blockNumber: toBlock });
    await this.db.insert(indexerCheckpoints).values({
      chainId: MONAD_TESTNET.id,
      consumer: v2Consumer(source),
      blockNumber: toBlock,
      blockHash: block.hash.toLowerCase(),
    }).onConflictDoUpdate({
      target: [indexerCheckpoints.chainId, indexerCheckpoints.consumer],
      set: { blockNumber: toBlock, blockHash: block.hash.toLowerCase(), updatedAt: new Date() },
    });
    return { count: logs.length, caughtUp: toBlock >= finalized };
  }

  async syncOnce() {
    if (this.deploymentIds.size === 0) await this.ensureDeployments();
    const head = await this.client.getBlockNumber();
    if (head < this.config.INDEXER_CONFIRMATIONS) return { count: 0, caughtUp: true };
    const finalized = head - this.config.INDEXER_CONFIRMATIONS;
    let count = 0;
    let caughtUp = true;
    for (const source of this.sources) {
      const result = await this.syncSource(source, finalized);
      count += result.count;
      caughtUp = caughtUp && result.caughtUp;
    }
    return { count, caughtUp };
  }

  async run() {
    this.running = true;
    await this.ensureDeployments();
    while (this.running) {
      let caughtUp = true;
      try {
        const result = await this.syncOnce();
        caughtUp = result.caughtUp;
        if (result.count > 0) console.log(`Indexed ${result.count} RWCAR V2 event(s) across ${this.sources.length} source(s).`);
      } catch (error) {
        console.error('V2 multi-source indexer sync failed', error);
      }
      const delayMs = caughtUp ? this.config.INDEXER_POLL_MS : this.config.INDEXER_CATCHUP_DELAY_MS;
      if (this.running && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
