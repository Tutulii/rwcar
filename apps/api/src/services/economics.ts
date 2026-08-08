import { BPS_DENOMINATOR, PROTOCOL_FEE_BPS, SECONDS_PER_YEAR } from '@rwcar/shared';

export function ceilDiv(numerator: bigint, denominator: bigint) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export type FillEconomicsInput = {
  totalCollateral: bigint;
  targetPrincipal: bigint;
  remainingCollateral: bigint;
  remainingPrincipal: bigint;
  cumulativeFee: bigint;
  fillPrincipal: bigint;
  protocolFeeBps?: number;
};

export function calculateFillEconomics(input: FillEconomicsInput) {
  if (input.fillPrincipal <= 0n || input.fillPrincipal > input.remainingPrincipal) {
    throw new RangeError('Fill principal is outside the offer remainder');
  }
  if (input.targetPrincipal <= 0n || input.totalCollateral <= 0n) {
    throw new RangeError('Offer totals must be positive');
  }
  const filledBefore = input.targetPrincipal - input.remainingPrincipal;
  const collateralAllocatedBefore = input.totalCollateral - input.remainingCollateral;
  const filledAfter = filledBefore + input.fillPrincipal;
  const collateralAllocatedAfter = input.fillPrincipal === input.remainingPrincipal
    ? input.totalCollateral
    : input.totalCollateral * filledAfter / input.targetPrincipal;
  const collateral = collateralAllocatedAfter - collateralAllocatedBefore;
  const feeBps = BigInt(input.protocolFeeBps ?? PROTOCOL_FEE_BPS);
  const cumulativeFeeAfter = ceilDiv(filledAfter * feeBps, BigInt(BPS_DENOMINATOR));
  const openingFee = cumulativeFeeAfter - input.cumulativeFee;
  if (openingFee >= input.fillPrincipal) throw new RangeError('Opening fee must be smaller than the fill principal');
  return {
    principal: input.fillPrincipal.toString(),
    collateral: collateral.toString(),
    openingFee: openingFee.toString(),
    sellerProceeds: (input.fillPrincipal - openingFee).toString(),
    remainingPrincipal: (input.remainingPrincipal - input.fillPrincipal).toString(),
    remainingCollateral: (input.remainingCollateral - collateral).toString(),
    cumulativeFeeAfter: cumulativeFeeAfter.toString(),
  };
}

export type PayoffEconomicsInput = {
  principal: bigint;
  annualRateBps: number;
  defaultRateBps: number;
  acceptedAtSeconds: bigint;
  maturityAtSeconds: bigint;
  timestampSeconds: bigint;
  earlyRepurchaseEnabled: boolean;
  minimumHoldSeconds: number;
  breakFeeBps: number;
};

export function calculatePayoffEconomics(input: PayoffEconomicsInput) {
  const denominator = BigInt(BPS_DENOMINATOR * SECONDS_PER_YEAR);
  const fullTerm = input.maturityAtSeconds - input.acceptedAtSeconds;
  const fullTermInterest = ceilDiv(input.principal * BigInt(input.annualRateBps) * fullTerm, denominator);
  let contractualInterest = fullTermInterest;
  let breakFee = 0n;
  let defaultInterest = 0n;
  let early = false;

  if (input.timestampSeconds < input.maturityAtSeconds) {
    if (!input.earlyRepurchaseEnabled) throw new RangeError('Early repurchase is disabled');
    early = true;
    const actualElapsed = input.timestampSeconds > input.acceptedAtSeconds
      ? input.timestampSeconds - input.acceptedAtSeconds
      : 0n;
    const accruedSeconds = actualElapsed > BigInt(input.minimumHoldSeconds)
      ? actualElapsed
      : BigInt(input.minimumHoldSeconds);
    const accrued = ceilDiv(input.principal * BigInt(input.annualRateBps) * accruedSeconds, denominator);
    breakFee = ceilDiv(input.principal * BigInt(input.breakFeeBps), BigInt(BPS_DENOMINATOR));
    contractualInterest = accrued + breakFee < fullTermInterest ? accrued + breakFee : fullTermInterest;
  } else if (input.timestampSeconds > input.maturityAtSeconds) {
    defaultInterest = ceilDiv(
      input.principal * BigInt(input.defaultRateBps) * (input.timestampSeconds - input.maturityAtSeconds),
      denominator,
    );
  }

  return {
    principal: input.principal.toString(),
    contractualInterest: contractualInterest.toString(),
    defaultInterest: defaultInterest.toString(),
    breakFee: breakFee.toString(),
    payoff: (input.principal + contractualInterest + defaultInterest).toString(),
    early,
  };
}

