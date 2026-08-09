import { APIError as PrivyApiError, PrivyClient } from '@privy-io/node';
import { createPublicClient, defineChain, http, type Hash } from 'viem';
import type { ExecutorConfig } from './config.js';
import { ExecutorApi, ExecutorApiError, type ExecutorLease, type ExecutorStep } from './api.js';
import { decimalToRpcQuantity } from './rpc.js';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class RetryableExecutionError extends Error {}
class DefinitiveExecutionError extends Error {}

function isDefinitivePrivyError(error: unknown) {
  return error instanceof PrivyApiError
    && typeof error.status === 'number'
    && error.status >= 400
    && error.status < 500
    && error.status !== 429;
}

function log(level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown> = {}) {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...details }));
}

export class AgentExecutor {
  private readonly api: ExecutorApi;
  private readonly privy: PrivyClient;
  private readonly chain;
  private stopping = false;

  constructor(private readonly config: ExecutorConfig) {
    this.api = new ExecutorApi(config);
    this.privy = new PrivyClient({ appId: config.PRIVY_APP_ID, appSecret: config.PRIVY_APP_SECRET });
    this.chain = createPublicClient({
      chain: defineChain({
        id: 10_143,
        name: 'Monad Testnet',
        nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
        rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
      }),
      transport: http(config.MONAD_RPC_URL, { retryCount: 3, timeout: 20_000 }),
    });
  }

  stop() {
    this.stopping = true;
  }

  async run() {
    log('info', 'Agent executor started', { workerId: this.config.EXECUTOR_WORKER_ID, chainId: 10_143 });
    while (!this.stopping) {
      try {
        const lease = await this.api.lease();
        if (!lease) {
          await sleep(this.config.EXECUTOR_POLL_MS);
          continue;
        }
        await this.execute(lease);
      } catch (error) {
        log('error', 'Executor loop error', { error: error instanceof Error ? error.message : 'Unknown error' });
        await sleep(Math.max(this.config.EXECUTOR_POLL_MS, 2_000));
      }
    }
    log('info', 'Agent executor stopped', { workerId: this.config.EXECUTOR_WORKER_ID });
  }

