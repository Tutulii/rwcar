import { execFileSync, spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const service = process.argv[2];
if (!['api', 'indexer', 'web'].includes(service)) {
  throw new Error('Usage: node scripts/local-v2-service.mjs <api|indexer|web>');
}

const parseEnv = (path) => Object.fromEntries(readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

const deployment = JSON.parse(readFileSync(
  join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.json'),
  'utf8',
));
const v1 = JSON.parse(readFileSync(join(repositoryRoot, 'deployments', 'monad-testnet.json'), 'utf8'));
const smokeWindow = JSON.parse(readFileSync(
  join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.smoke-window.json'),
  'utf8',
));
if (deployment.deploymentProfile !== 'MONAD_HACKATHON_UAT_ZERO_DELAY') {
  throw new Error('Unexpected V2 deployment profile');
}
if (smokeWindow.status !== 'ISOLATED_SMOKE_WINDOW_OPEN') {
  throw new Error('The isolated V2 smoke window is not open');
}

const rootEnv = existsSync(join(repositoryRoot, '.env')) ? parseEnv(join(repositoryRoot, '.env')) : {};
const cleanverse = JSON.parse(readFileSync(join(repositoryRoot, '.secrets', 'cleanverse-uat.json'), 'utf8'));
const databaseUrl = process.env.DATABASE_URL?.trim() || 'postgresql://rwcar@127.0.0.1:5432/rwcar';
const common = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  MONAD_RPC_URL: process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz',
  REPO_MARKET_ADDRESS: v1.repoMarket,
  REPO_MARKET_DEPLOYMENT_BLOCK: String(v1.deploymentBlock),
  ASSET_REGISTRY_ADDRESS: deployment.contracts.assetRegistry,
  REPO_MARKET_V2_ADDRESS: deployment.contracts.repoMarket,
  PROTOCOL_MODULE_FACTORY_V2_ADDRESS: deployment.contracts.moduleFactory,
  COLLATERAL_VAULT_V2_ADDRESS: deployment.contracts.marketVault,
  SETTLEMENT_ESCROW_V2_ADDRESS: deployment.contracts.marketSettlementEscrow,
  DUTCH_AUCTION_V2_ADDRESS: deployment.contracts.marketAuction,
  MARGIN_ENGINE_V2_ADDRESS: deployment.contracts.marginEngine,
  VALUATION_ORACLE_V2_ADDRESS: deployment.contracts.valuationOracle,
  RISK_MANAGER_V2_ADDRESS: deployment.contracts.riskManager,
  FEE_TREASURY_ADDRESS: deployment.roles.feeTreasury,
  V2_SETTLEMENT_TOKEN_ADDRESS: deployment.externalContracts.settlementToken,
  COMPLIANCE_VALIDATOR_ADDRESS: deployment.externalContracts.complianceValidator,
  V2_ALLOWED_DURATIONS: deployment.parameters.allowedDurations.join(','),
  V2_DEPLOYMENTS_JSON: JSON.stringify(deployment.indexerSources),
  V2_MARGIN_ENABLED: 'false',
  V2_REPO_POLICY_POOL_REGISTERED: 'true',
  V2_FEE_TREASURY_AUSDC_ELIGIBLE: 'true',
  V2_SETTLEMENT_ESCROW_AUSDC_READY: 'true',
  V2_MARGIN_POLICY_POOL_REGISTERED: 'false',
  V2_MARGIN_VAULT_CUSTODY_READY: 'false',
  V2_MARGIN_ESCROW_AUSDC_READY: 'false',
  V2_MARGIN_TREASURY_AUSDC_ELIGIBLE: 'false',
  CLEANVERSE_BASE_URL: cleanverse.baseUrl,
  CLEANVERSE_API_ID: cleanverse.apiId,
  CLEANVERSE_API_KEY: cleanverse.apiKey,
  INDEXER_CONFIRMATIONS: '3',
  INDEXER_BATCH_SIZE: '100',
  INDEXER_POLL_MS: '5000',
};

const promptSecret = async () => {
  if (!process.stdin.isTTY) {
    throw new Error('PRIVY_APP_SECRET is required; run the API command in a terminal');
  }
  execFileSync('stty', ['-echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const secret = (await reader.question('Privy UAT app secret (input hidden): ')).trim();
    process.stdout.write('\n');
    if (!secret) throw new Error('Privy UAT app secret is required');
    return secret;
  } finally {
    reader.close();
    execFileSync('stty', ['echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
  }
};

let command;
let args;
if (service === 'api') {
  common.PRIVY_APP_ID = process.env.PRIVY_APP_ID?.trim() || rootEnv.VITE_PRIVY_APP_ID;
  common.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET?.trim() || await promptSecret();
  common.API_HOST = '127.0.0.1';
  common.API_PORT = '3001';
  common.CORS_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173';
  command = 'npm';
  args = ['run', 'dev:api'];
} else if (service === 'indexer') {
  const encryptedBundle = JSON.parse(readFileSync(join(repositoryRoot, '.secrets', 'v2-uat-roles.enc.json'), 'utf8'));
  const wrappingKey = Buffer.from(
    readFileSync(join(repositoryRoot, '.secrets', 'v2-uat-roles.key'), 'utf8').trim(),
    'base64',
  );
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
  const roleBundle = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
  if (!roleBundle.privateKeys.keeper) throw new Error('The permissionless UAT keeper has not been created');
  common.KEEPER_PRIVATE_KEY = roleBundle.privateKeys.keeper;
  command = 'npm';
  args = ['run', 'dev:indexer'];
} else {
  const trustedManifest = { ...deployment.frontendTrustedManifestDraft, status: 'ACTIVE' };
  common.VITE_PRIVY_APP_ID = rootEnv.VITE_PRIVY_APP_ID;
  common.VITE_API_URL = 'http://127.0.0.1:3001';
  common.VITE_TRUSTED_V2_MANIFEST_JSON = JSON.stringify(trustedManifest);
  command = 'npm';
  args = ['run', 'dev'];
}

const child = spawn(command, args, {
  cwd: repositoryRoot,
  env: common,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
const [code, signal] = await once(child, 'exit');
if (signal) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
