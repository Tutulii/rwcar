import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ApiConfig } from '../src/config.js';
import { CleanverseClient } from '../src/services/cleanverse.js';

const key = Buffer.alloc(32, 7).toString('base64');
const config = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: 3001,
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://localhost/rwcar',
  MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz',
  CLEANVERSE_BASE_URL: 'https://cleanverse.invalid/api/cooperate',
  CLEANVERSE_API_ID: 'test-id',
  CLEANVERSE_API_KEY: key,
  PRIVY_APP_ID: 'test-app',
  PRIVY_APP_SECRET: 'test-secret',
  INDEXER_CONFIRMATIONS: 3,
  COMPLIANCE_CACHE_SECONDS: 30,
  VALUATION_SIGNERS: '',
  S3_REGION: 'auto',
} satisfies ApiConfig;

describe('Cleanverse adapter', () => {
  it('uses AES-CBC with the documented zero IV envelope', () => {
    const client = new CleanverseClient(config);
    const encrypted = client.encryptBody({ chain: 'monad', amount: '1' });
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.alloc(16));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
    assert.deepEqual(JSON.parse(plaintext), { chain: 'monad', amount: '1' });
  });

  it('retries transient upstream responses and parses active A-Pass state', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ message: 'busy' }), { status: 503 });
      return new Response(JSON.stringify({ code: '0000', data: { status: 1, tier: '2', subTier: 1, countries: ['SG'], group: 'FI', expirationTime: Math.floor(Date.now() / 1000) + 3600 } }), { status: 200 });
    };
    const client = new CleanverseClient(config, fetcher as typeof fetch);
    const apass = await client.queryApass('monad', '0x0000000000000000000000000000000000000001');
    assert.equal(calls, 3);
    assert.equal(apass.active, true);
    assert.equal(apass.tier, 2);
    assert.equal(apass.subTier, 1);
    assert.deepEqual(apass.countries, ['SG']);
    assert.equal(apass.group, 'FI');
    assert.match(apass.expiresAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('binds an issued application to its chain/token and fails closed on missing pause state', async () => {
    const address = '0x0000000000000000000000000000000000000001';
    const good = new CleanverseClient(config, (async () => new Response(JSON.stringify({
      code: '0000',
      data: { applyStatus: 'ISSUED', chain: 'monad', atokenAddress: address, isPaused: false },
    }), { status: 200 })) as typeof fetch);
    assert.deepEqual(await good.queryAssetApplication('request-1'), {
      issued: true,
      paused: false,
      pauseKnown: true,
      status: 'ISSUED',
      chain: 'monad',
      tokenAddress: address,
      raw: { applyStatus: 'ISSUED', chain: 'monad', atokenAddress: address, isPaused: false },
    });

    const unknownPause = new CleanverseClient(config, (async () => new Response(JSON.stringify({
      code: '0000', data: { applyStatus: 'ISSUED', chain: 'monad', atokenAddress: address },
    }), { status: 200 })) as typeof fetch);
    const application = await unknownPause.queryAssetApplication('request-2');
    assert.equal(application.paused, true);
    assert.equal(application.pauseKnown, false);
  });

  it('matches only the exact nested A-Token in the supported-token registry', async () => {
    const target = '0x00000000000000000000000000000000000000a1';
    const other = '0x00000000000000000000000000000000000000b2';
    const client = new CleanverseClient(config, (async () => new Response(JSON.stringify({
      code: '0000',
      data: {
        tokens: [
          { origin_token: { address: target }, atoken: { address: other, symbol: 'aOTHER' } },
          { origin_token: { address: other }, atoken: { address: target.toUpperCase().replace('0X', '0x'), symbol: 'aUSDC' } },
        ],
      },
    }), { status: 200 })) as typeof fetch);

    const supported = await client.querySupportedAsset('monad', target);
    assert.equal(supported?.chain, 'monad');
    assert.equal(supported?.tokenAddress, target);
    assert.equal((supported?.raw.atoken as Record<string, unknown>).symbol, 'aUSDC');
    assert.equal(await client.querySupportedAsset('monad', '0x00000000000000000000000000000000000000c3'), null);
  });

  it('encrypts the documented validator registrar grant and requires a transaction hash', async () => {
    const factory = '0x00000000000000000000000000000000000000f1';
    const signature = `0x${'ab'.repeat(65)}`;
    let plaintext: Record<string, unknown> | undefined;
    let requestedUrl = '';
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      const envelope = JSON.parse(String(init?.body)) as { data: string };
      const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.alloc(16));
      const decoded = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      plaintext = JSON.parse(decoded) as Record<string, unknown>;
      return new Response(JSON.stringify({
        code: '0000', data: { chain: 'monad', address: factory, tx_hash: `0x${'12'.repeat(32)}` },
      }), { status: 200 });
    };
    const client = new CleanverseClient(config, fetcher as typeof fetch);
    const result = await client.grantValidatorRegistrar('monad', factory, signature);
    assert.equal(requestedUrl, `${config.CLEANVERSE_BASE_URL}/validator/grant`);
    assert.deepEqual(plaintext, { chain: 'monad', address: factory, owner_signature: signature });
    assert.equal(result.txHash, `0x${'12'.repeat(32)}`);

    const missingHash = new CleanverseClient(config, (async () => new Response(JSON.stringify({
      code: '0000', data: { chain: 'monad', address: factory },
    }), { status: 200 })) as typeof fetch);
    await assert.rejects(missingHash.grantValidatorRegistrar('monad', factory, signature), /transaction hash/);
  });
});
