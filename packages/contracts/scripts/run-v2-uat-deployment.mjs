import { createDecipheriv } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

const EXECUTION_CONFIRMATION = 'DEPLOY_RWCAR_V2_TO_MONAD_TESTNET_10143';
const HACKATHON_EXECUTION_CONFIRMATION = 'REDEPLOY_RWCAR_V2_HACKATHON_UAT_ZERO_DELAY';
const HACKATHON_ZERO_DELAY_CONFIRMATION = 'ENABLE_ZERO_DELAY_ONLY_FOR_MONAD_HACKATHON_UAT';
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const wrappingKeyPath = join(secretsDirectory, 'v2-uat-roles.key');
const encryptedBundlePath = join(secretsDirectory, 'v2-uat-roles.enc.json');
const publicRolesPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.roles.json');
const v1ManifestPath = join(repositoryRoot, 'deployments', 'monad-testnet.json');
const deployScriptPath = join(repositoryRoot, 'packages/contracts/scripts/deploy-v2-uat.mjs');
const hackathonUat = process.argv.includes('--hackathon-uat');
const journalPath = join(
  secretsDirectory,
  hackathonUat ? 'v2-hackathon-redeployment.journal.jsonl' : 'v2-deployment.journal.jsonl',
);
const sharedDeploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2.json');

const execute = process.argv.includes('--execute');
if (execute && !process.argv.includes(`--confirm=${EXECUTION_CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${EXECUTION_CONFIRMATION}`);
}
if (execute && hackathonUat && !process.argv.includes(`--hackathon-confirm=${HACKATHON_EXECUTION_CONFIRMATION}`)) {
  throw new Error(`Hackathon UAT execution requires --hackathon-confirm=${HACKATHON_EXECUTION_CONFIRMATION}`);
}

const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  if (dirty) throw new Error('Refusing deployment from a dirty worktree; commit the reviewed source first');
}

const publicRoles = JSON.parse(readFileSync(publicRolesPath, 'utf8')).roles;
const encryptedBundle = JSON.parse(readFileSync(encryptedBundlePath, 'utf8'));
const wrappingKey = Buffer.from(readFileSync(wrappingKeyPath, 'utf8').trim(), 'base64');
const decipher = createDecipheriv(
  'aes-256-gcm',
  wrappingKey,
  Buffer.from(encryptedBundle.iv, 'base64'),
);
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const decrypted = Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]);
const privateKeys = JSON.parse(decrypted.toString('utf8')).privateKeys;

for (const [role, expectedAddress] of Object.entries(publicRoles)) {
  const actualAddress = privateKeyToAccount(privateKeys[role]).address;
  if (actualAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`Encrypted signer does not match the public ${role} address`);
  }
}

const v1 = JSON.parse(readFileSync(v1ManifestPath, 'utf8'));
const childEnvironment = {
  ...process.env,
  V2_DEPLOY_MODE: execute ? 'execute' : 'plan',
  V2_SOURCE_REVISION: revision,
  V2_DEPLOYER_ADDRESS: publicRoles.deployer,
  V2_OWNER_ADDRESS: publicRoles.owner,
  V2_FACTORY_ACTIVATION_OWNER: publicRoles.factoryActivationOwner,
  V2_PAUSE_GUARDIAN_ADDRESS: publicRoles.pauseGuardian,
  FEE_TREASURY_ADDRESS: publicRoles.feeTreasury,
  V2_ORACLE_SIGNER_1: publicRoles.oracleSigner1,
  V2_ORACLE_SIGNER_2: publicRoles.oracleSigner2,
  V2_ORACLE_SIGNER_3: publicRoles.oracleSigner3,
  CVA_ASSET_ADDRESS: v1.enabledCva,
  CVA_REFERENCE_HASH: v1.cvaReferenceHash,
  V2_SETTLEMENT_TOKEN_ADDRESS: v1.settlementToken,
  COMPLIANCE_VALIDATOR_ADDRESS: v1.complianceValidator,
  V2_ALLOWED_DURATIONS: '300',
  V2_ALLOW_EOA_OWNER: 'true',
  V2_ALLOW_ROLE_OVERLAP: 'false',
  ...(hackathonUat ? {
    V2_REUSE_SHARED_DEPLOYMENT_PATH: sharedDeploymentPath,
    V2_HACKATHON_UAT_ZERO_DELAY: 'true',
    V2_RISK_CONFIG_DELAY_SECONDS: '0',
  } : {}),
};
if (execute) {
  childEnvironment.V2_UAT_DEPLOYER_PRIVATE_KEY = privateKeys.deployer;
  childEnvironment.V2_DEPLOY_CONFIRM = EXECUTION_CONFIRMATION;
  childEnvironment.V2_KEY_ROTATION_ATTESTATION = 'FRESH_UAT_KEYS_NOT_PREVIOUSLY_SHARED';
  if (hackathonUat) childEnvironment.V2_HACKATHON_UAT_CONFIRM = HACKATHON_ZERO_DELAY_CONFIRMATION;
  if (existsSync(journalPath)) childEnvironment.V2_RESUME_JOURNAL_PATH = journalPath;
}

const child = spawn(process.execPath, [deployScriptPath], {
  cwd: repositoryRoot,
  env: childEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let journal = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => {
  journal += chunk;
  process.stderr.write(chunk);
});
const [exitCode] = await once(child, 'close');
if (journal) {
  writeFileSync(journalPath, journal, { mode: 0o600 });
}
if (exitCode !== 0) throw new Error(`V2 deployment process exited with code ${exitCode}`);

const manifest = JSON.parse(stdout);
const outputPath = join(
  repositoryRoot,
  'deployments',
  execute
    ? hackathonUat ? 'monad-testnet-v2-hackathon.json' : 'monad-testnet-v2.json'
    : hackathonUat ? 'monad-testnet-v2-hackathon.plan.json' : 'monad-testnet-v2.plan.json',
);
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, execute
  ? { flag: 'wx', mode: 0o644 }
  : { mode: 0o644 });
console.log(JSON.stringify({
  mode: execute ? 'execute' : 'plan',
  profile: hackathonUat ? 'MONAD_HACKATHON_UAT_ZERO_DELAY' : 'STANDARD_UAT',
  sourceRevision: revision,
  status: manifest.status,
  outputPath,
  contracts: manifest.contracts,
}, null, 2));
