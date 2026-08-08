import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const required = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/rwcar',
  CLEANVERSE_API_ID: 'test-id',
  CLEANVERSE_API_KEY: Buffer.alloc(32, 1).toString('base64'),
  PRIVY_APP_ID: 'test-app',
  PRIVY_APP_SECRET: 'test-secret',
};

describe('API configuration', () => {
  it('uses Railway PORT when API_PORT is not explicitly configured', () => {
    assert.equal(loadConfig({ ...required, PORT: '8080' }).API_PORT, 8080);
  });

  it('keeps an explicit API_PORT ahead of the platform PORT', () => {
    assert.equal(loadConfig({ ...required, PORT: '8080', API_PORT: '3001' }).API_PORT, 3001);
  });
});
