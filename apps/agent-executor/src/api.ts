import { z } from 'zod';
import type { ExecutorConfig } from './config.js';

const StepSchema = z.object({
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  kind: z.string(),
  destination: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  calldata: z.string().regex(/^0x[a-fA-F0-9]*$/),
  nativeValue: z.string().regex(/^\d+$/),
  description: z.string(),
  status: z.enum(['PENDING', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED']),
  privyActionId: z.string().nullable(),
  txHash: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const LeaseSchema = z.object({
  intent: z.object({ id: z.string().uuid(), intentHash: z.string(), state: z.string() }),
  agent: z.object({
    walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    privyWalletId: z.string().min(1),
    signerId: z.string().min(1),
    policyId: z.string().min(1),
  }),
  steps: z.array(StepSchema),
});

export type ExecutorLease = z.infer<typeof LeaseSchema>;
export type ExecutorStep = z.infer<typeof StepSchema>;

export class ExecutorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export class ExecutorApi {
  constructor(private readonly config: ExecutorConfig) {}

  private async request(path: string, body: Record<string, unknown>) {
    const response = await fetch(new URL(path, this.config.AGENT_API_BASE_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-executor-key': this.config.AGENT_EXECUTOR_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const code = typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`;
      const message = typeof payload?.message === 'string' ? payload.message : 'Executor API request failed';
      throw new ExecutorApiError(response.status, code, message);
    }
    return payload;
  }

  async lease() {
    const payload = await this.request('/internal/agent-executor/lease', { workerId: this.config.EXECUTOR_WORKER_ID });
    if (payload === null) return null;
    return LeaseSchema.parse(payload);
  }

  async refresh(intentId: string) {
    return this.request(`/internal/agent-executor/intents/${intentId}/refresh`, { workerId: this.config.EXECUTOR_WORKER_ID });
  }

  async report(intentId: string, stepIndex: number, body: {
    status: 'SIGNING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
    txHash?: string;
    privyActionId?: string;
    errorMessage?: string;
  }) {
    return this.request(`/internal/agent-executor/intents/${intentId}/steps/${stepIndex}`, {
      workerId: this.config.EXECUTOR_WORKER_ID,
      ...body,
    });
  }

  async complete(intentId: string) {
    return this.request(`/internal/agent-executor/intents/${intentId}/complete`, { workerId: this.config.EXECUTOR_WORKER_ID });
  }
}
