import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  recoverMessageAddress,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'ACTIVATE_RWCAR_V2_CLEANVERSE_UAT';
const CHAIN_ID = 10_143;
const CHAIN = 'monad';
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const credentialsPath = join(secretsDirectory, 'cleanverse-uat.json');
const signaturesPath = join(secretsDirectory, 'v2-cleanverse-signatures.json');
const journalPath = join(secretsDirectory, 'v2-cleanverse-activation.journal.jsonl');
const deploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.json');
const rolesPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.roles.json');
const evidencePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.cleanverse.json');
const factoryArtifactPath = join(repositoryRoot, 'packages/contracts/artifacts-solc/ProtocolModuleFactoryV2.json');

const execute = process.argv.includes('--execute');
if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing Cleanverse activation from a dirty worktree');
}

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const roles = JSON.parse(readFileSync(rolesPath, 'utf8')).roles;
const factoryAbi = JSON.parse(readFileSync(factoryArtifactPath, 'utf8')).abi;
const ownableAbi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
]);
const validatorAbi = parseAbi([
  'function hasRole(bytes32 role,address account) view returns (bool)',
]);
const registerRole = keccak256(toHex('REGISTER_ROLE'));

const encryptedBundle = JSON.parse(readFileSync(join(secretsDirectory, 'v2-uat-roles.enc.json'), 'utf8'));
const wrappingKey = Buffer.from(readFileSync(join(secretsDirectory, 'v2-uat-roles.key'), 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const privateKeys = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8')).privateKeys;
const deployerAccount = privateKeyToAccount(privateKeys.deployer);
const factoryAccount = privateKeyToAccount(privateKeys.factoryActivationOwner);
if (deployerAccount.address.toLowerCase() !== roles.deployer.toLowerCase()) throw new Error('Deployer signer mismatch');
if (factoryAccount.address.toLowerCase() !== roles.factoryActivationOwner.toLowerCase()) {
  throw new Error('Factory activation signer mismatch');
}

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const baseTransport = http(network.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 0 });
let rpcQueue = Promise.resolve();
const transport = (config) => {
  const inner = baseTransport(config);
  return {
    ...inner,
    request(args) {
      const request = rpcQueue.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            return await inner.request(args);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('requests limited') && !message.includes('-32011')) throw error;
            if (attempt === 5) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          }
        }
        throw new Error('RPC retry loop exhausted');
      });
      rpcQueue = request.then(() => undefined, () => undefined);
      return request;
    },
  };
};
const publicClient = createPublicClient({ chain: network, transport });
const factoryWallet = createWalletClient({ account: factoryAccount, chain: network, transport });

const ownerMessage = (address) => `${CHAIN}${address.toLowerCase()}`;
const poolAddresses = [deployment.contracts.repoMarket, deployment.contracts.marginEngine];
const [repoOwner, marginOwner, factoryOwner, factoryPendingOwner, factoryValidator] = await Promise.all([
  publicClient.readContract({ address: poolAddresses[0], abi: ownableAbi, functionName: 'owner' }),
  publicClient.readContract({ address: poolAddresses[1], abi: ownableAbi, functionName: 'owner' }),
  publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: ownableAbi, functionName: 'owner' }),
  publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: ownableAbi, functionName: 'pendingOwner' }),
  publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: factoryAbi, functionName: 'validator' }),
]);
if ([repoOwner, marginOwner].some((owner) => owner.toLowerCase() !== deployerAccount.address.toLowerCase())) {
  throw new Error('A policy pool is no longer owned by the expected activation signer');
}
if (factoryOwner.toLowerCase() !== factoryAccount.address.toLowerCase() || factoryPendingOwner !== zeroAddress) {
  throw new Error('Factory ownership is not in the expected activation state');
}
if (factoryValidator.toLowerCase() !== deployment.externalContracts.complianceValidator.toLowerCase()) {
  throw new Error('Factory validator binding mismatch');
}

const signatures = {
  repoMarket: await deployerAccount.signMessage({ message: ownerMessage(poolAddresses[0]) }),
  marginEngine: await deployerAccount.signMessage({ message: ownerMessage(poolAddresses[1]) }),
  moduleFactory: await factoryAccount.signMessage({ message: ownerMessage(deployment.contracts.moduleFactory) }),
};
for (const [subject, address, expectedOwner, signature] of [
  ['repoMarket', poolAddresses[0], repoOwner, signatures.repoMarket],
  ['marginEngine', poolAddresses[1], marginOwner, signatures.marginEngine],
  ['moduleFactory', deployment.contracts.moduleFactory, factoryOwner, signatures.moduleFactory],
]) {
  const recovered = await recoverMessageAddress({ message: ownerMessage(address), signature });
  if (recovered.toLowerCase() !== expectedOwner.toLowerCase()) throw new Error(`${subject} signature recovery mismatch`);
}
writeFileSync(signaturesPath, `${JSON.stringify(signatures, null, 2)}\n`, { mode: 0o600 });

