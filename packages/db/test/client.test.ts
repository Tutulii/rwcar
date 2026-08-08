import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { databaseSsl } from '../src/client.js';

describe('database TLS policy', () => {
  it('disables TLS on Railway private networking and localhost in auto mode', () => {
    assert.equal(databaseSsl('postgresql://user:pass@postgres.railway.internal:5432/railway', 'auto'), false);
    assert.equal(databaseSsl('postgresql://user:pass@127.0.0.1:5432/rwcar', 'auto'), false);
  });

  it('requires certificate verification for public hosts in auto mode', () => {
    assert.deepEqual(databaseSsl('postgresql://user:pass@example.com:5432/rwcar', 'auto'), { rejectUnauthorized: true });
    assert.deepEqual(databaseSsl('postgresql://user:pass@example.com:5432/rwcar', 'require'), { rejectUnauthorized: false });
    assert.deepEqual(databaseSsl('postgresql://user:pass@example.com:5432/rwcar', 'verify-full'), { rejectUnauthorized: true });
  });

  it('rejects unknown modes', () => {
    assert.throws(() => databaseSsl('postgresql://user:pass@example.com/rwcar', 'maybe'), /DATABASE_SSL_MODE/);
  });
});
