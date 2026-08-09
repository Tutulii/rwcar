import { randomUUID } from 'node:crypto';
import { MONAD_TESTNET } from '@rwcar/shared';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  AGENT_API_BASE_URL: z.string().url(),
  AGENT_EXECUTOR_API_KEY: z.string().min(32),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  PRIVY_AGENT_SIGNER_ID: z.string().min(3).max(200),
  PRIVY_AGENT_POLICY_ID: z.string().min(3).max(200),
  PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS: z.string().transform((value, context) => {
    try {
      const keys = JSON.parse(value) as unknown;
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === 'string' && key.length >= 32)) throw new Error('invalid');
      return keys as string[];
    } catch {
      context.addIssue({ code: 'custom', message: 'Must be a non-empty JSON array of Privy authorization private keys' });
      return z.NEVER;
    }
  }),
  MONAD_RPC_URL: z.string().url().default(MONAD_TESTNET.rpcUrl),
  EXECUTOR_WORKER_ID: z.string().min(3).max(100).default(`agent-executor-${randomUUID()}`),
  EXECUTOR_POLL_MS: z.coerce.number().int().min(500).max(30_000).default(2_000),
  EXECUTOR_RECEIPT_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(600_000).default(180_000),
  EXECUTOR_INDEX_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(900_000).default(300_000),
});

export type ExecutorConfig = z.infer<typeof schema>;
export const loadConfig = (input: NodeJS.ProcessEnv = process.env) => schema.parse(input);
