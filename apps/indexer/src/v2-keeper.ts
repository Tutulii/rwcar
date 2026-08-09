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
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { IndexerConfig, V2DeploymentSource } from './config.js';
import { v2Consumer } from './v2-indexer.js';

const LEASE_MS = 120_000;
// A single keeper signer must never author two different jobs from the same
// pending nonce. Resolve the durable outbox head before preparing another job.
const MAX_BATCH = 1;
const OFFER_STATUS_OPEN = 1;
const OFFER_STATUS_PARTIALLY_FILLED = 2;
const POSITION_STATUS_ACTIVE = 1;
type V2JobAction =
  | 'finalizeOfferExpiry'
  | 'startAuction'
  | 'finalizeFailedAuction'
  | 'declarePaymentDefault'
  | 'startMarginLiquidation'
  | 'finalizeFailedMarginAuction'
  | 'startInKindOracleFallback'
  | 'materializeLiquidationClaim';

const V2_JOB_ACTIONS: readonly V2JobAction[] = [
  'finalizeOfferExpiry',
  'startAuction',
  'finalizeFailedAuction',
  'declarePaymentDefault',
  'startMarginLiquidation',
  'finalizeFailedMarginAuction',
  'startInKindOracleFallback',
  'materializeLiquidationClaim',
];

