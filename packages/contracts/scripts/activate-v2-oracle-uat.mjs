import { createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  recoverTypedDataAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'PUBLISH_RWCAR_V2_UAT_VALUATION';
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
const governancePath = join(repositoryRoot, 'deployments', `${deploymentStem}.governance.json`);
const evidencePath = join(repositoryRoot, 'deployments', `${deploymentStem}.oracle.json`);
const v1DeploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet.json');
const oracleArtifactPath = join(repositoryRoot, 'packages/contracts/artifacts-solc/SignedValuationOracle.json');
const execute = process.argv.includes('--execute');

if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing oracle activation from a dirty worktree');
}
if (!existsSync(governancePath)) throw new Error('Governance finalization evidence is missing');

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const governance = JSON.parse(readFileSync(governancePath, 'utf8'));
const v1Deployment = JSON.parse(readFileSync(v1DeploymentPath, 'utf8'));
const oracleAbi = JSON.parse(readFileSync(oracleArtifactPath, 'utf8')).abi;
if (governance.status !== 'GOVERNANCE_FINALIZED_ENTRY_PAUSED') {
  throw new Error('Governance must be finalized with entry paused');
}

const encryptedBundle = JSON.parse(readFileSync(join(secretsDirectory, 'v2-uat-roles.enc.json'), 'utf8'));
const wrappingKey = Buffer.from(readFileSync(join(secretsDirectory, 'v2-uat-roles.key'), 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const privateKeys = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8')).privateKeys;

const ownerAccount = privateKeyToAccount(privateKeys.owner);
const signerAccounts = [
  privateKeyToAccount(privateKeys.oracleSigner1),
  privateKeyToAccount(privateKeys.oracleSigner2),
  privateKeyToAccount(privateKeys.oracleSigner3),
];
if (ownerAccount.address.toLowerCase() !== deployment.roles.pendingOwner.toLowerCase()) {
  throw new Error('Final owner signer mismatch');
}
for (const [index, signer] of signerAccounts.entries()) {
  if (signer.address.toLowerCase() !== deployment.roles.oracleSigners[index].toLowerCase()) {
    throw new Error(`Oracle signer ${index + 1} mismatch`);
  }
}

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const transport = http(network.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: network, transport });
const ownerWallet = createWalletClient({ account: ownerAccount, chain: network, transport });

const [chainId, oracleOwner, liveSignerSet, lastNonce, previousValuation, latestBlock] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({ address: deployment.contracts.valuationOracle, abi: oracleAbi, functionName: 'owner' }),
  publicClient.readContract({ address: deployment.contracts.valuationOracle, abi: oracleAbi, functionName: 'signerSet' }),
  publicClient.readContract({
    address: deployment.contracts.valuationOracle,
    abi: oracleAbi,
    functionName: 'lastNonce',
    args: [deployment.externalContracts.cvaAsset],
  }),
  publicClient.readContract({
    address: deployment.contracts.valuationOracle,
    abi: oracleAbi,
    functionName: 'latest',
    args: [deployment.externalContracts.cvaAsset],
  }),
  publicClient.getBlock(),
]);
if (chainId !== CHAIN_ID) throw new Error(`RPC returned chain ${chainId}; expected ${CHAIN_ID}`);
if (oracleOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) throw new Error('Oracle owner is not finalized');
if (liveSignerSet.some((signer, index) => signer.toLowerCase() !== signerAccounts[index].address.toLowerCase())) {
  throw new Error('Live oracle signer set mismatch');
}
if (await publicClient.getBalance({ address: ownerAccount.address }) === 0n) throw new Error('Final owner has no MON');

const observedAt = Number(latestBlock.timestamp);
const previousObservedAt = Number(previousValuation.observedAt ?? previousValuation[1]);
if (observedAt <= previousObservedAt) throw new Error('Wait for a newer block before publishing a valuation');
const nonce = BigInt(lastNonce) + 1n;
const priceE18Raw = process.env.V2_UAT_RWRN01_PRICE_E18?.trim() || '1000000000000000000';
if (!/^\d+$/.test(priceE18Raw) || BigInt(priceE18Raw) === 0n) throw new Error('Invalid V2_UAT_RWRN01_PRICE_E18');
const evidenceHash = v1Deployment.valuation?.evidenceHash;
if (!/^0x[a-fA-F0-9]{64}$/.test(evidenceHash ?? '')) throw new Error('Canonical valuation evidence hash is missing');

