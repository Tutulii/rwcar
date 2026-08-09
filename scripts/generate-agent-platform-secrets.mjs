import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateP256KeyPair } from '@privy-io/node';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, '.secrets');
const output = join(directory, 'agent-platform.json');
const rotate = process.argv.includes('--rotate');

if (existsSync(output) && !rotate) {
  throw new Error(`${output} already exists. Refusing to overwrite it; pass --rotate only during an approved key-rotation procedure.`);
}

mkdirSync(directory, { recursive: true, mode: 0o700 });
const jwtPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwtPrivateJwk = jwtPair.privateKey.export({ format: 'jwk' });
const authorization = await generateP256KeyPair();
const generated = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  jwt: {
    keyId: `rwcar-agent-es256-${new Date().toISOString().slice(0, 10)}`,
    privateJwk: jwtPrivateJwk,
  },
  executorApiKey: randomBytes(48).toString('base64url'),
  privyAuthorization: {
    publicKey: authorization.publicKey,
    privateKey: authorization.privateKey,
    signerId: '',
    policyId: '',
  },
};

writeFileSync(output, `${JSON.stringify(generated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
chmodSync(output, 0o600);
process.stdout.write(`Prepared protected agent platform material in ${output}.\n`);
process.stdout.write('Register the stored Privy public key, create the reviewed deny-by-default policy, then fill signerId and policyId in that file. No secret value was printed.\n');
