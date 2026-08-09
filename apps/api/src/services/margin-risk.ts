import type { Address } from 'viem';
import type { ChainService, MarginAccountState, MarginMetadata } from './chain.js';
import { ceilDiv } from './economics.js';

type MarginRiskChain = Pick<ChainService, 'freshPrice' | 'marginAccount' | 'marginAccountLtv'>;
type MarginRiskMetadata = Pick<
  MarginMetadata,
  'asset' | 'assetDecimals' | 'settlementDecimals' | 'settlementToken' | 'valuationOracle'
>;

export type MarginRiskSnapshot = {
  liveAccount: MarginAccountState | null;
  liveCollateralValue: bigint | null;
  liveLtvBps: bigint | null;
  liveValuationPriceE18: bigint | null;
  liveValuationObservedAt: bigint | null;
  liveValuationDigest: `0x${string}` | null;
  liveRiskStatus: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
  liveRiskError: 'ACCOUNT_READ_UNAVAILABLE' | 'SIGNED_ORACLE_UNAVAILABLE' | 'LTV_READ_UNAVAILABLE' | null;
};

export function calculateMarginCollateralValue(
  collateralAmount: bigint,
  priceE18: bigint,
  assetDecimals: number,
  settlementDecimals: number,
) {
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 18
    || !Number.isInteger(settlementDecimals) || settlementDecimals < 0 || settlementDecimals > 18) {
    throw new RangeError('Margin asset and settlement decimals must be integers between zero and eighteen');
  }
  if (collateralAmount < 0n || priceE18 < 0n) throw new RangeError('Margin collateral and price cannot be negative');
  const valueE18 = collateralAmount * priceE18 / 10n ** BigInt(assetDecimals);
  return valueE18 * 10n ** BigInt(settlementDecimals) / 10n ** 18n;
}

export async function readMarginRiskSnapshot(
  chain: MarginRiskChain,
  engine: Address,
  accountId: bigint,
  metadata: MarginRiskMetadata | null,
): Promise<MarginRiskSnapshot> {
  const [accountResult, ltvResult] = await Promise.allSettled([
    chain.marginAccount(engine, accountId),
    chain.marginAccountLtv(engine, accountId),
  ]);
  const liveAccount = accountResult.status === 'fulfilled' ? accountResult.value : null;
  let liveLtvBps = ltvResult.status === 'fulfilled' ? ltvResult.value : null;
  let liveCollateralValue: bigint | null = null;
  let liveValuationPriceE18: bigint | null = null;
  let liveValuationObservedAt: bigint | null = null;
  let liveValuationDigest: `0x${string}` | null = null;
  let oracleUnavailable = false;

  if (liveAccount && metadata) {
    try {
      const valuation = await chain.freshPrice(
        metadata.valuationOracle,
        metadata.asset,
        metadata.settlementToken,
        liveAccount.maxOracleAge,
      );
      liveValuationPriceE18 = valuation.priceE18;
      liveValuationObservedAt = valuation.observedAt;
      liveValuationDigest = valuation.digest;
      liveCollateralValue = calculateMarginCollateralValue(
        liveAccount.collateralAmount,
        valuation.priceE18,
        metadata.assetDecimals,
        metadata.settlementDecimals,
      );
      if (liveLtvBps === null) {
        liveLtvBps = liveAccount.totalFaceDebt === 0n
          ? 0n
          : liveCollateralValue === 0n
            ? null
            : ceilDiv(liveAccount.totalFaceDebt * 10_000n, liveCollateralValue);
      }
    } catch {
      oracleUnavailable = true;
    }
  } else if (metadata) {
    oracleUnavailable = true;
  }

  const hasValue = liveCollateralValue !== null;
  const hasLtv = liveLtvBps !== null;
  const liveRiskStatus = hasValue && hasLtv ? 'AVAILABLE' : hasValue || hasLtv ? 'PARTIAL' : 'UNAVAILABLE';
  const liveRiskError = liveRiskStatus === 'AVAILABLE'
    ? null
    : liveAccount === null
      ? 'ACCOUNT_READ_UNAVAILABLE'
      : oracleUnavailable || metadata === null
        ? 'SIGNED_ORACLE_UNAVAILABLE'
        : 'LTV_READ_UNAVAILABLE';

  return {
    liveAccount,
    liveCollateralValue,
    liveLtvBps,
    liveValuationPriceE18,
    liveValuationObservedAt,
    liveValuationDigest,
    liveRiskStatus,
    liveRiskError,
  };
}

export async function enrichMarginRiskRows<T extends { accountId: string | number | bigint }>(
  chain: MarginRiskChain,
  engine: Address,
  rows: T[],
  metadata: MarginRiskMetadata | null,
  options: { includeLiveAccount?: boolean } = {},
) {
  const snapshots = await Promise.all(rows.map((row) => readMarginRiskSnapshot(
    chain,
    engine,
    BigInt(row.accountId),
    metadata,
  )));
  return rows.map((row, index) => {
    const snapshot = snapshots[index]!;
    return {
      ...row,
      liveCollateralValue: snapshot.liveCollateralValue,
      liveLtvBps: snapshot.liveLtvBps,
      liveValuationPriceE18: snapshot.liveValuationPriceE18,
      liveValuationObservedAt: snapshot.liveValuationObservedAt,
      liveValuationDigest: snapshot.liveValuationDigest,
      liveRiskStatus: snapshot.liveRiskStatus,
      liveRiskError: snapshot.liveRiskError,
      ...(options.includeLiveAccount ? { live: snapshot.liveAccount } : {}),
    };
  });
}
