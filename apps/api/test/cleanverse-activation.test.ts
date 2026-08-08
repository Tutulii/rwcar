import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  cleanverseOwnerMessage,
  verifyCleanverseOwnerSignature,
} from '../src/services/cleanverse-activation.js';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const subject = '0x00000000000000000000000000000000000000A1' as const;

describe('Cleanverse activation signatures', () => {
  it('builds the documented lowercase chain-plus-address message', () => {
    assert.equal(
      cleanverseOwnerMessage('MONAD', subject),
      'monad0x00000000000000000000000000000000000000a1',
    );
  });

  it('accepts only a personal_sign signature from the live contract owner', async () => {
    const message = cleanverseOwnerMessage('monad', subject);
    const signature = await owner.signMessage({ message });
    assert.equal(
      (await verifyCleanverseOwnerSignature('monad', subject, owner.address, signature)).toLowerCase(),
      owner.address.toLowerCase(),
    );

    const wrongSignature = await other.signMessage({ message });
    await assert.rejects(
      verifyCleanverseOwnerSignature('monad', subject, owner.address, wrongSignature),
      /live contract owner/,
    );
  });
});
