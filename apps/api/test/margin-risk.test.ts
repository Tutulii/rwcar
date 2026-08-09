import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MarginAccountState } from '../src/services/chain.js';
import { calculateMarginCollateralValue, readMarginRiskSnapshot } from '../src/services/margin-risk.js';

const engine = '0x0000000000000000000000000000000000000001' as const;
const asset = '0x0000000000000000000000000000000000000002' as const;
const settlementToken = '0x0000000000000000000000000000000000000003' as const;
const valuationOracle = '0x0000000000000000000000000000000000000004' as const;
const digest = `0x${'11'.repeat(32)}` as const;
const metadata = { asset, settlementToken, valuationOracle, assetDecimals: 6, settlementDecimals: 6 };

function fundedAccount(overrides: Partial<MarginAccountState> = {}): MarginAccountState {
  return {
    seller: '0x0000000000000000000000000000000000000005',
    permittedLender: '0x0000000000000000000000000000000000000000',
    collateralAmount: 1_000_000n,
    fundingTarget: 20_000n,
    minimumFunding: 10_000n,
    totalFunded: 20_000n,
    totalFaceDebt: 20_001n,
    feeCharged: 30n,
    frozenDebt: 0n,
    liquidationProceeds: 0n,
    remainingProceeds: 0n,
    remainingCollateral: 0n,
    marginCallDeadline: 0n,
    defaultDeclaredAt: 0n,
    fundingDuration: 300n,
    fundingExpiry: 1_786_293_466n,
    maxOracleAge: 3_600n,
    auctionDuration: 1_800n,
    marginCallPeriod: 3_600n,
    staleOracleFallbackDelay: 86_400n,
    activeExposureCount: 1,
    unclaimedExposureCount: 0,
    maxAnnualRateBps: 800,
    initialLtvBps: 7_000,
    maintenanceLtvBps: 8_000,
    liquidationLtvBps: 8_500,
    auctionStartBps: 10_500,
    auctionFloorBps: 8_000,
    liquidationFeeBps: 50,
    paymentDefaultDeclared: false,
    inKindCloseout: false,
    fundingClosed: true,
    status: 1,
    auctionId: 0n,
    claimPoolId: 0n,
    closeoutValuationDigest: `0x${'00'.repeat(32)}`,
    ...overrides,
  };
}

describe('live margin risk projection', () => {
  it('values one six-decimal CVA at the signed one-aUSDC price', () => {
    assert.equal(calculateMarginCollateralValue(1_000_000n, 10n ** 18n, 6, 6), 1_000_000n);
  });

  it('returns the contract LTV and signed collateral value for a funded account', async () => {
    const snapshot = await readMarginRiskSnapshot({
      marginAccount: async () => fundedAccount(),
      marginAccountLtv: async () => 201n,
      freshPrice: async () => ({ priceE18: 10n ** 18n, observedAt: 1_786_293_500n, digest }),
    }, engine, 4n, metadata);
    assert.equal(snapshot.liveCollateralValue, 1_000_000n);
    assert.equal(snapshot.liveLtvBps, 201n);
    assert.equal(snapshot.liveRiskStatus, 'AVAILABLE');
    assert.equal(snapshot.liveRiskError, null);
  });

  it('reconstructs the exact rounded-up LTV if the redundant contract LTV read fails', async () => {
    const snapshot = await readMarginRiskSnapshot({
      marginAccount: async () => fundedAccount(),
      marginAccountLtv: async () => { throw new Error('temporary RPC failure'); },
      freshPrice: async () => ({ priceE18: 10n ** 18n, observedAt: 1_786_293_500n, digest }),
    }, engine, 4n, metadata);
    assert.equal(snapshot.liveCollateralValue, 1_000_000n);
    assert.equal(snapshot.liveLtvBps, 201n);
    assert.equal(snapshot.liveRiskStatus, 'AVAILABLE');
  });

  it('returns unavailable values instead of a misleading zero when live risk reads fail', async () => {
    const snapshot = await readMarginRiskSnapshot({
      marginAccount: async () => fundedAccount(),
      marginAccountLtv: async () => { throw new Error('oracle stale'); },
      freshPrice: async () => { throw new Error('oracle stale'); },
    }, engine, 4n, metadata);
    assert.equal(snapshot.liveCollateralValue, null);
    assert.equal(snapshot.liveLtvBps, null);
    assert.equal(snapshot.liveRiskStatus, 'UNAVAILABLE');
    assert.equal(snapshot.liveRiskError, 'SIGNED_ORACLE_UNAVAILABLE');
  });
});