  private async execute(lease: ExecutorLease) {
    const intentId = lease.intent.id;
    log('info', 'Intent leased', { intentId, stepCount: lease.steps.length });
    for (const step of lease.steps) {
      if (step.status === 'CONFIRMED' || step.status === 'SKIPPED') continue;
      try {
        if (!step.txHash) {
          try {
            await this.api.refresh(intentId);
          } catch (error) {
            if (error instanceof ExecutorApiError && error.status < 500) {
              throw new DefinitiveExecutionError(`Fresh execution authorization was rejected: ${error.message}`);
            }
            throw new RetryableExecutionError(`Fresh execution authorization is temporarily unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        }
        await this.executeStep(lease, step);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown transaction failure';
        if (error instanceof RetryableExecutionError) {
          // The transaction outcome may be unknown. Leave the durable lease to
          // expire and recover with the same Privy idempotency key.
          log('warn', 'Intent step outcome is ambiguous; deferring to idempotent recovery', { intentId, stepIndex: step.stepIndex, error: message });
          return;
        }
        await this.api.report(intentId, step.stepIndex, { status: 'FAILED', errorMessage: message }).catch(() => undefined);
        log('error', 'Intent step failed definitively', { intentId, stepIndex: step.stepIndex, error: message });
        return;
      }
    }

    const deadline = Date.now() + this.config.EXECUTOR_INDEX_TIMEOUT_MS;
    while (!this.stopping && Date.now() < deadline) {
      const completion = await this.api.complete(intentId) as { complete?: unknown; state?: unknown };
      if (completion.complete === true) {
        log('info', 'Intent completed', { intentId });
        return;
      }
      await sleep(5_000);
    }
    log('warn', 'Intent remains in indexing state and will be reclaimed safely', { intentId });
  }

  private async executeStep(lease: ExecutorLease, step: ExecutorStep) {
    let txHash = step.txHash as Hash | null;
    let privyActionId = step.privyActionId ?? undefined;
    if (!txHash) {
      try {
        // Record the external-side-effect boundary before contacting Privy.
        // A crash after this marker is recovered only with the same provider
        // idempotency key, or surfaced as an ambiguous signing incident.
        await this.api.report(lease.intent.id, step.stepIndex, { status: 'SIGNING' });
      } catch (error) {
        if (error instanceof ExecutorApiError && error.status < 500) {
          throw new DefinitiveExecutionError(`Signing authorization was rejected: ${error.message}`);
        }
        throw new RetryableExecutionError(`Signing authorization could not be recorded: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      if (lease.agent.signerId !== this.config.PRIVY_AGENT_SIGNER_ID || lease.agent.policyId !== this.config.PRIVY_AGENT_POLICY_ID) {
        throw new DefinitiveExecutionError('Executor refused an unrecognized Privy signer or policy');
      }
      let wallet;
      try {
        wallet = await this.privy.wallets().get(lease.agent.privyWalletId);
      } catch (error) {
        if (isDefinitivePrivyError(error)) {
          throw new DefinitiveExecutionError(`Privy wallet authorization is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        throw new RetryableExecutionError(`Privy wallet authorization could not be refreshed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      const signer = wallet.additional_signers.find((candidate) => candidate.signer_id === this.config.PRIVY_AGENT_SIGNER_ID);
      const signerPolicies = signer?.override_policy_ids ?? wallet.policy_ids;
      if (wallet.chain_type !== 'ethereum'
        || wallet.address.toLowerCase() !== lease.agent.walletAddress.toLowerCase()
        || !signer
        || !signerPolicies.includes(this.config.PRIVY_AGENT_POLICY_ID)
        || wallet.exported_at !== null
        || wallet.imported_at !== null) {
        throw new DefinitiveExecutionError('Privy wallet identity, isolation, signer, or policy no longer matches the reviewed binding');
      }
      let response;
      try {
        response = await this.privy.wallets().ethereum().sendTransaction(lease.agent.privyWalletId, {
          caip2: 'eip155:10143',
          params: {
            transaction: {
              from: lease.agent.walletAddress,
              to: step.destination,
              data: step.calldata,
              value: decimalToRpcQuantity(step.nativeValue),
              chain_id: 10_143,
            },
          },
          authorization_context: {
            authorization_private_keys: this.config.PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS,
          },
          idempotency_key: `${lease.intent.id}:${step.stepIndex}`,
        });
      } catch (error) {
        if (isDefinitivePrivyError(error)) {
          throw new DefinitiveExecutionError(`Privy rejected the reviewed transaction: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        throw new RetryableExecutionError(`Privy submission did not return a final outcome: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      txHash = response.hash as Hash;
      privyActionId = response.transaction_id;
      try {
        await this.api.report(lease.intent.id, step.stepIndex, {
          status: 'SUBMITTED',
          txHash,
          ...(privyActionId ? { privyActionId } : {}),
        });
      } catch (error) {
        throw new RetryableExecutionError(`Transaction ${txHash} was returned by Privy but durable submission recording failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      log('info', 'Intent step submitted', { intentId: lease.intent.id, stepIndex: step.stepIndex, txHash, kind: step.kind });
    }

    let receipt;
    try {
      receipt = await this.chain.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: this.config.EXECUTOR_RECEIPT_TIMEOUT_MS,
        pollingInterval: 1_000,
      });
    } catch (error) {
      throw new RetryableExecutionError(`Receipt for ${txHash} is not final: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (receipt.status !== 'success') throw new DefinitiveExecutionError(`Monad transaction ${txHash} reverted`);
    try {
      await this.api.report(lease.intent.id, step.stepIndex, {
        status: 'CONFIRMED',
        txHash,
        ...(privyActionId ? { privyActionId } : {}),
      });
    } catch (error) {
      throw new RetryableExecutionError(`Confirmed transaction ${txHash} could not be reconciled: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    log('info', 'Intent step confirmed', { intentId: lease.intent.id, stepIndex: step.stepIndex, txHash, blockNumber: receipt.blockNumber.toString() });
  }
}
