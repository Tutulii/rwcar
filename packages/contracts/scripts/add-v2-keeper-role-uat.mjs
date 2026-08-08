import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'ADD_RWCAR_V2_UAT_PERMISSIONLESS_KEEPER';
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const encryptedBundlePath = join(secretsDirectory, 'v2-uat-roles.enc.json');
const wrappingKeyPath = join(secretsDirectory, 'v2-uat-roles.key');
const rolesPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.roles.json');
const deploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.json');
const evidencePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.keeper.json');
const execute = process.argv.includes('--execute');

if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing keeper creation from a dirty worktree');
}
for (const path of [encryptedBundlePath, wrappingKeyPath]) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must have mode 0600`);
}

const encryptedBundle = JSON.parse(readFileSync(encryptedBundlePath, 'utf8'));
const wrappingKey = Buffer.from(readFileSync(wrappingKeyPath, 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const decrypted = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8'));
const publicRoles = JSON.parse(readFileSync(rolesPath, 'utf8'));
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));

const existingKey = decrypted.privateKeys.keeper;
const existingAddress = existingKey ? privateKeyToAccount(existingKey).address : null;
const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: existingAddress ? 'ALREADY_CREATED' : execute ? 'EXECUTING' : 'READY_NOT_SUBMITTED',
  environment: 'monad-testnet-v2-uat',
  role: 'keeper',
  permissionlessOnly: true,
  protocolPrivileges: [],
  address: existingAddress,
};
if (!execute || existingAddress) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

const keeperPrivateKey = generatePrivateKey();
const keeperAddress = privateKeyToAccount(keeperPrivateKey).address;
const criticalAddresses = Object.values(publicRoles.roles).map((address) => address.toLowerCase());
if (criticalAddresses.includes(keeperAddress.toLowerCase())) throw new Error('Generated keeper overlaps a critical role');

decrypted.privateKeys.keeper = keeperPrivateKey;
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(decrypted), 'utf8')), cipher.final()]);
writeFileSync(encryptedBundlePath, `${JSON.stringify({
  schemaVersion: encryptedBundle.schemaVersion,
  algorithm: 'aes-256-gcm',
  iv: iv.toString('base64'),
  authTag: cipher.getAuthTag().toString('base64'),
  ciphertext: ciphertext.toString('base64'),
}, null, 2)}\n`, { mode: 0o600 });

publicRoles.roles.keeper = keeperAddress;
publicRoles.security.keeperPermissionlessOnly = true;
deployment.roles.keeper = keeperAddress;
const evidence = {
  ...publicPlan,
  status: 'CREATED_UNFUNDED',
  address: keeperAddress,
  createdAt: new Date().toISOString(),
};
writeFileSync(rolesPath, `${JSON.stringify(publicRoles, null, 2)}\n`, { mode: 0o644 });
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  keeper: keeperAddress,
  privateKeyPrinted: false,
  encryptedBundleUpdated: true,
  evidencePath,
}, null, 2));
