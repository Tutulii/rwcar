import { createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'FINALIZE_RWCAR_V2_UAT_GOVERNANCE';
const CHAIN_ID = 10_143;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const deploymentFilename = process.argv.find((argument) => argument.startsWith('--deployment='))
  ?.slice('--deployment='.length) || 'monad-testnet-v2.json';
if (!['monad-testnet-v2.json', 'monad-testnet-v2-hackathon.json'].includes(deploymentFilename)) {
  throw new Error('Unsupported deployment manifest');
}
const deploymentStem = deploymentFilename.slice(0, -'.json'.length);
const deploymentPath = join(repositoryRoot, 'deployments', deploymentFilename);
const cleanverseEvidencePath = join(repositoryRoot, 'deployments', `${deploymentStem}.cleanverse.json`);
const evidencePath = join(repositoryRoot, 'deployments', `${deploymentStem}.governance.json`);
const journalPath = join(secretsDirectory, `${deploymentStem}.governance-finalization.journal.jsonl`);
const artifactsDirectory = join(repositoryRoot, 'packages', 'contracts', 'artifacts-solc');
const execute = process.argv.includes('--execute');

if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing governance finalization from a dirty worktree');
}

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const artifact = (name) => JSON.parse(readFileSync(join(artifactsDirectory, `${name}.json`), 'utf8')).abi;
const factoryAbi = artifact('ProtocolModuleFactoryV2');
const riskAbi = artifact('RiskManagerV2');
const marketAbi = artifact('RepoMarketV2');
const marginAbi = artifact('MarginEngineV2');
const ownableAbi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
]);
const validatorAbi = parseAbi([
  'function isRegistered(address pool) view returns (bool)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
]);

const encryptedBundle = JSON.parse(readFileSync(join(secretsDirectory, 'v2-uat-roles.enc.json'), 'utf8'));
const wrappingKey = Buffer.from(readFileSync(join(secretsDirectory, 'v2-uat-roles.key'), 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const privateKeys = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8')).privateKeys;
const finalOwnerAccount = privateKeyToAccount(privateKeys.owner);
const factoryAccount = privateKeyToAccount(privateKeys.factoryActivationOwner);
if (finalOwnerAccount.address.toLowerCase() !== deployment.roles.pendingOwner.toLowerCase()) {
  throw new Error('Final owner signer mismatch');
}
if (factoryAccount.address.toLowerCase() !== deployment.roles.factoryActivationOwner.toLowerCase()) {
  throw new Error('Factory activation signer mismatch');
}

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const transport = http(network.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: network, transport });
const ownerWallet = createWalletClient({ account: finalOwnerAccount, chain: network, transport });
const factoryWallet = createWalletClient({ account: factoryAccount, chain: network, transport });

const governed = [
  { key: 'assetRegistry', address: deployment.contracts.assetRegistry, activationOwner: deployment.roles.deployer },
  { key: 'riskManager', address: deployment.contracts.riskManager, activationOwner: deployment.roles.deployer },
  { key: 'valuationOracle', address: deployment.contracts.valuationOracle, activationOwner: deployment.roles.deployer },
  { key: 'repoMarket', address: deployment.contracts.repoMarket, activationOwner: deployment.roles.deployer },
  { key: 'marginEngine', address: deployment.contracts.marginEngine, activationOwner: deployment.roles.deployer },
  { key: 'moduleFactory', address: deployment.contracts.moduleFactory, activationOwner: factoryAccount.address },
];
const ownership = {};
for (const subject of governed) {
  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'pendingOwner' }),
  ]);
  ownership[subject.key] = { address: subject.address, owner, pendingOwner };
}

const validator = deployment.externalContracts.complianceValidator;
const registerRole = keccak256(toHex('REGISTER_ROLE'));
const poolRegistration = {};
for (const key of ['repoMarket', 'marginEngine']) {
  poolRegistration[key] = await publicClient.readContract({
    address: validator,
    abi: validatorAbi,
    functionName: 'isRegistered',
    args: [deployment.contracts[key]],
  });
}
const factoryRegistrarRole = await publicClient.readContract({
  address: validator,
  abi: validatorAbi,
  functionName: 'hasRole',
  args: [registerRole, deployment.contracts.moduleFactory],
});

const custodyBindings = [
  { key: 'marketVault', pool: deployment.contracts.repoMarket, token: deployment.externalContracts.cvaAsset, custody: deployment.contracts.marketVault },
  { key: 'marketSettlementEscrow', pool: deployment.contracts.repoMarket, token: deployment.externalContracts.settlementToken, custody: deployment.contracts.marketSettlementEscrow },
  { key: 'marginVault', pool: deployment.contracts.marginEngine, token: deployment.externalContracts.cvaAsset, custody: deployment.contracts.marginVault },
  { key: 'marginSettlementEscrow', pool: deployment.contracts.marginEngine, token: deployment.externalContracts.settlementToken, custody: deployment.contracts.marginSettlementEscrow },
];
const custodyRegistration = {};
for (const binding of custodyBindings) {
  const registrationKey = keccak256(encodeAbiParameters(
    parseAbiParameters('address,address,address'),
    [binding.pool, binding.token, binding.custody],
  ));
  custodyRegistration[binding.key] = {
    registrationKey,
    registered: await publicClient.readContract({
      address: deployment.contracts.moduleFactory,
      abi: factoryAbi,
      functionName: 'custodyRegistered',
      args: [registrationKey],
    }),
  };
}