export function calculateDutchAuctionPrice(
  startPrice: bigint,
  floorPrice: bigint,
  startsAtSeconds: bigint,
  endsAtSeconds: bigint,
  timestampSeconds: bigint,
) {
  if (endsAtSeconds <= startsAtSeconds || startPrice < floorPrice) throw new RangeError('Invalid auction curve');
  if (timestampSeconds <= startsAtSeconds) return startPrice;
  if (timestampSeconds >= endsAtSeconds) return floorPrice;
  const elapsed = timestampSeconds - startsAtSeconds;
  const duration = endsAtSeconds - startsAtSeconds;
  return startPrice - (startPrice - floorPrice) * elapsed / duration;
}

export function calculateLiquidationWaterfall(price: bigint, frozenDebt: bigint, liquidationFeeBps: number) {
  if (price < 0n || frozenDebt < 0n || liquidationFeeBps < 0 || liquidationFeeBps > BPS_DENOMINATOR) {
    throw new RangeError('Invalid liquidation waterfall input');
  }
  const lenderProceeds = price < frozenDebt ? price : frozenDebt;
  const remainder = price - lenderProceeds;
  const feeTarget = ceilDiv(price * BigInt(liquidationFeeBps), BigInt(BPS_DENOMINATOR));
  const liquidationFee = remainder < feeTarget ? remainder : feeTarget;
  return {
    grossProceeds: price,
    lenderProceeds,
    liquidationFee,
    sellerSurplus: remainder - liquidationFee,
    lenderShortfall: frozenDebt - lenderProceeds,
  };
}

export function calculateProRataClaim(
  totalPool: bigint,
  remainingPool: bigint,
  claimantWeight: bigint,
  totalWeight: bigint,
  unclaimedCount: number,
) {
  if (totalPool < 0n || remainingPool < 0n || claimantWeight <= 0n || totalWeight <= 0n || unclaimedCount <= 0) {
    throw new RangeError('Invalid pro-rata claim input');
  }
  const amount = unclaimedCount === 1 ? remainingPool : totalPool * claimantWeight / totalWeight;
  if (amount <= 0n || amount > remainingPool) throw new RangeError('Pro-rata claim is outside the remaining pool');
  return amount;
}

export const isStrictlyAfter = (chainTimestamp: bigint, boundary: bigint) => chainTimestamp > boundary;

export function uniqueVaultAddresses(addresses: Array<string | null | undefined>) {
  return [...new Set(addresses.flatMap((value) => value ? [value.toLowerCase()] : []))];
}

export function calculateEconomics(principal: bigint, annualRateBps: number, durationSeconds: number) {
  const openingFee = ceilDiv(principal * BigInt(PROTOCOL_FEE_BPS), BigInt(BPS_DENOMINATOR));
  const interest = ceilDiv(
    principal * BigInt(annualRateBps) * BigInt(durationSeconds),
    BigInt(BPS_DENOMINATOR * SECONDS_PER_YEAR),
  );
  return {
    principal: principal.toString(),
    openingFee: openingFee.toString(),
    sellerProceeds: (principal - openingFee).toString(),
    interest: interest.toString(),
    repurchaseAmount: (principal + interest).toString(),
  };
}
