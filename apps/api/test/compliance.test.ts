import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { RwcarDb } from '@rwcar/db';
import { CONTRACTS, MONAD_TESTNET } from '@rwcar/shared';
import type { Address } from 'viem';
import type { ApiConfig } from '../src/config.js';
import type { ChainService } from '../src/services/chain.js';
import type { CleanverseClient } from '../src/services/cleanverse.js';
import { ComplianceService } from '../src/services/compliance.js';

const config = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: 3001,
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://localhost/rwcar',
  MONAD_RPC_URL: MONAD_TESTNET.rpcUrl,
  CLEANVERSE_BASE_URL: 'https://cleanverse.invalid/api/cooperate',
  CLEANVERSE_API_ID: 'test-id',
  CLEANVERSE_API_KEY: Buffer.alloc(32, 7).toString('base64'),
  PRIVY_APP_ID: 'test-app',
  PRIVY_APP_SECRET: 'test-secret',
  V2_SETTLEMENT_TOKEN_ADDRESS: CONTRACTS.aUsdc,
  INDEXER_CONFIRMATIONS: 3,
  COMPLIANCE_CACHE_SECONDS: 30,
  VALUATION_SIGNERS: '',
  S3_REGION: 'auto',
} satisfies ApiConfig;

const wallet = '0x0000000000000000000000000000000000000001' as Address;
const pool = '0x0000000000000000000000000000000000000002' as Address;

function databaseStub() {
  const rows: unknown[] = [];
  return {
    rows,
    db: {
      insert: () => ({ values: async (value: unknown) => { rows.push(value); } }),
    } as unknown as RwcarDb,
  };
}

function apassClient(overrides: Partial<CleanverseClient> = {}) {
  return {
    queryApass: async () => ({
      active: true,
      tier: 30,
      subTier: 0,
      status: 1,
      expiresAt: '2030-01-01T00:00:00.000Z',
      group: null,
      subGroup: null,
      countries: [],
      raw: { status: 1 },
    }),
    verifyApass: async () => ({ code: 4, allowed: true, raw: { code: 4 } }),
    ...overrides,
  } as unknown as CleanverseClient;
}

describe('Compliance settlement-token proof', () => {
  it('accepts missing request ID only for the exact configured settlement A-Token', async () => {
    const { db, rows } = databaseStub();
    const cleanverse = apassClient({
      querySupportedAsset: async () => ({
        chain: MONAD_TESTNET.cleanverseChain,
        tokenAddress: CONTRACTS.aUsdc.toLowerCase(),
        raw: { atoken: { address: CONTRACTS.aUsdc } },
      }),
    } as Partial<CleanverseClient>);
    const chain = {
      tokenPolicyState: async () => ({ policy: pool, paused: false }),
      poolEligible: async () => true,
    } as unknown as ChainService;
    const service = new ComplianceService(config, db, cleanverse, chain);

    const result = await service.verify(wallet, CONTRACTS.aUsdc, undefined, randomUUID(), pool);
    assert.equal(result.assetIssued, true);
    assert.equal(result.assetPaused, false);
    assert.equal(result.cviActive, true);
    assert.equal(result.verificationCode, 4);
    assert.equal(result.poolEligible, true);
    assert.equal(rows.length, 1);

    await assert.rejects(
      service.verify(wallet, '0x0000000000000000000000000000000000000003', undefined, randomUUID(), pool),
      /No Cleanverse request identifier/,
    );
  });

  it('fails closed when the supported-token registry does not bind the settlement address', async () => {
    const { db } = databaseStub();
    const cleanverse = apassClient({
      querySupportedAsset: async () => null,
    } as Partial<CleanverseClient>);
    const chain = {
      tokenPolicyState: async () => ({ policy: pool, paused: false }),
      poolEligible: async () => true,
    } as unknown as ChainService;
    const result = await new ComplianceService(config, db, cleanverse, chain)
      .verify(wallet, CONTRACTS.aUsdc, undefined, randomUUID(), pool);
    assert.equal(result.assetIssued, false);
    assert.equal(result.assetPaused, true);
  });
});

describe('Compliance issued-asset proof', () => {
  it('uses the live token policy when apply status omits pause state', async () => {
    const asset = '0x0000000000000000000000000000000000000003' as Address;
    const { db, rows } = databaseStub();
    const cleanverse = apassClient({
      queryAssetApplication: async () => ({
        issued: true,
        paused: true,
        pauseKnown: false,
        status: 'ISSUED',
        chain: MONAD_TESTNET.cleanverseChain,
        tokenAddress: asset.toLowerCase(),
        raw: { applyStatus: 'ISSUED', chain: 'monad', atokenAddress: asset },
      }),
    } as Partial<CleanverseClient>);
    const chain = {
      tokenPolicyState: async () => ({ policy: pool, paused: false }),
      poolEligible: async () => true,
    } as unknown as ChainService;

    const result = await new ComplianceService(config, db, cleanverse, chain)
      .verify(wallet, asset, 'request-1', randomUUID(), pool);

    assert.equal(result.assetIssued, true);
    assert.equal(result.assetPaused, false);
    assert.equal(result.poolEligible, true);
    assert.equal(rows.length, 1);
  });

  it('fails closed when the live token policy cannot be read', async () => {
    const asset = '0x0000000000000000000000000000000000000003' as Address;
    const { db } = databaseStub();
    const cleanverse = apassClient({
      queryAssetApplication: async () => ({
        issued: true,
        paused: true,
        pauseKnown: false,
        status: 'ISSUED',
        chain: MONAD_TESTNET.cleanverseChain,
        tokenAddress: asset.toLowerCase(),
        raw: { applyStatus: 'ISSUED', chain: 'monad', atokenAddress: asset },
      }),
    } as Partial<CleanverseClient>);
    const chain = {
      tokenPolicyState: async () => { throw new Error('RPC unavailable'); },
      poolEligible: async () => true,
    } as unknown as ChainService;

    const result = await new ComplianceService(config, db, cleanverse, chain)
      .verify(wallet, asset, 'request-1', randomUUID(), pool);

    assert.equal(result.assetIssued, true);
    assert.equal(result.assetPaused, true);
  });
});
