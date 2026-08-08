import { automationJobs, indexerCheckpoints, type RwcarDb } from '@rwcar/db';
import { marginEngineV2Abi, MONAD_TESTNET, repoMarketV2Abi } from '@rwcar/shared';
import { and, asc, eq, inArray, lte, lt, or, sql } from 'drizzle-orm';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { IndexerConfig, V2DeploymentSource } from './config.js';
import { v2Consumer } from './v2-indexer.js';

const LEASE_MS = 120_000;
const MAX_BATCH = 10;
type V2JobAction =
  | 'finalizeOfferExpiry'
  | 'startAuction'
  | 'finalizeFailedAuction'
  | 'declarePaymentDefault'
  | 'startMarginLiquidation'
  | 'finalizeFailedMarginAuction'
  | 'startInKindOracleFallback'
  | 'materializeLiquidationClaim';

export function automationRetryDelayMs(attempt: number) {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

export function isAutomationLeaseClaimable(
  status: string,
  nextAttemptAt: Date,
  lockedAt: Date | null,
  now: Date,
  leaseMs = LEASE_MS,
) {
  if ((status === 'PENDING' || status === 'RETRY') && nextAttemptAt <= now) return true;
  if (status === 'SUBMITTED' && nextAttemptAt <= now) return true;
  return status === 'RUNNING' && lockedAt !== null && lockedAt.getTime() < now.getTime() - leaseMs;
}

export function isSupportedV2JobAction(action: string): action is V2JobAction {
  return [
    'finalizeOfferExpiry',
    'startAuction',
    'finalizeFailedAuction',
    'declarePaymentDefault',
    'startMarginLiquidation',
    'finalizeFailedMarginAuction',
    'startInKindOracleFallback',
    'materializeLiquidationClaim',
  ].includes(action);
}

export function isSignedAutomationTransaction(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

export function v2AutomationCheckpointState(
  checkpointBlocks: bigint[],
  expectedSources: number,
  chainHead: bigint,
  confirmations: bigint,
  maxLag: bigint,
) {
  const finalizedBlock = chainHead >= confirmations ? chainHead - confirmations : 0n;
  const minimumBlock = finalizedBlock > maxLag ? finalizedBlock - maxLag : 0n;
  const complete = expectedSources > 0 && checkpointBlocks.length === expectedSources;
  return {
    ready: complete && checkpointBlocks.every((block) => block >= minimumBlock && block <= chainHead),
    finalizedBlock,
    minimumBlock,
  };
}

export class V2AutomationWorker {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly workerId: string;
  private running = false;

  constructor(
    private readonly config: IndexerConfig,
    private readonly db: RwcarDb,
    private readonly sources: V2DeploymentSource[],
  ) {
    if (!config.KEEPER_PRIVATE_KEY) throw new Error('KEEPER_PRIVATE_KEY is required for the V2 automation worker');
    this.account = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as Hex);
    this.workerId = `${this.account.address.toLowerCase()}:${process.pid}`;
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

  private async finalizedGate() {
    const head = await this.publicClient.getBlockNumber();
    const consumers = this.sources.map(v2Consumer);
    const checkpoints = consumers.length === 0 ? [] : await this.db.select({
      consumer: indexerCheckpoints.consumer,
      blockNumber: indexerCheckpoints.blockNumber,
    }).from(indexerCheckpoints).where(and(
      eq(indexerCheckpoints.chainId, MONAD_TESTNET.id),
      inArray(indexerCheckpoints.consumer, consumers),
    ));
    return v2AutomationCheckpointState(
      checkpoints.map((checkpoint) => checkpoint.blockNumber),
      consumers.length,
      head,
      this.config.INDEXER_CONFIRMATIONS,
      this.config.V2_AUTOMATION_MAX_CHECKPOINT_LAG,
    ).ready;
  }

  private async claimDueJobs() {
    const now = new Date();
    const staleLease = new Date(now.getTime() - LEASE_MS);
    const candidates = await this.db.select().from(automationJobs).where(and(
      eq(automationJobs.chainId, MONAD_TESTNET.id),
      sql`${automationJobs.metadata}->>'protocolVersion' = 'v2'`,
      or(
        and(inArray(automationJobs.status, ['PENDING', 'RETRY', 'SUBMITTED']), lte(automationJobs.nextAttemptAt, now)),
        and(eq(automationJobs.status, 'RUNNING'), lt(automationJobs.lockedAt, staleLease)),
      ),
    )).orderBy(asc(automationJobs.nextAttemptAt)).limit(MAX_BATCH);

    const claimed = [];
    for (const candidate of candidates) {
      const [row] = await this.db.update(automationJobs).set({
        status: 'RUNNING',
        attempts: sql`${automationJobs.attempts} + 1`,
        lockedBy: this.workerId,
        lockedAt: now,
        updatedAt: now,
      }).where(and(
        eq(automationJobs.id, candidate.id),
        or(
          inArray(automationJobs.status, ['PENDING', 'RETRY', 'SUBMITTED']),
          and(eq(automationJobs.status, 'RUNNING'), lt(automationJobs.lockedAt, staleLease)),
        ),
      )).returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  private async complete(id: string, txHash: string) {
    await this.db.update(automationJobs).set({
      status: 'SUCCEEDED',
      txHash,
      lockedBy: null,
      lockedAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
      signedTransaction: null,
    }).where(and(
      eq(automationJobs.id, id),
      inArray(automationJobs.status, ['RUNNING', 'SUBMITTED']),
      or(eq(automationJobs.lockedBy, this.workerId), eq(automationJobs.txHash, txHash.toLowerCase())),
    ));
  }

  private async markPrepared(id: string, txHash: Hex, signedTransaction: Hex, nonce: number) {
    const now = new Date();
    const [persisted] = await this.db.update(automationJobs).set({
      status: 'SUBMITTED',
      txHash: txHash.toLowerCase(),
      transactionNonce: String(nonce),
      signedTransaction,
      preparedAt: now,
      submittedAt: null,
      nextAttemptAt: new Date(now.getTime() + this.config.KEEPER_POLL_MS),
      lockedBy: null,
      lockedAt: null,
      updatedAt: now,
      lastError: null,
    }).where(and(eq(automationJobs.id, id), eq(automationJobs.lockedBy, this.workerId)))
      .returning({ id: automationJobs.id });
    if (!persisted) throw new Error(`Automation job ${id} lost its lease before transaction persistence`);
  }

  private async markBroadcast(id: string, txHash: Hex) {
    await this.db.update(automationJobs).set({
      submittedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    }).where(and(
      eq(automationJobs.id, id),
      eq(automationJobs.status, 'SUBMITTED'),
      eq(automationJobs.txHash, txHash.toLowerCase()),
    ));
  }

  private async deferSubmitted(id: string, txHash: string, message?: string) {
    await this.db.update(automationJobs).set({
      status: 'SUBMITTED',
      txHash: txHash.toLowerCase(),
      nextAttemptAt: new Date(Date.now() + this.config.KEEPER_POLL_MS),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
      ...(message ? { lastError: message.slice(0, 2_000) } : {}),
    }).where(and(
      eq(automationJobs.id, id),
      inArray(automationJobs.status, ['RUNNING', 'SUBMITTED']),
    ));
  }

  private async fail(job: typeof automationJobs.$inferSelect, error: unknown) {
    const exhausted = job.attempts >= job.maxAttempts;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await this.db.update(automationJobs).set({
      status: exhausted ? 'DEAD' : 'RETRY',
      nextAttemptAt: new Date(Date.now() + automationRetryDelayMs(job.attempts)),
      lockedBy: null,
      lockedAt: null,
      completedAt: exhausted ? new Date() : null,
      updatedAt: new Date(),
      lastError: message,
      submittedAt: null,
      txHash: null,
      transactionNonce: null,
      signedTransaction: null,
      preparedAt: null,
    }).where(and(
      eq(automationJobs.id, job.id),
      inArray(automationJobs.status, ['RUNNING', 'SUBMITTED']),
      job.txHash
        ? or(eq(automationJobs.lockedBy, this.workerId), eq(automationJobs.txHash, job.txHash.toLowerCase()))
        : eq(automationJobs.lockedBy, this.workerId),
    ));
  }

  private assertDestination(job: typeof automationJobs.$inferSelect) {
    const module = ['finalizeOfferExpiry', 'startAuction', 'finalizeFailedAuction'].includes(job.action)
      ? 'REPO_MARKET'
      : 'MARGIN_ENGINE';
    const source = this.sources.find((candidate) => candidate.module === module);
    if (!source || source.address.toLowerCase() !== job.contractAddress.toLowerCase()) {
      throw new Error(`Automation destination ${job.contractAddress} is not the configured ${module}`);
    }
  }

  private async reconcileSubmitted(job: typeof automationJobs.$inferSelect, txHash: Hex) {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        await this.fail(job, new Error(`Automation transaction ${txHash} reverted`));
        return;
      }
      const head = await this.publicClient.getBlockNumber();
      if (head < receipt.blockNumber + this.config.INDEXER_CONFIRMATIONS) {
        await this.deferSubmitted(job.id, txHash);
        return;
      }
      await this.complete(job.id, txHash);
      console.log(`V2 automation ${job.action}(${job.resourceId}) finalized: ${txHash}`);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // A signed outbox row is durable before first broadcast. Re-sending the
      // exact bytes is idempotent (same nonce, signature and hash), closing the
      // process-crash/RPC-timeout window without ever authoring a second call.
      if (isSignedAutomationTransaction(job.signedTransaction)) {
        const signedTransaction = job.signedTransaction;
        if (keccak256(signedTransaction).toLowerCase() !== txHash.toLowerCase()) {
          await this.deferSubmitted(job.id, txHash, 'Signed transaction hash mismatch; manual intervention required');
          return;
        }
        try {
          const broadcastHash = await this.publicClient.sendRawTransaction({ serializedTransaction: signedTransaction });
          if (broadcastHash.toLowerCase() !== txHash.toLowerCase()) {
            throw new Error(`RPC returned unexpected transaction hash ${broadcastHash}`);
          }
          await this.markBroadcast(job.id, txHash);
          message = 'Exact signed transaction rebroadcast; receipt pending';
        } catch (broadcastError) {
          const detail = broadcastError instanceof Error ? broadcastError.message : String(broadcastError);
          message = `Receipt pending; exact rebroadcast response: ${detail}`;
        }
      }
      await this.deferSubmitted(job.id, txHash, message);
    }
  }

  private async execute(job: typeof automationJobs.$inferSelect) {
    if (!isSupportedV2JobAction(job.action)) {
      await this.fail({ ...job, attempts: job.maxAttempts }, new Error(`Unsupported automation action ${job.action}`));
      return;
    }
    let preparedHash: Hex | undefined;
    let preparedPersisted = false;
    try {
      this.assertDestination(job);
      if (job.txHash) {
        await this.reconcileSubmitted(job, job.txHash as Hex);
        return;
      }
      const repoAction = ['finalizeOfferExpiry', 'startAuction', 'finalizeFailedAuction'].includes(job.action);
      let data: Hex;
      if (repoAction) {
        const functionName = job.action as 'finalizeOfferExpiry' | 'startAuction' | 'finalizeFailedAuction';
        await this.publicClient.simulateContract({
          account: this.account,
          address: job.contractAddress as Address,
          abi: repoMarketV2Abi,
          functionName,
          args: [BigInt(job.resourceId)],
        });
        data = encodeFunctionData({ abi: repoMarketV2Abi, functionName, args: [BigInt(job.resourceId)] });
      } else {
        const functionName = job.action as 'declarePaymentDefault' | 'startMarginLiquidation' | 'finalizeFailedMarginAuction' | 'startInKindOracleFallback' | 'materializeLiquidationClaim';
        await this.publicClient.simulateContract({
          account: this.account,
          address: job.contractAddress as Address,
          abi: marginEngineV2Abi,
          functionName,
          args: [BigInt(job.resourceId)],
        });
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName, args: [BigInt(job.resourceId)] });
      }
      const prepared = await this.walletClient.prepareTransactionRequest({
        account: this.account,
        to: job.contractAddress as Address,
        data,
      });
      const signedTransaction = await this.walletClient.signTransaction(prepared);
      preparedHash = keccak256(signedTransaction);
      // Transaction bytes and their deterministic hash are committed before
      // any network broadcast. A crash on either side of sendRawTransaction is
      // recovered by rebroadcasting these exact bytes, never a new transaction.
      await this.markPrepared(job.id, preparedHash, signedTransaction, prepared.nonce);
      preparedPersisted = true;
      const broadcastHash = await this.publicClient.sendRawTransaction({ serializedTransaction: signedTransaction });
      if (broadcastHash.toLowerCase() !== preparedHash.toLowerCase()) {
        throw new Error(`RPC returned unexpected transaction hash ${broadcastHash}`);
      }
      await this.markBroadcast(job.id, preparedHash);
      await this.reconcileSubmitted({
        ...job,
        status: 'SUBMITTED',
        txHash: preparedHash,
        transactionNonce: String(prepared.nonce),
        signedTransaction,
        preparedAt: new Date(),
        submittedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      }, preparedHash);
    } catch (error) {
      // Once signed bytes are durable, reconciliation owns the job and retries
      // only the exact raw transaction. Pre-persistence failures are retryable.
      if (preparedPersisted && preparedHash) {
        await this.deferSubmitted(job.id, preparedHash, error instanceof Error ? error.message : String(error));
      } else if (job.txHash) await this.deferSubmitted(job.id, job.txHash, error instanceof Error ? error.message : String(error));
      else await this.fail(job, error);
      console.error(`V2 automation ${job.action}(${job.resourceId}) failed`, error);
    }
  }

  async runOnce() {
    if (!await this.finalizedGate()) {
      console.log('V2 automation skipped until every enabled source enters the bounded finalized checkpoint window.');
      return;
    }
    for (const job of await this.claimDueJobs()) await this.execute(job);
  }

  async run() {
    this.running = true;
    console.log(`V2 durable automation active as ${this.account.address}.`);
    while (this.running) {
      try { await this.runOnce(); } catch (error) { console.error('V2 automation scan failed', error); }
      if (this.running) await new Promise((resolve) => setTimeout(resolve, this.config.KEEPER_POLL_MS));
    }
  }
}
