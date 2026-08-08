import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivityQuerySchema } from '../src/routes/public.js';
import { REPO_LIFECYCLE_EVENTS } from '../src/services/store.js';

describe('public activity feed', () => {
  it('defaults to four rows and accepts an optional wallet', () => {
    assert.deepEqual(ActivityQuerySchema.parse({}), { limit: 4 });
    assert.deepEqual(ActivityQuerySchema.parse({
      wallet: '0x0000000000000000000000000000000000000001',
      limit: '12',
    }), {
      wallet: '0x0000000000000000000000000000000000000001',
      limit: 12,
    });
  });

  it('rejects limits outside the public one-to-twenty range', () => {
    assert.equal(ActivityQuerySchema.safeParse({ limit: '0' }).success, false);
    assert.equal(ActivityQuerySchema.safeParse({ limit: '21' }).success, false);
  });

  it('contains lifecycle events without duplicating acceptance fee events', () => {
    assert.deepEqual(REPO_LIFECYCLE_EVENTS, [
      'OfferCreated',
      'OfferAccepted',
      'RepoRepaid',
      'RepoDefaulted',
      'OfferCancelled',
      'OfferExpired',
    ]);
    assert.equal(REPO_LIFECYCLE_EVENTS.includes('ProtocolFeePaid' as never), false);
  });
});
