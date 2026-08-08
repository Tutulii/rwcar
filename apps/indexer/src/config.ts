import { MONAD_TESTNET } from '@rwcar/shared';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MONAD_RPC_URL: z.string().url().default(MONAD_TESTNET.rpcUrl),
  REPO_MARKET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  REPO_MARKET_DEPLOYMENT_BLOCK: z.coerce.bigint().nonnegative(),
  V1_INDEXER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  V1_KEEPER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  INDEXER_CONFIRMATIONS: z.coerce.bigint().min(1n).default(3n),
  // The public Monad endpoint is limited to 100 blocks; authenticated providers
  // may support larger ranges. Keep the safe default while allowing a bounded
  // operator override for a provider whose limit has been verified.
  INDEXER_BATCH_SIZE: z.coerce.bigint().min(1n).max(1_000n).default(100n),
  INDEXER_POLL_MS: z.coerce.number().int().min(1_000).default(5_000),
  INDEXER_CATCHUP_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(100),
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  KEEPER_POLL_MS: z.coerce.number().int().min(5_000).default(10_000),
  V2_AUTOMATION_MAX_CHECKPOINT_LAG: z.coerce.bigint().min(0n).max(1_000n).default(100n),
  V2_DEPLOYMENTS_JSON: z.string().default('[]'),
  V2_SETTLEMENT_TOKEN_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  V2_ORACLE_HEARTBEAT_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  V2_ORACLE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(300_000).max(3_600_000).default(600_000),
  V2_ORACLE_HEARTBEAT_VALIDITY_SECONDS: z.coerce.number().int().min(3_600).max(604_800).default(86_400),
  V2_ORACLE_HEARTBEAT_PRICE_E18: z.string().regex(/^\d+$/).refine((value) => BigInt(value) > 0n).optional(),
  V2_ORACLE_HEARTBEAT_EVIDENCE_HASH: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  V2_ORACLE_SIGNER_1_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  V2_ORACLE_SIGNER_2_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
}).superRefine((value, context) => {
  if (!value.V2_ORACLE_HEARTBEAT_ENABLED) return;
  const required = [
    ['V2_SETTLEMENT_TOKEN_ADDRESS', value.V2_SETTLEMENT_TOKEN_ADDRESS],
    ['V2_ORACLE_HEARTBEAT_PRICE_E18', value.V2_ORACLE_HEARTBEAT_PRICE_E18],
    ['V2_ORACLE_HEARTBEAT_EVIDENCE_HASH', value.V2_ORACLE_HEARTBEAT_EVIDENCE_HASH],
    ['V2_ORACLE_SIGNER_1_PRIVATE_KEY', value.V2_ORACLE_SIGNER_1_PRIVATE_KEY],
    ['V2_ORACLE_SIGNER_2_PRIVATE_KEY', value.V2_ORACLE_SIGNER_2_PRIVATE_KEY],
  ] as const;
  for (const [name, configured] of required) {
    if (configured) continue;
    context.addIssue({ code: 'custom', path: [name], message: `${name} is required when the oracle heartbeat is enabled` });
  }
  if (
    value.V2_ORACLE_SIGNER_1_PRIVATE_KEY
      && value.V2_ORACLE_SIGNER_2_PRIVATE_KEY
      && value.V2_ORACLE_SIGNER_1_PRIVATE_KEY.toLowerCase() === value.V2_ORACLE_SIGNER_2_PRIVATE_KEY.toLowerCase()
  ) {
    context.addIssue({
      code: 'custom',
      path: ['V2_ORACLE_SIGNER_2_PRIVATE_KEY'],
      message: 'Oracle heartbeat signers must use distinct private keys',
    });
  }
  if (value.V2_ORACLE_HEARTBEAT_VALIDITY_SECONDS * 1_000 <= value.V2_ORACLE_HEARTBEAT_INTERVAL_MS) {
    context.addIssue({
      code: 'custom',
      path: ['V2_ORACLE_HEARTBEAT_VALIDITY_SECONDS'],
      message: 'Oracle heartbeat validity must exceed its publication interval',
    });
  }
});

export type IndexerConfig = z.infer<typeof schema>;
export const loadConfig = (input: NodeJS.ProcessEnv = process.env) => schema.parse(input);

const deploymentSchema = z.object({
  module: z.enum(['REPO_MARKET', 'COLLATERAL_VAULT', 'SETTLEMENT_ESCROW', 'VALUATION_ORACLE', 'RISK_MANAGER', 'DUTCH_AUCTION', 'MARGIN_ENGINE']),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).transform((value) => value.toLowerCase()),
  deploymentBlock: z.coerce.bigint().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type V2DeploymentSource = z.infer<typeof deploymentSchema>;

export function parseV2DeploymentSources(config: IndexerConfig): V2DeploymentSource[] {
  let parsed: unknown;
  try { parsed = JSON.parse(config.V2_DEPLOYMENTS_JSON); } catch { throw new Error('V2_DEPLOYMENTS_JSON must be valid JSON'); }
  const sources = z.array(deploymentSchema).parse(parsed);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.address)) throw new Error(`Duplicate V2 deployment address: ${source.address}`);
    seen.add(source.address);
    if (['COLLATERAL_VAULT', 'SETTLEMENT_ESCROW', 'DUTCH_AUCTION'].includes(source.module)) {
      const controller = source.metadata.controllerAddress;
      if (typeof controller !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(controller)) {
        throw new Error(`${source.module} ${source.address} requires metadata.controllerAddress`);
      }
      source.metadata.controllerAddress = controller.toLowerCase();
    }
  }
  const repoMarkets = sources.filter((source) => source.module === 'REPO_MARKET');
  const marginEngines = sources.filter((source) => source.module === 'MARGIN_ENGINE');
  if (sources.length > 0 && repoMarkets.length !== 1) {
    throw new Error('V2 deployment sources require exactly one REPO_MARKET module');
  }
  if (marginEngines.length > 1) throw new Error('V2 deployment sources support at most one MARGIN_ENGINE module');

  const controllerModules = new Map(
    [...repoMarkets, ...marginEngines].map((source) => [source.address, source.module] as const),
  );
  for (const source of sources) {
    if (!['COLLATERAL_VAULT', 'SETTLEMENT_ESCROW', 'DUTCH_AUCTION'].includes(source.module)) continue;
    const controller = String(source.metadata.controllerAddress);
    if (!controllerModules.has(controller)) {
      throw new Error(`${source.module} ${source.address} controller ${controller} is not a configured REPO_MARKET or MARGIN_ENGINE`);
    }
  }

  // Cross-contract projections depend on controller events already existing. Always
  // process both controllers before their child Vault/Escrow/Auction logs, regardless
  // of how an operator ordered the JSON manifest.
  const rank = (source: V2DeploymentSource) => (
    source.module === 'REPO_MARKET' || source.module === 'MARGIN_ENGINE' ? 0
      : ['VALUATION_ORACLE', 'RISK_MANAGER'].includes(source.module) ? 1
        : 2
  );
  return sources
    .map((source, index) => ({ source, index }))
    .sort((left, right) => rank(left.source) - rank(right.source) || left.index - right.index)
    .map(({ source }) => source);
}
