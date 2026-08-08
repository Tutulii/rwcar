import { execFileSync, spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const service = process.argv[2];
if (!['api', 'indexer', 'web', 'build', 'stack'].includes(service)) {
  throw new Error('Usage: node scripts/local-v2-service.mjs <api|indexer|web|build|stack>');
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
const rpcSecretPath = join(repositoryRoot, '.secrets', 'monad-rpc.json');
const rpcSecret = existsSync(rpcSecretPath) ? JSON.parse(readFileSync(rpcSecretPath, 'utf8')) : {};
if (existsSync(rpcSecretPath)) {
  if ((statSync(rpcSecretPath).mode & 0o077) !== 0) throw new Error('Monad RPC credential permissions must be 0600');
  if (typeof rpcSecret.rpcUrl !== 'string' || new URL(rpcSecret.rpcUrl).protocol !== 'https:') {
    throw new Error('Monad RPC credential must contain an HTTPS rpcUrl');
  }
  if (!Number.isInteger(rpcSecret.maxLogRange) || rpcSecret.maxLogRange < 1 || rpcSecret.maxLogRange > 1_000) {
    throw new Error('Monad RPC maxLogRange must be an integer from 1 to 1000');
  }
}
const databaseUrl = process.env.DATABASE_URL?.trim() || 'postgresql://rwcar@127.0.0.1:5432/rwcar';
const common = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  MONAD_RPC_URL: process.env.MONAD_RPC_URL?.trim() || rpcSecret.rpcUrl || 'https://testnet-rpc.monad.xyz',
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
  V2_MARGIN_ENABLED: String(deployment.serviceConfiguration.V2_MARGIN_ENABLED === true),
  V2_REPO_POLICY_POOL_REGISTERED: 'true',
  V2_FEE_TREASURY_AUSDC_ELIGIBLE: 'true',
  V2_SETTLEMENT_ESCROW_AUSDC_READY: 'true',
  V2_MARGIN_POLICY_POOL_REGISTERED: String(deployment.serviceConfiguration.V2_MARGIN_POLICY_POOL_REGISTERED === true),
  V2_MARGIN_VAULT_CUSTODY_READY: String(deployment.serviceConfiguration.V2_MARGIN_VAULT_CUSTODY_READY === true),
  V2_MARGIN_ESCROW_AUSDC_READY: String(deployment.serviceConfiguration.V2_MARGIN_ESCROW_AUSDC_READY === true),
  V2_MARGIN_TREASURY_AUSDC_ELIGIBLE: String(deployment.serviceConfiguration.V2_MARGIN_TREASURY_AUSDC_ELIGIBLE === true),
  CLEANVERSE_BASE_URL: cleanverse.baseUrl,
  CLEANVERSE_API_ID: cleanverse.apiId,
  CLEANVERSE_API_KEY: cleanverse.apiKey,
  INDEXER_CONFIRMATIONS: '3',
  INDEXER_BATCH_SIZE: String(rpcSecret.maxLogRange || 100),
  INDEXER_POLL_MS: '5000',
  INDEXER_CATCHUP_DELAY_MS: '250',
  V2_AUTOMATION_MAX_CHECKPOINT_LAG: '100',
  V1_INDEXER_ENABLED: 'false',
  V1_KEEPER_ENABLED: 'false',
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

const environmentFor = async (target) => {
  const environment = { ...common };
  if (target === 'api') {
    const privySecretPath = join(repositoryRoot, '.secrets', 'privy-uat.json');
    const privySecret = existsSync(privySecretPath) ? JSON.parse(readFileSync(privySecretPath, 'utf8')) : {};
    environment.PRIVY_APP_ID = process.env.PRIVY_APP_ID?.trim()
      || privySecret.appId
      || rootEnv.VITE_PRIVY_APP_ID;
    environment.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET?.trim()
      || privySecret.appSecret
      || await promptSecret();
    environment.API_HOST = '127.0.0.1';
    environment.API_PORT = '3001';
    environment.CORS_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173';
  } else if (target === 'indexer') {
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
    environment.KEEPER_PRIVATE_KEY = roleBundle.privateKeys.keeper;
  } else if (target === 'web') {
    const trustedManifest = { ...deployment.frontendTrustedManifestDraft, status: 'ACTIVE' };
    environment.VITE_PRIVY_APP_ID = rootEnv.VITE_PRIVY_APP_ID;
    environment.VITE_API_URL = 'http://127.0.0.1:3001';
    environment.VITE_TRUSTED_V2_MANIFEST_JSON = JSON.stringify(trustedManifest);
    environment.WEB_ROOT = join(repositoryRoot, 'dist');
    environment.WEB_HOST = '0.0.0.0';
    environment.WEB_PORT = '5173';
  } else throw new Error(`Unknown local service: ${target}`);
  return environment;
};

if (service === 'build') {
  const buildEnvironment = { ...common, NODE_ENV: 'production' };
  for (const workspace of ['@rwcar/shared', '@rwcar/db', '@rwcar/api', '@rwcar/indexer']) {
    execFileSync('npm', ['run', 'build', '-w', workspace], { cwd: repositoryRoot, env: buildEnvironment, stdio: 'inherit' });
  }
  execFileSync('npm', ['run', 'build:web'], {
    cwd: repositoryRoot,
    env: { ...await environmentFor('web'), NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  console.log('Lightweight V2 local build complete.');
  process.exit(0);
}

if (service === 'stack') {
  const definitions = [
    { target: 'api', script: join(repositoryRoot, 'apps/api/dist/server.js') },
    { target: 'indexer', script: join(repositoryRoot, 'apps/indexer/dist/index.js') },
    { target: 'web', script: join(repositoryRoot, 'scripts/serve-static.mjs') },
  ];
  for (const definition of definitions) {
    if (!existsSync(definition.script)) throw new Error(`Missing ${definition.script}; run npm run build:v2:local`);
  }
  const children = [];
  for (const definition of definitions) {
    const child = spawn(process.execPath, [definition.script], {
      cwd: repositoryRoot,
      env: { ...await environmentFor(definition.target), NODE_ENV: 'production' },
      stdio: 'inherit',
    });
    children.push({ ...definition, child });
  }
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    for (const { child } of children) child.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
  const exits = children.map(({ target, child }) => once(child, 'exit').then(([code, signal]) => ({ target, code, signal })));
  const first = await Promise.race(exits);
  const unexpected = !stopping;
  if (unexpected) {
    console.error(`${first.target} exited unexpectedly (code=${first.code}, signal=${first.signal ?? 'none'}); stopping local stack.`);
    stop('SIGTERM');
  }
  await Promise.allSettled(exits);
  process.exitCode = unexpected ? (first.code || 1) : 0;
} else {
  const commands = {
    api: ['npm', ['run', 'dev:api']],
    indexer: ['npm', ['run', 'dev:indexer']],
    web: ['npm', ['run', 'dev']],
  };
  const [command, args] = commands[service];
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: await environmentFor(service),
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const [code, signal] = await once(child, 'exit');
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
}
