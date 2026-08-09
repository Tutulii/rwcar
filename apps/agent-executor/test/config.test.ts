import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'test',
  AGENT_API_BASE_URL: 'http://rwcar-api.railway.internal:3001',
  AGENT_EXECUTOR_API_KEY: 'x'.repeat(48),
  PRIVY_APP_ID: 'app-test',
  PRIVY_APP_SECRET: 'secret-test',
  PRIVY_AGENT_SIGNER_ID: 'signer-test',
  PRIVY_AGENT_POLICY_ID: 'policy-test',
  PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS: JSON.stringify(['p'.repeat(64)]),
};

describe('agent executor configuration', () => {
  it('accepts an isolated private API endpoint and bounded signer material', () => {
    const config = loadConfig(valid);
    assert.equal(config.AGENT_API_BASE_URL, valid.AGENT_API_BASE_URL);
    assert.deepEqual(config.PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS, ['p'.repeat(64)]);
  });

  it('rejects missing or empty authorization keys', () => {
    assert.throws(() => loadConfig({ ...valid, PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS: '[]' }), /non-empty JSON array/);
    assert.throws(() => loadConfig({ ...valid, AGENT_EXECUTOR_API_KEY: 'short' }));
  });
});
