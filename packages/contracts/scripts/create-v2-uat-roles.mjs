import { createCipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const wrappingKeyPath = join(secretsDirectory, 'v2-uat-roles.key');
const encryptedBundlePath = join(secretsDirectory, 'v2-uat-roles.enc.json');
const publicManifestPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.roles.json');

const roleNames = [
  'deployer',
  'owner',
  'factoryActivationOwner',
  'pauseGuardian',
  'feeTreasury',
  'oracleSigner1',
  'oracleSigner2',
  'oracleSigner3',
];

mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
chmodSync(secretsDirectory, 0o700);

const privateKeys = Object.fromEntries(roleNames.map((role) => [role, generatePrivateKey()]));
const roles = Object.fromEntries(roleNames.map((role) => [
  role,
  privateKeyToAccount(privateKeys[role]).address,
]));

const wrappingKey = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
const plaintext = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  environment: 'monad-testnet-v2-uat',
  createdAt: new Date().toISOString(),
  privateKeys,
}), 'utf8');
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();

writeFileSync(wrappingKeyPath, wrappingKey.toString('base64'), { flag: 'wx', mode: 0o600 });
writeFileSync(encryptedBundlePath, `${JSON.stringify({
  schemaVersion: 1,
  algorithm: 'aes-256-gcm',
  iv: iv.toString('base64'),
  authTag: authTag.toString('base64'),
  ciphertext: ciphertext.toString('base64'),
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
writeFileSync(publicManifestPath, `${JSON.stringify({
  schemaVersion: 1,
  environment: 'monad-testnet-v2-uat',
  createdAt: new Date().toISOString(),
  roles,
  security: {
    privateKeysPrinted: false,
    encryptedBundleIgnoredByGit: true,
    disposableTestnetOnly: true,
    productionApproved: false,
  },
}, null, 2)}\n`, { flag: 'wx', mode: 0o644 });

console.log(JSON.stringify({
  created: true,
  publicManifestPath,
  roles,
  instruction: 'Fund only deployer and factoryActivationOwner with Monad Testnet MON.',
}, null, 2));
