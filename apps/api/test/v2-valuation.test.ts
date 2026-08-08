import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signedValuationOracleAbi } from '@rwcar/shared';
import { decodeFunctionData, encodeFunctionData, hashTypedData } from 'viem';
import { buildV2ValuationTypedData } from '../src/routes/internal.js';

describe('V2 signed valuation utility', () => {
  it('builds the canonical oracle EIP-712 domain/message and submit calldata', () => {
    const oracle = '0x0000000000000000000000000000000000000001' as const;
    const attestation = {
      asset: '0x0000000000000000000000000000000000000002' as const,
      settlementToken: '0x0000000000000000000000000000000000000003' as const,
      priceE18: 1_250_000_000_000_000_000n,
      observedAt: 100n,
      validUntil: 200n,
      nonce: 7n,
      evidenceHash: `0x${'ab'.repeat(32)}` as const,
    };
    const typedData = buildV2ValuationTypedData(oracle, attestation);
    assert.equal(typedData.domain.name, 'RWCAR Signed Valuation Oracle');
    assert.equal(typedData.domain.version, '2');
    assert.match(hashTypedData(typedData), /^0x[0-9a-f]{64}$/);
    const signature = `0x${'11'.repeat(65)}` as const;
    const data = encodeFunctionData({ abi: signedValuationOracleAbi, functionName: 'submit', args: [attestation, [signature, signature]] });
    const decoded = decodeFunctionData({ abi: signedValuationOracleAbi, data });
    assert.equal(decoded.functionName, 'submit');
    assert.equal(decoded.args[0].nonce, 7n);
  });
});