const [marketEntryPaused, marketAsset, marginEntryPaused, marginCustodyReady, latestBlock] = await Promise.all([
  publicClient.readContract({ address: deployment.contracts.repoMarket, abi: marketAbi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: deployment.contracts.repoMarket, abi: marketAbi, functionName: 'getAssetConfig', args: [deployment.externalContracts.cvaAsset] }),
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'cleanverseCustodyReady' }),
  publicClient.getBlock(),
]);
const pendingRisk = await publicClient.readContract({
  address: deployment.contracts.riskManager,
  abi: riskAbi,
  functionName: 'pendingConfigs',
  args: [deployment.externalContracts.cvaAsset],
});
const activeRisk = await publicClient.readContract({
  address: deployment.contracts.riskManager,
  abi: riskAbi,
  functionName: 'rawConfig',
  args: [deployment.externalContracts.cvaAsset],
});
const expectedRisk = deployment.parameters.riskConfig;
const applyConfigAbi = riskAbi.find((item) => item.type === 'function' && item.name === 'applyConfig');
const expectedRiskHash = keccak256(encodeAbiParameters([applyConfigAbi.inputs[1]], [expectedRisk]));
const riskApplied = activeRisk.enabled === true;
const chainTimestamp = Number(latestBlock.timestamp);
const executeAfter = Number(pendingRisk.executeAfter ?? pendingRisk[1]);
const pendingRiskHash = pendingRisk.configHash ?? pendingRisk[0];

const blockers = [];
for (const subject of governed) {
  const state = ownership[subject.key];
  const owner = state.owner.toLowerCase();
  const pendingOwner = state.pendingOwner.toLowerCase();
  const finalOwner = finalOwnerAccount.address.toLowerCase();
  if (![subject.activationOwner.toLowerCase(), finalOwner].includes(owner)) blockers.push(`${subject.key}:unexpected-owner`);
  if (owner !== finalOwner) {
    const factoryAwaitingTransfer = subject.key === 'moduleFactory' && pendingOwner === zeroAddress;
    if (!factoryAwaitingTransfer && pendingOwner !== finalOwner) blockers.push(`${subject.key}:unexpected-pending-owner`);
  } else if (pendingOwner !== zeroAddress) blockers.push(`${subject.key}:pending-owner-not-cleared`);
}
if (!poolRegistration.repoMarket) blockers.push('repo-market-policy-pool-not-registered');
if (!poolRegistration.marginEngine) blockers.push('margin-policy-pool-not-registered');
if (!factoryRegistrarRole) blockers.push('factory-register-role-not-granted');
for (const [key, state] of Object.entries(custodyRegistration)) if (!state.registered) blockers.push(`${key}:custody-not-registered`);
if (!marketEntryPaused || !marginEntryPaused) blockers.push('entry-must-remain-paused');
if (marketAsset.cleanverseReady || marginCustodyReady) blockers.push('readiness-must-remain-false-before-smoke');
if (!existsSync(cleanverseEvidencePath)) blockers.push('cleanverse-evidence-missing');
for (const key of ['marketPolicyPool', 'marginPolicyPool', 'moduleFactoryRegistrarRole', 'marketVault', 'marketSettlementEscrow', 'marginVault', 'marginSettlementEscrow']) {
  const state = deployment.cleanverse?.[key];
  const complete = key === 'moduleFactoryRegistrarRole' ? state?.granted === true : state?.registered === true;
  if (!complete) blockers.push(`${key}:manifest-proof-missing`);
}
if (!riskApplied) {
  if (pendingRiskHash.toLowerCase() !== expectedRiskHash.toLowerCase()) blockers.push('risk-config-hash-mismatch');
  if (expectedRiskHash.toLowerCase() !== deployment.riskActivation.configHash.toLowerCase()) blockers.push('risk-manifest-hash-mismatch');
  if (chainTimestamp < executeAfter) blockers.push(`risk-timelock:${executeAfter - chainTimestamp}-seconds-remaining`);
}

