import { createCipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http } from 'viem';

const CONFIRMATION = 'ONBOARD_RWCAR_V2_FEE_TREASURY_CVI_UAT';
const CHAIN = 'monad';
const CHAIN_ID = 10_143;
const CUSTOMER_ID = 'RWCARFEE20260808MONAD01';
const EXPIRATION_TIME = Math.floor(Date.parse('2027-08-08T23:59:59Z') / 1_000);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const credentialsPath = join(repositoryRoot, '.secrets', 'cleanverse-uat.json');
const deploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.json');
const evidencePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.fee-treasury-cvi.json');

const execute = process.argv.includes('--execute');
if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing fee-treasury onboarding from a dirty worktree');
}

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const address = deployment.roles?.feeTreasury;
const settlementToken = deployment.externalContracts?.settlementToken;
if (!/^0x[a-fA-F0-9]{40}$/.test(address ?? '')) throw new Error('Deployment has no valid fee treasury');
if (!/^0x[a-fA-F0-9]{40}$/.test(settlementToken ?? '')) throw new Error('Deployment has no valid settlement A-Token');

const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: execute ? 'EXECUTING' : 'PREPARED_NOT_SUBMITTED',
  chain: CHAIN,
  chainId: CHAIN_ID,
  address,
  customerId: CUSTOMER_ID,
  expirationTime: EXPIRATION_TIME,
  settlementToken,
  syntheticKyc: true,
  note: 'Synthetic UAT identity data authorized for hackathon integration; not production KYC.',
};
if (!execute) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

if (!existsSync(credentialsPath)) throw new Error(`Missing ${credentialsPath}`);
if ((statSync(credentialsPath).mode & 0o077) !== 0) throw new Error('Cleanverse credential file permissions must be 0600');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
if (!/^https:\/\//.test(credentials.baseUrl ?? '') || !credentials.apiId || !credentials.apiKey) {
  throw new Error('Cleanverse credential file is incomplete');
}
const encryptionKey = Buffer.from(credentials.apiKey, 'base64');
if (![16, 24, 32].includes(encryptionKey.length)) throw new Error('Cleanverse API key is not a valid AES key');

const encryptBody = (body) => {
  const cipher = createCipheriv(`aes-${encryptionKey.length * 8}-cbc`, encryptionKey, Buffer.alloc(16));
  return { data: Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]).toString('base64') };
};
const post = async (path, body, { encrypted = false, allowBusinessFailure = false } = {}) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${credentials.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-id': credentials.apiId },
      body: JSON.stringify(encrypted ? encryptBody(body) : body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await response.json().catch(() => ({}));
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
      continue;
    }
    if (!response.ok) throw new Error(`Cleanverse ${path} HTTP ${response.status}`);
    if (!['0000', 0, '0'].includes(json.code) && !allowBusinessFailure) {
      throw new Error(`Cleanverse ${path} failed: code=${String(json.code)} message=${String(json.message)}`);
    }
    return json;
  }
  throw new Error(`Cleanverse ${path} retry budget exhausted`);
};
const queryApass = () => post('/query_apass', { chain: CHAIN, address }, { allowBusinessFailure: true });
const isNotFound = (response) => String(response.code) === '0002' && /not found/i.test(String(response.message));
const extractApass = (response) => {
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  const item = data.apass ?? data.aPass ?? data;
  return {
    cvRecordId: item.cvRecordId ?? item.cv_record_id ?? null,
    tier: Number(item.tier ?? 0),
    subTier: Number(item.subTier ?? item.sub_tier ?? 0),
    status: Number(item.status ?? 0),
    group: item.group ?? '',
    subGroup: item.subGroup ?? item.sub_group ?? '',
    countries: item.countries ?? item.country ?? [],
    expirationTime: Number(item.expirationTime ?? item.expiration_time ?? 0),
  };
};
const assertActive = (apass) => {
  if (apass.status !== 1) throw new Error(`Fee treasury A-Pass status is ${apass.status}, expected active status 1`);
  if (apass.tier < 30) throw new Error(`Fee treasury A-Pass tier ${apass.tier} is below protocol minimum 30`);
  if (apass.expirationTime <= Math.floor(Date.now() / 1_000)) throw new Error('Fee treasury A-Pass is expired');
};

let query = await queryApass();
let generationTransactionHash = null;
if (isNotFound(query)) {
  const idNumber = createHash('sha256').update('RWCAR-UAT-FEE-TREASURY-2026-08-08').digest('hex');
  const generation = await post('/generate_apass', {
    customerId: CUSTOMER_ID,
    expirationTime: EXPIRATION_TIME,
    wallet: { chain: CHAIN, address },
    identityDataList: [{
      idType: 'ID_CARD',
      fullName: 'RWCAR UAT Fee Treasury',
      idNumber,
      validUntil: '2027-08-08',
      issuingCountryISO2: 'SG',
    }],
  }, { encrypted: true });
  const generated = generation.data && typeof generation.data === 'object' ? generation.data : {};
  generationTransactionHash = generated.wallet?.transactionHash
    ?? generated.wallet?.txHash
    ?? generated.wallet?.transaction_hash
    ?? generated.wallet?.tx_hash
    ?? generated.transactionHash
    ?? generated.transaction_hash
    ?? generated.tx_hash
    ?? null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    query = await queryApass();
    if (['0000', 0, '0'].includes(query.code)) break;
    if (!isNotFound(query)) throw new Error(`Cleanverse /query_apass failed after generation: code=${String(query.code)}`);
  }
}
if (!['0000', 0, '0'].includes(query.code)) throw new Error('Fee treasury A-Pass did not become queryable');
const apass = extractApass(query);
assertActive(apass);

const verification = await post('/verify_apass', { chain: CHAIN, atoken: settlementToken, address });
const verificationCode = Number(verification.data?.code ?? verification.data?.verifyCode ?? 0);
if (verificationCode !== 4) throw new Error(`Fee treasury settlement A-Token verification returned code ${verificationCode}`);

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const client = createPublicClient({ chain: network, transport: http(undefined, { timeout: 20_000, retryCount: 1 }) });
let generationReceipt = null;
if (/^0x[a-fA-F0-9]{64}$/.test(generationTransactionHash ?? '')) {
  const receipt = await client.waitForTransactionReceipt({ hash: generationTransactionHash, confirmations: 3, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`A-Pass generation reverted: ${generationTransactionHash}`);
  generationReceipt = { txHash: generationTransactionHash, blockNumber: receipt.blockNumber.toString() };
}

const evidence = {
  ...publicPlan,
  status: 'ACTIVE_UAT_CVI',
  verifiedAt: new Date().toISOString(),
  apass,
  settlementATokenVerificationCode: verificationCode,
  generation: generationReceipt ?? { existingApass: true },
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
deployment.cleanverse.feeTreasuryCvi = {
  active: true,
  address,
  tier: apass.tier,
  expirationTime: apass.expirationTime,
  settlementATokenVerificationCode: verificationCode,
  transactionHash: generationReceipt?.txHash ?? null,
};
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  address,
  tier: apass.tier,
  expirationTime: apass.expirationTime,
  settlementATokenVerificationCode: verificationCode,
  transactionHash: generationReceipt?.txHash ?? null,
  evidencePath,
}, null, 2));
