import { createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'FUND_RWCAR_V2_UAT_OPERATIONAL_ROLES';
const CHAIN_ID = 10_143;
const SOURCE_RESERVE = parseEther('1');
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const deploymentFilename = process.argv.find((argument) => argument.startsWith('--deployment='))
  ?.slice('--deployment='.length) || 'monad-testnet-v2.json';
if (!['monad-testnet-v2.json', 'monad-testnet-v2-hackathon.json'].includes(deploymentFilename)) {
  throw new Error('Unsupported deployment manifest');
}
const deploymentStem = deploymentFilename.slice(0, -'.json'.length);
const deploymentPath = join(repositoryRoot, 'deployments', deploymentFilename);
const evidencePath = join(repositoryRoot, 'deployments', `${deploymentStem}.role-funding.json`);
const secretsDirectory = join(repositoryRoot, '.secrets');
const execute = process.argv.includes('--execute');

if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing operational-role funding from a dirty worktree');
}

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const encryptedBundle = JSON.parse(readFileSync(join(secretsDirectory, 'v2-uat-roles.enc.json'), 'utf8'));
const wrappingKey = Buffer.from(readFileSync(join(secretsDirectory, 'v2-uat-roles.key'), 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const privateKeys = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8')).privateKeys;
const sourceAccount = privateKeyToAccount(privateKeys.factoryActivationOwner);
if (sourceAccount.address.toLowerCase() !== deployment.roles.factoryActivationOwner.toLowerCase()) {
  throw new Error('Factory activation funding signer mismatch');
}

const targets = [
  { key: 'pendingOwner', address: deployment.roles.pendingOwner, minimum: parseEther('1') },
  { key: 'pauseGuardian', address: deployment.roles.pauseGuardian, minimum: parseEther('0.1') },
  { key: 'feeTreasury', address: deployment.roles.feeTreasury, minimum: parseEther('0.1') },
  ...(deployment.roles.keeper
    ? [{ key: 'keeper', address: deployment.roles.keeper, minimum: parseEther('0.25') }]
    : []),
];
if (new Set(targets.map(({ address }) => address.toLowerCase())).size !== targets.length) {
  throw new Error('Operational funding targets must be distinct');
}
if (targets.some(({ address }) => address.toLowerCase() === sourceAccount.address.toLowerCase())) {
  throw new Error('Factory activation signer cannot be an operational funding target');
}

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const transport = http(network.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: network, transport });
const walletClient = createWalletClient({ account: sourceAccount, chain: network, transport });
const balances = new Map(await Promise.all(targets.map(async (target) => [
  target.key,
  await publicClient.getBalance({ address: target.address }),
])));
const sourceBalance = await publicClient.getBalance({ address: sourceAccount.address });
const plan = targets.map((target) => {
  const current = balances.get(target.key) ?? 0n;
  return { ...target, current, topUp: current < target.minimum ? target.minimum - current : 0n };
});
const totalTopUp = plan.reduce((total, target) => total + target.topUp, 0n);
if (sourceBalance - totalTopUp < SOURCE_RESERVE) {
  throw new Error(`Funding would breach the ${formatEther(SOURCE_RESERVE)} MON factory activation reserve`);
}

const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: execute ? 'EXECUTING' : 'PREPARED_NOT_SUBMITTED',
  chainId: CHAIN_ID,
  source: sourceAccount.address,
  sourceBalanceMON: formatEther(sourceBalance),
  sourceReserveMON: formatEther(SOURCE_RESERVE),
  targets: plan.map(({ key, address, current, minimum, topUp }) => ({
    key,
    address,
    currentMON: formatEther(current),
    minimumMON: formatEther(minimum),
    topUpMON: formatEther(topUp),
  })),
};
if (!execute) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

const transactions = {};
for (const target of plan) {
  if (target.topUp === 0n) {
    transactions[target.key] = { alreadyFunded: true };
    continue;
  }
  const hash = await walletClient.sendTransaction({ to: target.address, value: target.topUp });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${target.key} funding reverted: ${hash}`);
  const finalBalance = await publicClient.getBalance({ address: target.address });
  if (finalBalance < target.minimum) throw new Error(`${target.key} remains below its minimum after funding`);
  transactions[target.key] = {
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    amountMON: formatEther(target.topUp),
    finalBalanceMON: formatEther(finalBalance),
  };
}
const finalSourceBalance = await publicClient.getBalance({ address: sourceAccount.address });
if (finalSourceBalance < SOURCE_RESERVE) throw new Error('Factory activation reserve was breached after gas costs');

const evidence = {
  ...publicPlan,
  status: 'FUNDED',
  completedAt: new Date().toISOString(),
  finalSourceBalanceMON: formatEther(finalSourceBalance),
  transactions,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
deployment.operationalRoleFunding = {
  source: sourceAccount.address,
  sourceReserveMON: formatEther(SOURCE_RESERVE),
  finalSourceBalanceMON: formatEther(finalSourceBalance),
  transactions,
};
for (const [key, transaction] of Object.entries(transactions)) {
  if (transaction.txHash) deployment.transactions[`fund${key[0].toUpperCase()}${key.slice(1)}`] = transaction;
}
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  finalSourceBalanceMON: evidence.finalSourceBalanceMON,
  transactions,
  evidencePath,
}, null, 2));