export function automationRetryDelayMs(attempt: number) {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

export function durableLifecycleRetryDelayMs(attempt: number) {
  return Math.min(60_000, automationRetryDelayMs(attempt));
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
  return V2_JOB_ACTIONS.includes(action as V2JobAction);
}

export function isSignedAutomationTransaction(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

export type StaleAutomationTransactionReason = 'NONCE_CONSUMED' | 'MISSING_FROM_PENDING_POOL';

export function staleAutomationTransactionReason(input: {
  transactionNonce: bigint | null;
  latestNonce: bigint;
  pendingNonce: bigint;
  preparedAt: Date | null;
  now: Date;
  staleAfterMs: number;
}): StaleAutomationTransactionReason | null {
  if (input.transactionNonce === null) return null;
  if (input.latestNonce > input.transactionNonce) return 'NONCE_CONSUMED';
  if (!input.preparedAt || input.now.getTime() - input.preparedAt.getTime() < input.staleAfterMs) return null;
  return input.pendingNonce <= input.transactionNonce ? 'MISSING_FROM_PENDING_POOL' : null;
}

export function replacementFee(original: bigint | undefined, current: bigint) {
  if (original === undefined) return current;
  const bumped = original + (original / 8n) + 1n;
  return bumped > current ? bumped : current;
}

export function preparedTransactionMaxCost(gas: bigint, feePerGas: bigint, value = 0n) {
  return gas * feePerGas + value;
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
        and(eq(automationJobs.status, 'DEAD'), inArray(automationJobs.action, [...V2_JOB_ACTIONS])),
      ),
    )).orderBy(
      sql`case when ${automationJobs.status} = 'SUBMITTED' then 0 else 1 end`,
      asc(automationJobs.nextAttemptAt),
    ).limit(MAX_BATCH);

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
          and(eq(automationJobs.status, 'DEAD'), inArray(automationJobs.action, [...V2_JOB_ACTIONS])),
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

  private async cancelObsolete(job: typeof automationJobs.$inferSelect, reason: string) {
    await this.db.update(automationJobs).set({
      status: 'CANCELLED',
      lockedBy: null,
      lockedAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
      lastError: reason.slice(0, 2_000),
      signedTransaction: null,
    }).where(and(
      eq(automationJobs.id, job.id),
      eq(automationJobs.status, 'RUNNING'),
      eq(automationJobs.lockedBy, this.workerId),
    ));
    console.log(`V2 automation ${job.action}(${job.resourceId}) reconciled without a transaction: ${reason}`);
  }

  private async assertKeeperGasFunded(gas: bigint | undefined, feePerGas: bigint | undefined, value = 0n) {
    if (gas === undefined || feePerGas === undefined) throw new Error('Prepared keeper transaction is missing bounded gas fields');
    const [balance, pendingBalance] = await Promise.all([
      this.publicClient.getBalance({ address: this.account.address, blockTag: 'latest' }),
      this.publicClient.getBalance({ address: this.account.address, blockTag: 'pending' }),
    ]);
    const available = balance < pendingBalance ? balance : pendingBalance;
    const required = preparedTransactionMaxCost(gas, feePerGas, value);
    if (available < required) {
      throw new Error(`Keeper gas reserve insufficient: requires at most ${required} wei, available ${available} wei`);
    }
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
    // Every supported lifecycle transition is idempotent and is cancelled by
    // its terminal chain event. Oracle/RPC/compliance outages must therefore
    // never turn an overdue position into a permanently dead automation row.
    // Only malformed/unsupported jobs are allowed to exhaust into the DLQ.
    const durableLifecycle = isSupportedV2JobAction(job.action);
    const exhausted = !durableLifecycle && job.attempts >= job.maxAttempts;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await this.db.update(automationJobs).set({
      status: exhausted ? 'DEAD' : 'RETRY',
      nextAttemptAt: new Date(Date.now() + (durableLifecycle
        ? durableLifecycleRetryDelayMs(job.attempts)
        : automationRetryDelayMs(job.attempts))),
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

  private async reconcileRepoTerminalState(job: typeof automationJobs.$inferSelect) {
    if (job.action === 'finalizeOfferExpiry') {
      const offer = await this.publicClient.readContract({
        address: job.contractAddress as Address,
        abi: repoMarketV2Abi,
        functionName: 'getOffer',
        args: [BigInt(job.resourceId)],
      });
      if (offer.status !== OFFER_STATUS_OPEN && offer.status !== OFFER_STATUS_PARTIALLY_FILLED) {
        await this.cancelObsolete(job, `Offer is already terminal on-chain (status ${offer.status})`);
        return true;
      }
    }
    if (job.action === 'startAuction') {
      const position = await this.publicClient.readContract({
        address: job.contractAddress as Address,
        abi: repoMarketV2Abi,
        functionName: 'getPosition',
        args: [BigInt(job.resourceId)],
      });
      if (position.status !== POSITION_STATUS_ACTIVE) {
        await this.cancelObsolete(job, `Position is already terminal on-chain (status ${position.status})`);
        return true;
      }
    }
    return false;
  }

  private async simulateAndEncode(job: typeof automationJobs.$inferSelect) {
    const repoAction = ['finalizeOfferExpiry', 'startAuction', 'finalizeFailedAuction'].includes(job.action);
    if (repoAction) {
      const functionName = job.action as 'finalizeOfferExpiry' | 'startAuction' | 'finalizeFailedAuction';
      await this.publicClient.simulateContract({
        account: this.account,
        address: job.contractAddress as Address,
        abi: repoMarketV2Abi,
        functionName,
        args: [BigInt(job.resourceId)],
      });
      return encodeFunctionData({ abi: repoMarketV2Abi, functionName, args: [BigInt(job.resourceId)] });
    }
    const functionName = job.action as 'declarePaymentDefault' | 'startMarginLiquidation' | 'finalizeFailedMarginAuction' | 'startInKindOracleFallback' | 'materializeLiquidationClaim';
    await this.publicClient.simulateContract({
      account: this.account,
      address: job.contractAddress as Address,
      abi: marginEngineV2Abi,
      functionName,
      args: [BigInt(job.resourceId)],
    });
    return encodeFunctionData({ abi: marginEngineV2Abi, functionName, args: [BigInt(job.resourceId)] });
  }

  private async replaceStaleSubmitted(
    job: typeof automationJobs.$inferSelect,
    previousHash: Hex,
    reason: StaleAutomationTransactionReason,
  ) {
    if (!isSignedAutomationTransaction(job.signedTransaction) || job.transactionNonce === null) {
      await this.fail(job, new Error(`Cannot replace stale automation transaction: durable envelope is incomplete (${reason})`));
      return;
    }
    if (keccak256(job.signedTransaction).toLowerCase() !== previousHash.toLowerCase()) {
      await this.deferSubmitted(job.id, previousHash, 'Signed transaction hash mismatch; manual intervention required');
      return;
    }

    const parsed = parseTransaction(job.signedTransaction);
    const nonceValue = BigInt(job.transactionNonce);
    if (parsed.nonce === undefined || BigInt(parsed.nonce) !== nonceValue || nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      await this.deferSubmitted(job.id, previousHash, 'Signed transaction nonce mismatch; manual intervention required');
      return;
    }
    const data = await this.simulateAndEncode(job);
    if (
      parsed.to?.toLowerCase() !== job.contractAddress.toLowerCase()
      || parsed.data?.toLowerCase() !== data.toLowerCase()
      || (parsed.value ?? 0n) !== 0n
      || parsed.gas === undefined
    ) {
      await this.deferSubmitted(job.id, previousHash, 'Signed transaction does not match the immutable automation call; manual intervention required');
      return;
    }

    const nonce = Number(nonceValue);
    let signedTransaction: Hex;
    if (parsed.type === 'legacy') {
      const currentGasPrice = await this.publicClient.getGasPrice();
      const gasPrice = replacementFee(parsed.gasPrice, currentGasPrice);
      await this.assertKeeperGasFunded(parsed.gas, gasPrice);
      const prepared = await this.walletClient.prepareTransactionRequest({
        account: this.account,
        to: job.contractAddress as Address,
        data,
        value: 0n,
        nonce,
        gas: parsed.gas,
        gasPrice,
        type: 'legacy',
      });
      signedTransaction = await this.walletClient.signTransaction(prepared);
    } else if (parsed.type === 'eip1559') {
      const currentFees = await this.publicClient.estimateFeesPerGas({ type: 'eip1559' });
      const maxPriorityFeePerGas = replacementFee(parsed.maxPriorityFeePerGas, currentFees.maxPriorityFeePerGas);
      let maxFeePerGas = replacementFee(parsed.maxFeePerGas, currentFees.maxFeePerGas);
      if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
      await this.assertKeeperGasFunded(parsed.gas, maxFeePerGas);
      const prepared = await this.walletClient.prepareTransactionRequest({
        account: this.account,
        to: job.contractAddress as Address,
        data,
        value: 0n,
        nonce,
        gas: parsed.gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        type: 'eip1559',
      });
      signedTransaction = await this.walletClient.signTransaction(prepared);
    } else {
      await this.deferSubmitted(job.id, previousHash, `Unsupported signed transaction type ${parsed.type}; manual intervention required`);
      return;
    }

    const replacementHash = keccak256(signedTransaction);
    await this.markPrepared(job.id, replacementHash, signedTransaction, nonce);
    try {
      const broadcastHash = await this.publicClient.sendRawTransaction({ serializedTransaction: signedTransaction });
      if (broadcastHash.toLowerCase() !== replacementHash.toLowerCase()) {
        throw new Error(`RPC returned unexpected replacement transaction hash ${broadcastHash}`);
      }
      await this.markBroadcast(job.id, replacementHash);
      await this.deferSubmitted(job.id, replacementHash, `Replaced stale transaction ${previousHash} with the same nonce and call (${reason})`);
      console.log(`V2 automation ${job.action}(${job.resourceId}) replaced stale transaction ${previousHash} with ${replacementHash} (${reason}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deferSubmitted(job.id, replacementHash, `Replacement persisted; broadcast pending: ${message}`);
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
      // A signed outbox row is durable before first broadcast. Re-send the
      // exact bytes first; only a transaction proven stale by both age and the
      // account nonce views may be replaced with the same nonce and calldata.
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
      if (job.transactionNonce !== null) {
        try {
          const [latestNonce, pendingNonce] = await Promise.all([
            this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'latest' }),
            this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' }),
          ]);
          const staleReason = staleAutomationTransactionReason({
            transactionNonce: BigInt(job.transactionNonce),
            latestNonce: BigInt(latestNonce),
            pendingNonce: BigInt(pendingNonce),
            preparedAt: job.preparedAt,
            now: new Date(),
            staleAfterMs: this.config.V2_AUTOMATION_STALE_TX_MS,
          });
          if (staleReason === 'NONCE_CONSUMED') {
            await this.fail(job, new Error('Signed automation nonce was consumed without the expected receipt; re-simulating at the current nonce'));
            return;
          }
          if (staleReason === 'MISSING_FROM_PENDING_POOL') {
            await this.replaceStaleSubmitted(job, txHash, staleReason);
            return;
          }
        } catch (nonceError) {
          const detail = nonceError instanceof Error ? nonceError.message : String(nonceError);
          message = `${message}; nonce reconciliation unavailable: ${detail}`;
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
      if (await this.reconcileRepoTerminalState(job)) return;
      if (job.txHash) {
        await this.reconcileSubmitted(job, job.txHash as Hex);
        return;
      }
      const data = await this.simulateAndEncode(job);
      const prepared = await this.walletClient.prepareTransactionRequest({
        account: this.account,
        to: job.contractAddress as Address,
        data,
      });
      await this.assertKeeperGasFunded(
        prepared.gas,
        prepared.maxFeePerGas ?? prepared.gasPrice,
        prepared.value ?? 0n,
      );
      const signedTransaction = await this.walletClient.signTransaction(prepared);
      preparedHash = keccak256(signedTransaction);
      // Transaction bytes and their deterministic hash are committed before
      // any network broadcast. A crash on either side of sendRawTransaction is
      // recovered by exact rebroadcast, with bounded same-nonce replacement
      // only after the transaction is absent from the pending nonce view.
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
