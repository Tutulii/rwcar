import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK, type JWK_EC_Private } from 'jose';
import { keccak256, recoverTypedDataAddress, stringToHex, type Address, type Hex } from 'viem';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 32;

function scrypt(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(secret, salt, SCRYPT_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    }, (error, derived) => error ? reject(error) : resolve(derived as Buffer));
  });
}

export async function hashClientSecret(secret: string) {
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyClientSecret(secret: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== String(SCRYPT_N) || r !== String(SCRYPT_R)
    || p !== String(SCRYPT_P) || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = await scrypt(secret, Buffer.from(saltValue, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateCredential() {
  return {
    clientId: `rwcar_${randomBytes(18).toString('base64url')}`,
    clientSecret: `rwcar_secret_${randomBytes(36).toString('base64url')}`,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function canonicalHash(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

export type AgentTokenClaims = {
  agentId: string;
  institutionId: string;
  wallet: Address;
  scopes: string[];
  credentialId: string;
  expiresAt?: number;
};

export class AgentJwtService {
  private readonly privateKey: Promise<CryptoKey>;
  private readonly verificationKey: Promise<CryptoKey>;
  private readonly publicJwk: Promise<JWK>;

  constructor(private readonly config: ApiConfig) {
    if (!config.AGENT_JWT_PRIVATE_JWK) throw new Error('Agent JWT signing key is not configured');
    const jwk = JSON.parse(config.AGENT_JWT_PRIVATE_JWK) as JWK_EC_Private;
    this.privateKey = importJWK(jwk, 'ES256') as Promise<CryptoKey>;
    // Imported WebCrypto private keys are intentionally non-extractable. A
    // private EC JWK already contains x/y, so derive discovery material from
    // the validated input and remove the private scalar without exporting it.
    const { d: _privateScalar, ...publicKey } = jwk;
    this.publicJwk = Promise.resolve({
      ...publicKey,
      kid: config.AGENT_JWT_KEY_ID,
      alg: 'ES256',
      use: 'sig',
    });
    this.verificationKey = importJWK(publicKey, 'ES256') as Promise<CryptoKey>;
  }

  async jwks() {
    return { keys: [await this.publicJwk] };
  }

  async sign(claims: AgentTokenClaims) {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({
      institution_id: claims.institutionId,
      wallet: claims.wallet,
      scopes: claims.scopes,
      credential_id: claims.credentialId,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.config.AGENT_JWT_KEY_ID, typ: 'at+jwt' })
      .setIssuer(this.config.AGENT_ISSUER_URL)
      .setAudience(this.config.AGENT_AUDIENCE)
      .setSubject(claims.agentId)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + this.config.AGENT_TOKEN_TTL_SECONDS)
      .setJti(randomBytes(16).toString('hex'))
      .sign(await this.privateKey);
  }

  async verify(token: string): Promise<AgentTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, await this.verificationKey, {
        issuer: this.config.AGENT_ISSUER_URL,
        audience: this.config.AGENT_AUDIENCE,
        algorithms: ['ES256'],
      });
      if (!payload.sub || typeof payload.institution_id !== 'string' || typeof payload.wallet !== 'string'
        || !/^0x[a-fA-F0-9]{40}$/.test(payload.wallet) || !Array.isArray(payload.scopes)
        || !payload.scopes.every((scope) => typeof scope === 'string') || typeof payload.credential_id !== 'string') {
        throw new Error('Malformed claims');
      }
      return {
        agentId: payload.sub,
        institutionId: payload.institution_id,
        wallet: payload.wallet.toLowerCase() as Address,
        scopes: payload.scopes as string[],
        credentialId: payload.credential_id,
        ...(payload.exp ? { expiresAt: payload.exp } : {}),
      };
    } catch {
      throw new AppError(401, 'INVALID_AGENT_TOKEN', 'The agent access token is invalid or expired');
    }
  }
}

const domain = (market: Address) => ({
  name: 'RWCAR Agent Authority',
  version: '1',
  chainId: 10_143,
  verifyingContract: market,
} as const);

export const mandateTypes = {
  AgentMandate: [
    { name: 'agentId', type: 'string' },
    { name: 'agentWallet', type: 'address' },
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'constraintsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'startsAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function mandateTypedData(market: Address, input: {
  agentId: string;
  agentWallet: Address;
  manifestHash: Hex;
  constraintsHash: Hex;
  nonce: bigint;
  startsAt: number;
  expiresAt: number;
}) {
  return {
    domain: domain(market),
    types: mandateTypes,
    primaryType: 'AgentMandate' as const,
    message: { ...input, startsAt: BigInt(input.startsAt), expiresAt: BigInt(input.expiresAt) },
  };
}

export async function recoverMandateSigner(market: Address, input: Parameters<typeof mandateTypedData>[1], signature: Hex) {
  return recoverTypedDataAddress({ ...mandateTypedData(market, input), signature });
}

export const walletBindingTypes = {
  AgentWalletBinding: [
    { name: 'agentId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'privyWalletIdHash', type: 'bytes32' },
    { name: 'signerIdHash', type: 'bytes32' },
    { name: 'policyIdHash', type: 'bytes32' },
    { name: 'signedAt', type: 'uint64' },
  ],
} as const;

export function walletBindingTypedData(market: Address, input: {
  agentId: string;
  wallet: Address;
  privyWalletId: string;
  signerId: string;
  policyId: string;
  signedAt: number;
}) {
  return {
    domain: domain(market),
    types: walletBindingTypes,
    primaryType: 'AgentWalletBinding' as const,
    message: {
      agentId: input.agentId,
      wallet: input.wallet,
      privyWalletIdHash: canonicalHash(input.privyWalletId),
      signerIdHash: canonicalHash(input.signerId),
      policyIdHash: canonicalHash(input.policyId),
      signedAt: BigInt(input.signedAt),
    },
  };
}

export const intentApprovalTypes = {
  AgentIntentApproval: [
    { name: 'intentId', type: 'string' },
    { name: 'intentHash', type: 'bytes32' },
    { name: 'decision', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function intentApprovalTypedData(market: Address, input: {
  intentId: string;
  intentHash: Hex;
  decision: 'APPROVE' | 'REJECT';
  expiresAt: number;
}) {
  return {
    domain: domain(market),
    types: intentApprovalTypes,
    primaryType: 'AgentIntentApproval' as const,
    message: { ...input, expiresAt: BigInt(input.expiresAt) },
  };
}