const attestation = {
  asset: deployment.externalContracts.cvaAsset,
  settlementToken: deployment.externalContracts.settlementToken,
  priceE18: BigInt(priceE18Raw),
  observedAt,
  validUntil: observedAt + 86_400,
  nonce,
  evidenceHash,
};
const domain = {
  name: 'RWCAR Signed Valuation Oracle',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: deployment.contracts.valuationOracle,
};
const types = {
  Attestation: [
    { name: 'asset', type: 'address' },
    { name: 'settlementToken', type: 'address' },
    { name: 'priceE18', type: 'uint256' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
};
const typedData = { domain, types, primaryType: 'Attestation', message: attestation };
const digest = hashTypedData(typedData);
const onChainDigest = await publicClient.readContract({
  address: deployment.contracts.valuationOracle,
  abi: oracleAbi,
  functionName: 'hashAttestation',
  args: [attestation],
});
if (onChainDigest.toLowerCase() !== digest.toLowerCase()) throw new Error('Local/on-chain valuation digest mismatch');

const signatures = await Promise.all(signerAccounts.slice(0, 2).map((signer) => signer.signTypedData(typedData)));
for (const [index, signature] of signatures.entries()) {
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (recovered.toLowerCase() !== signerAccounts[index].address.toLowerCase()) {
    throw new Error(`Valuation signature ${index + 1} recovery mismatch`);
  }
}

const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: execute ? 'EXECUTING' : 'READY_NOT_SUBMITTED',
  chainId: CHAIN_ID,
  oracle: deployment.contracts.valuationOracle,
  owner: oracleOwner,
  signerSet: liveSignerSet,
  threshold: 2,
  attestation: {
    ...attestation,
    priceE18: attestation.priceE18.toString(),
    nonce: attestation.nonce.toString(),
  },
  digest,
};
if (!execute) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

const simulation = await publicClient.simulateContract({
  account: ownerAccount,
  address: deployment.contracts.valuationOracle,
  abi: oracleAbi,
  functionName: 'submit',
  args: [attestation, signatures],
});
const transactionHash = await ownerWallet.writeContract(simulation.request);
const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations: 3, timeout: 180_000 });
if (receipt.status !== 'success') throw new Error(`Valuation submission reverted: ${transactionHash}`);
const liveValuation = await publicClient.readContract({
  address: deployment.contracts.valuationOracle,
  abi: oracleAbi,
  functionName: 'latest',
  args: [deployment.externalContracts.cvaAsset],
});
if (
  liveValuation.digest.toLowerCase() !== digest.toLowerCase()
    || BigInt(liveValuation.priceE18) !== attestation.priceE18
    || BigInt(liveValuation.nonce) !== attestation.nonce
    || liveValuation.settlementToken.toLowerCase() !== attestation.settlementToken.toLowerCase()
    || liveValuation.evidenceHash.toLowerCase() !== evidenceHash.toLowerCase()
) throw new Error('Live valuation does not match the signed attestation');

const evidence = {
  ...publicPlan,
  status: 'VALUATION_ACTIVE',
  completedAt: new Date().toISOString(),
  transactionHash,
  blockNumber: receipt.blockNumber.toString(),
};
deployment.oracleActivation = {
  signerSetVerified: true,
  valuationDigest: digest,
  evidenceHash,
  nonce: nonce.toString(),
  validUntil: String(attestation.validUntil),
  acceptedTransaction: transactionHash,
};
deployment.transactions.publishInitialValuation = {
  txHash: transactionHash,
  blockNumber: receipt.blockNumber.toString(),
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  digest,
  nonce: nonce.toString(),
  transactionHash,
  evidencePath,
}, null, 2));