const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: blockers.length ? 'BLOCKED_NOT_SUBMITTED' : execute ? 'EXECUTING' : 'READY_NOT_SUBMITTED',
  chainId: CHAIN_ID,
  chainBlock: latestBlock.number.toString(),
  chainTimestamp,
  finalOwner: finalOwnerAccount.address,
  ownership,
  poolRegistration,
  factoryRegistrarRole,
  custodyRegistration,
  safety: { marketEntryPaused, marketReady: marketAsset.cleanverseReady, marginEntryPaused, marginCustodyReady },
  risk: { expectedRiskHash, pendingRiskHash, executeAfter, applied: riskApplied },
  blockers,
};
if (!execute || blockers.length) {
  console.log(JSON.stringify(publicPlan, null, 2));
  if (execute && blockers.length) process.exitCode = 2;
  process.exit();
}

const transactions = {};
if (existsSync(journalPath)) {
  for (const line of readFileSync(journalPath, 'utf8').split(/\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.state === 'CONFIRMED' && /^0x[a-fA-F0-9]{64}$/.test(entry.txHash ?? '')) {
      transactions[entry.stage] = { txHash: entry.txHash, blockNumber: String(entry.blockNumber) };
    }
  }
}
const record = (entry) => appendFileSync(
  journalPath,
  `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  { mode: 0o600 },
);
const confirm = async (stage, hash) => {
  record({ stage, txHash: hash, state: 'SUBMITTED' });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${stage} reverted: ${hash}`);
  transactions[stage] = { txHash: hash, blockNumber: receipt.blockNumber.toString() };
  record({ stage, txHash: hash, blockNumber: receipt.blockNumber.toString(), state: 'CONFIRMED' });
};
if (ownership.moduleFactory.owner.toLowerCase() !== finalOwnerAccount.address.toLowerCase()) {
  if (ownership.moduleFactory.pendingOwner === zeroAddress) {
    const simulation = await publicClient.simulateContract({
      account: factoryAccount,
      address: deployment.contracts.moduleFactory,
      abi: ownableAbi,
      functionName: 'transferOwnership',
      args: [finalOwnerAccount.address],
    });
    await confirm('transferModuleFactoryOwnership', await factoryWallet.writeContract(simulation.request));
  }
}
for (const subject of governed) {
  const liveOwner = await publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'owner' });
  if (liveOwner.toLowerCase() === finalOwnerAccount.address.toLowerCase()) continue;
  const livePending = await publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'pendingOwner' });
  if (livePending.toLowerCase() !== finalOwnerAccount.address.toLowerCase()) throw new Error(`${subject.key} no longer names the final owner`);
  const simulation = await publicClient.simulateContract({
    account: finalOwnerAccount,
    address: subject.address,
    abi: ownableAbi,
    functionName: 'acceptOwnership',
  });
  await confirm(`accept${subject.key[0].toUpperCase()}${subject.key.slice(1)}Ownership`, await ownerWallet.writeContract(simulation.request));
}
if (!riskApplied) {
  const simulation = await publicClient.simulateContract({
    account: finalOwnerAccount,
    address: deployment.contracts.riskManager,
    abi: riskAbi,
    functionName: 'applyConfig',
    args: [deployment.externalContracts.cvaAsset, expectedRisk],
  });
  await confirm('applyRiskConfig', await ownerWallet.writeContract(simulation.request));
}

for (const subject of governed) {
  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: subject.address, abi: ownableAbi, functionName: 'pendingOwner' }),
  ]);
  if (owner.toLowerCase() !== finalOwnerAccount.address.toLowerCase() || pendingOwner !== zeroAddress) {
    throw new Error(`${subject.key} ownership final verification failed`);
  }
  deployment.ownership.contracts[subject.key] = {
    ...deployment.ownership.contracts[subject.key],
    currentOwner: owner,
    pendingOwner,
    accepted: true,
    ...(subject.key === 'moduleFactory' ? { activationComplete: true } : {}),
  };
}
const finalRisk = await publicClient.readContract({
  address: deployment.contracts.riskManager,
  abi: riskAbi,
  functionName: 'rawConfig',
  args: [deployment.externalContracts.cvaAsset],
});
if (!finalRisk.enabled) throw new Error('Risk configuration is not enabled after finalization');
const finalMarketPaused = await publicClient.readContract({ address: deployment.contracts.repoMarket, abi: marketAbi, functionName: 'entryPaused' });
const finalMarginPaused = await publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'entryPaused' });
if (!finalMarketPaused || !finalMarginPaused) throw new Error('An engine was unexpectedly unpaused during governance finalization');

deployment.ownership.acceptanceTransactions = transactions;
deployment.riskActivation.applied = true;
deployment.riskActivation.appliedTransaction = transactions.applyRiskConfig?.txHash ?? deployment.riskActivation.appliedTransaction;
for (const [key, transaction] of Object.entries(transactions)) deployment.transactions[key] = transaction;
const evidence = {
  ...publicPlan,
  status: 'GOVERNANCE_FINALIZED_ENTRY_PAUSED',
  completedAt: new Date().toISOString(),
  transactions,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ status: evidence.status, finalOwner: finalOwnerAccount.address, transactions, evidencePath }, null, 2));
