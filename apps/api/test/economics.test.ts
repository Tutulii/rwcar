import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateDutchAuctionPrice,
  calculateEconomics,
  calculateFillEconomics,
  calculateLiquidationWaterfall,
  calculatePayoffEconomics,
  calculateProRataClaim,
  isStrictlyAfter,
  uniqueVaultAddresses,
} from '../src/services/economics.js';

describe('repo economics', () => {
  it('matches the Solidity ceiling-rounding policy', () => {
    assert.deepEqual(calculateEconomics(20_000n, 575, 300), {
      principal: '20000',
      openingFee: '30',
      sellerProceeds: '19970',
      interest: '1',
      repurchaseAmount: '20001',
    });
  });
});

describe('V2 economics', () => {
  it('conserves collateral dust and fees across partial fills', () => {
    const first = calculateFillEconomics({
      totalCollateral: 1_001n,
      targetPrincipal: 100_000n,
      remainingCollateral: 1_001n,
      remainingPrincipal: 100_000n,
      cumulativeFee: 0n,
      fillPrincipal: 33_333n,
    });
    const second = calculateFillEconomics({
      totalCollateral: 1_001n,
      targetPrincipal: 100_000n,
      remainingCollateral: BigInt(first.remainingCollateral),
      remainingPrincipal: BigInt(first.remainingPrincipal),
      cumulativeFee: BigInt(first.cumulativeFeeAfter),
      fillPrincipal: 66_667n,
    });
    assert.equal(BigInt(first.collateral) + BigInt(second.collateral), 1_001n);
    assert.equal(BigInt(first.openingFee) + BigInt(second.openingFee), 150n);
    assert.equal(second.remainingCollateral, '0');
    assert.equal(second.remainingPrincipal, '0');
  });

  it('rejects fills whose rounded fee consumes the fill', () => {
    assert.throws(() => calculateFillEconomics({
      totalCollateral: 1n,
      targetPrincipal: 1n,
      remainingCollateral: 1n,
      remainingPrincipal: 1n,
      cumulativeFee: 0n,
      fillPrincipal: 1n,
    }), /Opening fee/);
  });

  it('caps early compensation at scheduled interest and accrues default interest after maturity', () => {
    const early = calculatePayoffEconomics({
      principal: 1_000_000n,
      annualRateBps: 1_000,
      defaultRateBps: 1_500,
      acceptedAtSeconds: 0n,
      maturityAtSeconds: 31_536_000n,
      timestampSeconds: 1n,
      earlyRepurchaseEnabled: true,
      minimumHoldSeconds: 3_153_600,
      breakFeeBps: 10,
    });
    assert.equal(early.early, true);
    assert.ok(BigInt(early.contractualInterest) <= 100_000n);
    const late = calculatePayoffEconomics({
      principal: 1_000_000n,
      annualRateBps: 1_000,
      defaultRateBps: 1_500,
      acceptedAtSeconds: 0n,
      maturityAtSeconds: 31_536_000n,
      timestampSeconds: 31_536_100n,
      earlyRepurchaseEnabled: true,
      minimumHoldSeconds: 0,
      breakFeeBps: 0,
    });
    assert.ok(BigInt(late.defaultInterest) > 0n);
  });

  it('uses a monotonic bounded Dutch auction curve', () => {
    assert.equal(calculateDutchAuctionPrice(1_000n, 800n, 100n, 200n, 100n), 1_000n);
    assert.equal(calculateDutchAuctionPrice(1_000n, 800n, 100n, 200n, 150n), 900n);
    assert.equal(calculateDutchAuctionPrice(1_000n, 800n, 100n, 200n, 250n), 800n);
  });

  it('conserves the liquidation waterfall for surplus and shortfall cases', () => {
    const surplus = calculateLiquidationWaterfall(1_200n, 1_000n, 100);
    assert.equal(surplus.lenderProceeds + surplus.liquidationFee + surplus.sellerSurplus, 1_200n);
    assert.equal(surplus.lenderShortfall, 0n);
    const shortfall = calculateLiquidationWaterfall(800n, 1_000n, 100);
    assert.equal(shortfall.lenderProceeds + shortfall.liquidationFee + shortfall.sellerSurplus, 800n);
    assert.equal(shortfall.lenderShortfall, 200n);
  });

  it('assigns deterministic pro-rata claims and all rounding dust to the final claimant', () => {
    const first = calculateProRataClaim(1_001n, 1_001n, 1n, 3n, 3);
    const second = calculateProRataClaim(1_001n, 1_001n - first, 1n, 3n, 2);
    const final = calculateProRataClaim(1_001n, 1_001n - first - second, 1n, 3n, 1);
    assert.equal(first + second + final, 1_001n);
  });

  it('uses strict on-chain boundary semantics', () => {
    assert.equal(isStrictlyAfter(100n, 100n), false);
    assert.equal(isStrictlyAfter(101n, 100n), true);
  });

  it('keeps every per-asset vault while normalizing duplicate addresses', () => {
    assert.deepEqual(uniqueVaultAddresses([
      '0x00000000000000000000000000000000000000AA',
      '0x00000000000000000000000000000000000000bb',
      '0x00000000000000000000000000000000000000aa',
    ]), [
      '0x00000000000000000000000000000000000000aa',
      '0x00000000000000000000000000000000000000bb',
    ]);
  });
});
