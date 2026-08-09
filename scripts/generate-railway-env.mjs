import { createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const secretsDirectory = join(root, '.secrets');
const secretPath = (name) => join(secretsDirectory, name);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function requirePrivate(path) {
  if (!existsSync(path)) throw new Error(`Required protected file is missing: ${path}`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`Protected file must have mode 0600: ${path}`);
  return path;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (/\r|\n|\0/.test(value)) throw new Error(`${label} contains an invalid control character`);
  return value.trim();
}

function writeEnvironment(name, values) {
  const path = secretPath(name);
  const entries = Object.entries(values).map(([key, raw]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    return `${key}=${requiredString(String(raw), key)}`;
  });
  writeFileSync(path, `${entries.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, count: entries.length };
}

function decryptRoleBundle() {
  const encrypted = readJson(requirePrivate(secretPath('v2-uat-roles.enc.json')));
  const wrappingKey = Buffer.from(readFileSync(requirePrivate(secretPath('v2-uat-roles.key')), 'utf8').trim(), 'base64');
  if (wrappingKey.length !== 32) throw new Error('V2 role wrapping key must decode to 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

function adminKey() {
  const path = secretPath('railway-admin.json');
  if (existsSync(path)) return requiredString(readJson(requirePrivate(path)).adminApiKey, 'adminApiKey');
  const value = randomBytes(32).toString('base64url');
  writeFileSync(path, `${JSON.stringify({ adminApiKey: value }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
const deployment = readJson(join(root, 'deployments', 'monad-testnet-v2-hackathon.json'));
const v1 = readJson(join(root, 'deployments', 'monad-testnet.json'));
const cleanverse = readJson(requirePrivate(secretPath('cleanverse-uat.json')));
const privy = readJson(requirePrivate(secretPath('privy-uat.json')));
const rpc = readJson(requirePrivate(secretPath('monad-rpc.json')));
const r2 = readJson(requirePrivate(secretPath('r2-uat.json')));
const agentPlatform = readJson(requirePrivate(secretPath('agent-platform.json')));
const roles = decryptRoleBundle();

const agentSignerId = requiredString(agentPlatform.privyAuthorization?.signerId, 'agent Privy signer ID');
const agentPolicyId = requiredString(agentPlatform.privyAuthorization?.policyId, 'agent Privy policy ID');
const agentAuthorizationPublicKey = requiredString(agentPlatform.privyAuthorization?.publicKey, 'agent Privy authorization public key');
const agentAuthorizationPrivateKey = requiredString(agentPlatform.privyAuthorization?.privateKey, 'agent Privy authorization private key');
const agentExecutorApiKey = requiredString(agentPlatform.executorApiKey, 'agent executor API key');
const agentJwtKeyId = requiredString(agentPlatform.jwt?.keyId, 'agent JWT key ID');
const agentJwtPrivateJwk = agentPlatform.jwt?.privateJwk;
if (!agentJwtPrivateJwk || agentJwtPrivateJwk.kty !== 'EC' || agentJwtPrivateJwk.crv !== 'P-256' || typeof agentJwtPrivateJwk.d !== 'string') {
  throw new Error('Agent JWT key must be a private P-256 JWK');
}
if (agentAuthorizationPublicKey.length < 32 || agentAuthorizationPrivateKey.length < 32 || agentExecutorApiKey.length < 32) {
  throw new Error('Agent platform authorization material is malformed');
}

if (deployment.deploymentProfile !== 'MONAD_HACKATHON_UAT_ZERO_DELAY') throw new Error('Unexpected deployment profile');
if (deployment.network?.chainId !== 10_143 && deployment.chainId !== 10_143) {
  throw new Error('Deployment manifest is not Monad Testnet');
}
if (!Array.isArray(deployment.indexerSources) || deployment.indexerSources.length === 0) {
  throw new Error('Deployment manifest has no V2 indexer sources');
}
const keeperKey = requiredString(roles.privateKeys?.keeper, 'keeper private key');
if (!/^0x[a-fA-F0-9]{64}$/.test(keeperKey)) throw new Error('Keeper private key is malformed');
const oracleSigner1Key = requiredString(roles.privateKeys?.oracleSigner1, 'oracle signer 1 private key');
const oracleSigner2Key = requiredString(roles.privateKeys?.oracleSigner2, 'oracle signer 2 private key');
if (!/^0x[a-fA-F0-9]{64}$/.test(oracleSigner1Key) || !/^0x[a-fA-F0-9]{64}$/.test(oracleSigner2Key)) {
  throw new Error('Oracle signer private key is malformed');
}
if (oracleSigner1Key.toLowerCase() === oracleSigner2Key.toLowerCase()) throw new Error('Oracle signer keys must be distinct');
const oracleEvidenceHash = requiredString(v1.valuation?.evidenceHash, 'oracle evidence hash');
if (!/^0x[a-fA-F0-9]{64}$/.test(oracleEvidenceHash)) throw new Error('Oracle evidence hash is malformed');
const trustedManifest = { ...deployment.frontendTrustedManifestDraft, status: 'ACTIVE' };
const agentSkillManifest = readJson(join(root, 'skills', 'rwcar-agent', 'manifest.json'));
const agentManifestHash = requiredString(agentSkillManifest.sha256, 'agent skill manifest hash');
if (!/^0x[a-fA-F0-9]{64}$/.test(agentManifestHash)) throw new Error('Agent skill manifest hash is malformed');
const databaseReference = '${{Postgres.DATABASE_URL}}';
const apiDomain = 'https://${{rwcar-api.RAILWAY_PUBLIC_DOMAIN}}';
const apiPrivateDomain = 'http://${{rwcar-api.RAILWAY_PRIVATE_DOMAIN}}:${{rwcar-api.PORT}}';
const webDomain = 'https://${{rwcar-web.RAILWAY_PUBLIC_DOMAIN}}';
const service = deployment.serviceConfiguration;

const api = writeEnvironment('railway-api.env', {
  NODE_ENV: 'production',
  PORT: '8080',
  API_HOST: '::',
  LOG_LEVEL: 'info',
  DATABASE_URL: databaseReference,
  DATABASE_SSL_MODE: 'disable',
  CORS_ORIGINS: webDomain,
  MONAD_RPC_URL: rpc.rpcUrl,
  REPO_MARKET_ADDRESS: v1.repoMarket,
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
  V2_SETTLEMENT_TOKEN_CODE_HASH: deployment.frontendTrustedManifestDraft.settlementToken.runtimeCodeHash,
  COMPLIANCE_VALIDATOR_ADDRESS: deployment.externalContracts.complianceValidator,
  V2_QUOTE_TTL_SECONDS: '30',
  V2_ALLOWED_DURATIONS: deployment.parameters.allowedDurations.join(','),
  V2_MARGIN_ENABLED: String(service.V2_MARGIN_ENABLED === true),
  V2_REPO_POLICY_POOL_REGISTERED: String(service.V2_REPO_POLICY_POOL_REGISTERED === true),
  V2_FEE_TREASURY_AUSDC_ELIGIBLE: String(service.V2_FEE_TREASURY_AUSDC_ELIGIBLE === true),
  V2_SETTLEMENT_ESCROW_AUSDC_READY: String(service.V2_SETTLEMENT_ESCROW_AUSDC_READY === true),
  V2_MARGIN_POLICY_POOL_REGISTERED: String(service.V2_MARGIN_POLICY_POOL_REGISTERED === true),
  V2_MARGIN_VAULT_CUSTODY_READY: String(service.V2_MARGIN_VAULT_CUSTODY_READY === true),
  V2_MARGIN_ESCROW_AUSDC_READY: String(service.V2_MARGIN_ESCROW_AUSDC_READY === true),
  V2_MARGIN_TREASURY_AUSDC_ELIGIBLE: String(service.V2_MARGIN_TREASURY_AUSDC_ELIGIBLE === true),
  CLEANVERSE_BASE_URL: cleanverse.baseUrl,
  CLEANVERSE_API_ID: cleanverse.apiId,
  CLEANVERSE_API_KEY: cleanverse.apiKey,
  PRIVY_APP_ID: privy.appId,
  PRIVY_APP_SECRET: privy.appSecret,
  PRIVY_AGENT_SIGNER_ID: agentSignerId,
  PRIVY_AGENT_POLICY_ID: agentPolicyId,
  ADMIN_API_KEY: adminKey(),
  VALUATION_SIGNERS: deployment.roles.oracleSigners.join(','),
  INDEXER_CONFIRMATIONS: '3',
  COMPLIANCE_CACHE_SECONDS: '30',
  S3_ENDPOINT: r2.endpoint,
  S3_REGION: r2.region || 'auto',
  S3_BUCKET: r2.bucket,
  S3_ACCESS_KEY_ID: r2.accessKeyId,
  S3_SECRET_ACCESS_KEY: r2.secretAccessKey,
  AGENT_PLATFORM_ENABLED: 'true',
  AGENT_ISSUER_URL: apiDomain,
  AGENT_AUDIENCE: `${apiDomain}/mcp`,
  AGENT_JWT_PRIVATE_JWK: JSON.stringify(agentJwtPrivateJwk),
  AGENT_JWT_KEY_ID: agentJwtKeyId,
  AGENT_TOKEN_TTL_SECONDS: '300',
  AGENT_CREDENTIAL_TTL_DAYS: '30',
  AGENT_INTENT_TTL_SECONDS: '300',
  AGENT_EXECUTOR_LEASE_TIMEOUT_SECONDS: '600',
  AGENT_EXECUTOR_API_KEY: agentExecutorApiKey,
  AGENT_MCP_ALLOWED_HOSTS: '${{rwcar-api.RAILWAY_PUBLIC_DOMAIN}},127.0.0.1,localhost',
  AGENT_ALLOWED_MANIFEST_HASHES: agentManifestHash,
  AGENT_UAT_SYNTHETIC_CVI_ENABLED: 'true',
});

const indexer = writeEnvironment('railway-indexer.env', {
  NODE_ENV: 'production',
  DATABASE_URL: databaseReference,
  DATABASE_SSL_MODE: 'disable',
  MONAD_RPC_URL: rpc.rpcUrl,
  REPO_MARKET_ADDRESS: v1.repoMarket,
  REPO_MARKET_DEPLOYMENT_BLOCK: String(v1.deploymentBlock),
  V1_INDEXER_ENABLED: 'false',
  V1_KEEPER_ENABLED: 'false',
  INDEXER_CONFIRMATIONS: '3',
  INDEXER_BATCH_SIZE: String(rpc.maxLogRange || 100),
  INDEXER_POLL_MS: '5000',
  INDEXER_CATCHUP_DELAY_MS: '250',
  KEEPER_PRIVATE_KEY: keeperKey,
  KEEPER_POLL_MS: '10000',
  V2_AUTOMATION_STALE_TX_MS: '120000',
  V2_AUTOMATION_MAX_CHECKPOINT_LAG: '100',
  V2_SETTLEMENT_TOKEN_ADDRESS: deployment.externalContracts.settlementToken,
  V2_DEPLOYMENTS_JSON: JSON.stringify(deployment.indexerSources),
  V2_ORACLE_HEARTBEAT_ENABLED: 'true',
  V2_ORACLE_HEARTBEAT_INTERVAL_MS: '600000',
  V2_ORACLE_HEARTBEAT_VALIDITY_SECONDS: '86400',
  V2_ORACLE_HEARTBEAT_PRICE_E18: '1000000000000000000',
  V2_ORACLE_HEARTBEAT_EVIDENCE_HASH: oracleEvidenceHash,
  V2_ORACLE_SIGNER_1_PRIVATE_KEY: oracleSigner1Key,
  V2_ORACLE_SIGNER_2_PRIVATE_KEY: oracleSigner2Key,
});

const web = writeEnvironment('railway-web.env', {
  VITE_PRIVY_APP_ID: privy.appId,
  VITE_API_URL: apiDomain,
  VITE_TRUSTED_V2_MANIFEST_JSON: JSON.stringify(trustedManifest),
  VITE_PRIVY_AGENT_SIGNER_ID: agentSignerId,
  VITE_PRIVY_AGENT_POLICY_ID: agentPolicyId,
});

const executor = writeEnvironment('railway-agent-executor.env', {
  NODE_ENV: 'production',
  PORT: '3002',
  AGENT_API_BASE_URL: apiPrivateDomain,
  AGENT_EXECUTOR_API_KEY: agentExecutorApiKey,
  PRIVY_APP_ID: privy.appId,
  PRIVY_APP_SECRET: privy.appSecret,
  PRIVY_AGENT_SIGNER_ID: agentSignerId,
  PRIVY_AGENT_POLICY_ID: agentPolicyId,
  PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS: JSON.stringify([agentAuthorizationPrivateKey]),
  MONAD_RPC_URL: rpc.rpcUrl,
  EXECUTOR_WORKER_ID: 'rwcar-agent-executor-primary',
  EXECUTOR_POLL_MS: '2000',
  EXECUTOR_RECEIPT_TIMEOUT_MS: '180000',
  EXECUTOR_INDEX_TIMEOUT_MS: '300000',
});

for (const result of [api, indexer, web, executor]) {
  console.log(`Prepared ${result.count} Railway variables in ${result.path}`);
}
console.log('No secret values were printed. Keep every generated file private and paste it only into its matching Railway service.');
