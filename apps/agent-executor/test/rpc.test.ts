import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decimalToRpcQuantity } from '../src/rpc.js';

describe('Privy transaction RPC quantities', () => {
  it('serializes zero as the canonical hex quantity required by Privy', () => {
    assert.equal(decimalToRpcQuantity('0'), '0x0');
  });

  it('serializes non-zero and large decimal values without precision loss', () => {
    assert.equal(decimalToRpcQuantity('15'), '0xf');
    assert.equal(decimalToRpcQuantity('1000000000000000000'), '0xde0b6b3a7640000');
  });

  it('rejects values outside the executor database representation', () => {
    assert.throws(() => decimalToRpcQuantity('-1'), /unsigned decimal integer/);
    assert.throws(() => decimalToRpcQuantity('0x0'), /unsigned decimal integer/);
    assert.throws(() => decimalToRpcQuantity(''), /unsigned decimal integer/);
  });
});