const custodyBindings = [
  { key: 'marketVault', pool: deployment.contracts.repoMarket, token: deployment.externalContracts.cvaAsset, custody: deployment.contracts.marketVault },
  { key: 'marketSettlementEscrow', pool: deployment.contracts.repoMarket, token: deployment.externalContracts.settlementToken, custody: deployment.contracts.marketSettlementEscrow },
  { key: 'marginVault', pool: deployment.contracts.marginEngine, token: deployment.externalContracts.cvaAsset, custody: deployment.contracts.marginVault },
  { key: 'marginSettlementEscrow', pool: deployment.contracts.marginEngine, token: deployment.externalContracts.settlementToken, custody: deployment.contracts.marginSettlementEscrow },
];
for (const binding of custodyBindings) {
  const [controller, token, type] = await Promise.all([
    publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: factoryAbi, functionName: 'moduleController', args: [binding.custody] }),
    publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: factoryAbi, functionName: 'moduleToken', args: [binding.custody] }),
    publicClient.readContract({ address: deployment.contracts.moduleFactory, abi: factoryAbi, functionName: 'moduleType', args: [binding.custody] }),
  ]);
  if (controller.toLowerCase() !== binding.pool.toLowerCase() || token.toLowerCase() !== binding.token.toLowerCase()) {
    throw new Error(`${binding.key} controller/token binding mismatch`);
  }
  if (Number(type) !== (binding.key.includes('Vault') ? 1 : 3)) throw new Error(`${binding.key} module type mismatch`);
}

const publicPlan = {
  sourceRevision: revision,
  chain: CHAIN,
  status: execute ? 'EXECUTING' : 'PREPARED_NOT_SUBMITTED',
  subjects: {
    repoMarket: { address: poolAddresses[0], owner: repoOwner, message: ownerMessage(poolAddresses[0]) },
    marginEngine: { address: poolAddresses[1], owner: marginOwner, message: ownerMessage(poolAddresses[1]) },
    moduleFactory: { address: deployment.contracts.moduleFactory, owner: factoryOwner, message: ownerMessage(deployment.contracts.moduleFactory) },
  },
  custodyBindings,
};
if (!execute) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

if (!existsSync(credentialsPath)) {
  throw new Error(`Missing ${credentialsPath}; place rotated Cleanverse UAT credentials there with mode 0600`);
}
if ((statSync(credentialsPath).mode & 0o077) !== 0) throw new Error('Cleanverse credential file permissions must be 0600');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
if (!/^https:\/\//.test(credentials.baseUrl ?? '') || !credentials.apiId || !credentials.apiKey) {
  throw new Error('Cleanverse credential file is incomplete');
}
const cleanverseKey = Buffer.from(credentials.apiKey, 'base64');
if (![16, 24, 32].includes(cleanverseKey.length)) throw new Error('Cleanverse API key is not a valid AES key');

