import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { marginEngineV2Abi } from '@rwcar/shared';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { normalizeMarginAction, settlementClaimPolicyPool } from '../src/services/v2-preflight.js';

describe('V2 margin adapter', () => {
  it('normalizes UI aliases to the locked engine actions', () => {
    assert.equal(normalizeMarginAction('DEPOSIT_COLLATERAL'), 'DEPOSIT');
    assert.equal(normalizeMarginAction('WITHDRAW_AVAILABLE'), 'WITHDRAW');
    assert.equal(normalizeMarginAction('REPAY_EXPOSURE'), 'REPAY');
    assert.equal(normalizeMarginAction('START_LIQUIDATION'), 'LIQUIDATE');
    assert.equal(normalizeMarginAction('MATERIALIZE_LIQUIDATION_CLAIM'), 'MATERIALIZE_LIQUIDATION_CLAIM');
  });

  it('encodes materializeLiquidationClaim and never the obsolete claim adapter', () => {
    const data = encodeFunctionData({
      abi: marginEngineV2Abi,
      functionName: 'materializeLiquidationClaim',
      args: [77n],
    });
    const decoded = decodeFunctionData({ abi: marginEngineV2Abi, data });
    assert.equal(decoded.functionName, 'materializeLiquidationClaim');
    assert.deepEqual(decoded.args, [77n]);
    assert.equal(marginEngineV2Abi.some((item) => item.type === 'function' && item.name === 'claimLiquidationProceeds'), false);
  });

  it('namespaces colliding claim IDs by their proven escrow and policy pool', () => {
    const repoMarket = '0x0000000000000000000000000000000000000001' as const;
    const repoEscrow = '0x0000000000000000000000000000000000000002' as const;
    const marginEngine = '0x0000000000000000000000000000000000000003' as const;
    const marginEscrow = '0x0000000000000000000000000000000000000004' as const;
    assert.equal(settlementClaimPolicyPool(repoEscrow, repoMarket, repoEscrow, marginEngine, marginEscrow), repoMarket);
    assert.equal(settlementClaimPolicyPool(marginEscrow, repoMarket, repoEscrow, marginEngine, marginEscrow), marginEngine);
    assert.equal(settlementClaimPolicyPool('0x0000000000000000000000000000000000000005', repoMarket, repoEscrow, marginEngine, marginEscrow), undefined);
  });
});
