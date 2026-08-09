import { z } from 'zod';
import { CLEANVERSE_UAT_BASE_URL, CONTRACTS, MONAD_TESTNET } from '@rwcar/shared';

const OptionalAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional();
const AttestationFlag = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const FeatureFlag = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  MONAD_RPC_URL: z.string().url().default(MONAD_TESTNET.rpcUrl),
  REPO_MARKET_ADDRESS: OptionalAddress,
  ASSET_REGISTRY_ADDRESS: OptionalAddress,
  REPO_MARKET_V2_ADDRESS: OptionalAddress,
  PROTOCOL_MODULE_FACTORY_V2_ADDRESS: OptionalAddress,
  COLLATERAL_VAULT_V2_ADDRESS: OptionalAddress,
  SETTLEMENT_ESCROW_V2_ADDRESS: OptionalAddress,
  DUTCH_AUCTION_V2_ADDRESS: OptionalAddress,
  MARGIN_ENGINE_V2_ADDRESS: OptionalAddress,
  VALUATION_ORACLE_V2_ADDRESS: OptionalAddress,
  RISK_MANAGER_V2_ADDRESS: OptionalAddress,
  FEE_TREASURY_ADDRESS: OptionalAddress,
  V2_SETTLEMENT_TOKEN_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default(CONTRACTS.aUsdc),
  V2_SETTLEMENT_TOKEN_CODE_HASH: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  AUSDC_CLEANVERSE_REQUEST_ID: z.string().min(1).optional(),
  V2_QUOTE_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  V2_ALLOWED_DURATIONS: z.string().default('300'),
  V2_MARGIN_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  V2_REPO_POLICY_POOL_REGISTERED: AttestationFlag,
  V2_FEE_TREASURY_AUSDC_ELIGIBLE: AttestationFlag,
  V2_SETTLEMENT_ESCROW_AUSDC_READY: AttestationFlag,
  V2_MARGIN_POLICY_POOL_REGISTERED: AttestationFlag,
  V2_MARGIN_VAULT_CUSTODY_READY: AttestationFlag,
  V2_MARGIN_ESCROW_AUSDC_READY: AttestationFlag,
  V2_MARGIN_TREASURY_AUSDC_ELIGIBLE: AttestationFlag,
  COMPLIANCE_VALIDATOR_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default(CONTRACTS.validator),
  CLEANVERSE_BASE_URL: z.string().url().default(CLEANVERSE_UAT_BASE_URL),
  CLEANVERSE_API_ID: z.string().min(1),
  CLEANVERSE_API_KEY: z.string().min(1),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  PRIVY_AGENT_SIGNER_ID: z.string().min(3).max(200).optional(),
  PRIVY_AGENT_POLICY_ID: z.string().min(3).max(200).optional(),
  PRIVY_JWT_VERIFICATION_KEY: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32).optional(),
  VALUATION_SIGNERS: z.string().default(''),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  COMPLIANCE_CACHE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_KMS_KEY_ID: z.string().optional(),
  AGENT_PLATFORM_ENABLED: FeatureFlag,
  AGENT_ISSUER_URL: z.string().url().default('http://127.0.0.1:3001'),
  // OAuth 2.0 Protected Resource Metadata and MCP both require tokens to be
  // audience-bound to the canonical resource URI, not to an arbitrary label.
  AGENT_AUDIENCE: z.string().url().default('http://127.0.0.1:3001/mcp'),
  AGENT_JWT_PRIVATE_JWK: z.string().min(20).optional(),
  AGENT_JWT_KEY_ID: z.string().min(3).max(100).default('rwcar-agent-es256-v1'),
  AGENT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  AGENT_CREDENTIAL_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  AGENT_INTENT_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  AGENT_EXECUTOR_LEASE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(1_800).default(600),
  AGENT_EXECUTOR_API_KEY: z.string().min(32).optional(),
  AGENT_MCP_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
  AGENT_ALLOWED_MANIFEST_HASHES: z.string().default(''),
  AGENT_UAT_SYNTHETIC_CVI_ENABLED: FeatureFlag,
}).superRefine((value, context) => {
  if (!value.AGENT_PLATFORM_ENABLED) return;
  if (!value.AGENT_JWT_PRIVATE_JWK) {
    context.addIssue({ code: 'custom', path: ['AGENT_JWT_PRIVATE_JWK'], message: 'Required when agent platform is enabled' });
  } else {
    try {
      const jwk = JSON.parse(value.AGENT_JWT_PRIVATE_JWK) as Record<string, unknown>;
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw new Error('invalid');
    } catch {
      context.addIssue({ code: 'custom', path: ['AGENT_JWT_PRIVATE_JWK'], message: 'Must be a private P-256 JWK JSON object' });
    }
  }
  if (!value.AGENT_EXECUTOR_API_KEY) {
    context.addIssue({ code: 'custom', path: ['AGENT_EXECUTOR_API_KEY'], message: 'Required when agent platform is enabled' });
  }
  if (!value.PRIVY_AGENT_SIGNER_ID) {
    context.addIssue({ code: 'custom', path: ['PRIVY_AGENT_SIGNER_ID'], message: 'Required when agent platform is enabled' });
  }
  if (!value.PRIVY_AGENT_POLICY_ID) {
    context.addIssue({ code: 'custom', path: ['PRIVY_AGENT_POLICY_ID'], message: 'Required when agent platform is enabled' });
  }
  const manifestHashes = value.AGENT_ALLOWED_MANIFEST_HASHES.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (manifestHashes.length === 0 || manifestHashes.some((entry) => !/^0x[a-fA-F0-9]{64}$/.test(entry))) {
    context.addIssue({
      code: 'custom',
      path: ['AGENT_ALLOWED_MANIFEST_HASHES'],
      message: 'At least one comma-separated bytes32 skill manifest hash is required when agent platform is enabled',
    });
  }
  if (value.AGENT_UAT_SYNTHETIC_CVI_ENABLED && !new URL(value.CLEANVERSE_BASE_URL).hostname.toLowerCase().includes('uat')) {
    context.addIssue({ code: 'custom', path: ['AGENT_UAT_SYNTHETIC_CVI_ENABLED'], message: 'Synthetic CVI enrollment is permitted only against Cleanverse UAT' });
  }
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): ApiConfig {
  const normalized = input.API_PORT === undefined && input.PORT !== undefined
    ? { ...input, API_PORT: input.PORT }
    : input;
  return ConfigSchema.parse(normalized);
}