const encryptBody = (body) => {
  const cipher = createCipheriv(`aes-${cleanverseKey.length * 8}-cbc`, cleanverseKey, Buffer.alloc(16));
  return { data: Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]).toString('base64') };
};
const cleanverseRequest = async (path, body, encrypted = false) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${credentials.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-id': credentials.apiId },
      body: JSON.stringify(encrypted ? encryptBody(body) : body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => ({}));
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
      continue;
    }
    if (!response.ok || !['0000', 0, '0'].includes(json.code)) {
      throw new Error(`Cleanverse ${path} failed: code=${String(json.code)} message=${String(json.message ?? response.status)}`);
    }
    return json;
  }
  throw new Error(`Cleanverse ${path} retry budget exhausted`);
};
const readRegistered = async (pool) => {
  const response = await cleanverseRequest('/validator/is_register', { chain: CHAIN, contract_address: pool });
  const data = response.data ?? {};
  const value = data.registered ?? data.isRegistered ?? data.is_register ?? data.isRegister;
  if (![true, false, 0, 1, '0', '1'].includes(value)) throw new Error('Cleanverse registration response omitted an authoritative boolean');
  return value === true || value === 1 || value === '1';
};
const mutationHash = (response, stage) => {
  const data = response.data ?? {};
  const hash = data.tx_hash ?? data.txHash;
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash ?? '')) throw new Error(`${stage} returned no valid transaction hash`);
  return hash;
};
const record = (entry) => appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
const waitForSuccess = async (stage, hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${stage} reverted: ${hash}`);
  record({ stage, txHash: hash, blockNumber: receipt.blockNumber.toString(), state: 'CONFIRMED' });
  return receipt;
};

const rule = {
  allowed_group: '',
  allowed_sub_group: '',
  min_tier: 30,
  min_sub_tier: 0,
  is_black_list: false,
  countries: [],
};
const ruleDigest = keccak256(toHex(JSON.stringify(rule)));
const priorTransactions = {};
if (existsSync(journalPath)) {
  for (const line of readFileSync(journalPath, 'utf8').split(/\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.state === 'CONFIRMED' && /^0x[a-fA-F0-9]{64}$/.test(entry.txHash ?? '')) {
      priorTransactions[entry.stage] = { txHash: entry.txHash, blockNumber: String(entry.blockNumber) };
    }
  }
}
const evidence = { ...publicPlan, status: 'CLEANVERSE_REGISTERED_SMOKE_PENDING', rule, ruleDigest, transactions: priorTransactions };
for (const [key, pool, signature] of [
  ['marketPolicyPool', poolAddresses[0], signatures.repoMarket],
  ['marginPolicyPool', poolAddresses[1], signatures.marginEngine],
]) {
  if (!await readRegistered(pool)) {
    const response = await cleanverseRequest('/validator/register', {
      chain: CHAIN,
      contract_address: pool,
      rule,
      owner_signature: signature,
    }, true);
    const hash = mutationHash(response, key);
    record({ stage: key, txHash: hash, state: 'SUBMITTED' });
    const receipt = await waitForSuccess(key, hash);
    evidence.transactions[key] = { txHash: hash, blockNumber: receipt.blockNumber.toString() };
  } else if (!evidence.transactions[key]?.txHash) {
    evidence.transactions[key] = { alreadyRegistered: true };
  }
  if (!await readRegistered(pool)) throw new Error(`${key} is not registered after confirmation`);
}

let registrarGranted = await publicClient.readContract({
  address: deployment.externalContracts.complianceValidator,
  abi: validatorAbi,
  functionName: 'hasRole',
  args: [registerRole, deployment.contracts.moduleFactory],
});
if (!registrarGranted) {
  const response = await cleanverseRequest('/validator/grant', {
    chain: CHAIN,
    address: deployment.contracts.moduleFactory,
    owner_signature: signatures.moduleFactory,
  }, true);
  const hash = mutationHash(response, 'moduleFactoryRegistrarRole');
  record({ stage: 'moduleFactoryRegistrarRole', txHash: hash, state: 'SUBMITTED' });
  const receipt = await waitForSuccess('moduleFactoryRegistrarRole', hash);
  evidence.transactions.moduleFactoryRegistrarRole = { txHash: hash, blockNumber: receipt.blockNumber.toString() };
  registrarGranted = await publicClient.readContract({
    address: deployment.externalContracts.complianceValidator,
    abi: validatorAbi,
    functionName: 'hasRole',
    args: [registerRole, deployment.contracts.moduleFactory],
  });
}
if (!registrarGranted) throw new Error('Factory REGISTER_ROLE is not active after confirmation');

for (const binding of custodyBindings) {
  const registrationKey = keccak256(encodeAbiParameters(
    parseAbiParameters('address,address,address'),
    [binding.pool, binding.token, binding.custody],
  ));
  let registered = await publicClient.readContract({
    address: deployment.contracts.moduleFactory,
    abi: factoryAbi,
    functionName: 'custodyRegistered',
    args: [registrationKey],
  });
  if (!registered) {
    const simulation = await publicClient.simulateContract({
      account: factoryAccount,
      address: deployment.contracts.moduleFactory,
      abi: factoryAbi,
      functionName: 'registerCvaCustody',
      args: [binding.pool, binding.token, binding.custody],
    });
    const hash = await factoryWallet.writeContract(simulation.request);
    record({ stage: binding.key, txHash: hash, state: 'SUBMITTED' });
    const receipt = await waitForSuccess(binding.key, hash);
    evidence.transactions[binding.key] = { txHash: hash, blockNumber: receipt.blockNumber.toString(), registrationKey };
    registered = await publicClient.readContract({
      address: deployment.contracts.moduleFactory,
      abi: factoryAbi,
      functionName: 'custodyRegistered',
      args: [registrationKey],
    });
  } else {
    evidence.transactions[binding.key] = { alreadyRegistered: true, registrationKey };
  }
  if (!registered) throw new Error(`${binding.key} contract CVI registration is not active`);
}

for (const pool of poolAddresses) {
  if (!await readRegistered(pool)) throw new Error(`Final pool registration verification failed for ${pool}`);
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
deployment.cleanverse.moduleFactoryRegistrarRole = {
  granted: true,
  requestId: null,
  transactionHash: evidence.transactions.moduleFactoryRegistrarRole?.txHash ?? null,
};
for (const key of ['marketPolicyPool', 'marketVault', 'marketSettlementEscrow', 'marginPolicyPool', 'marginVault', 'marginSettlementEscrow']) {
  deployment.cleanverse[key].registered = true;
  deployment.cleanverse[key].transactionHash = evidence.transactions[key]?.txHash ?? null;
}
deployment.cleanverse.marketPolicyPool.ruleDigest = ruleDigest;
deployment.cleanverse.marginPolicyPool.ruleDigest = ruleDigest;
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  evidencePath,
  poolsRegistered: true,
  factoryRegistrarRole: true,
  custodyRegistrations: custodyBindings.map(({ key, custody }) => ({ key, custody, registered: true })),
}, null, 2));
