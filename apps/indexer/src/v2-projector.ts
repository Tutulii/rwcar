import {
  auctionSettlements,
  auctions,
  automationJobs,
  chainEvents,
  marginAccounts,
  marginCalls,
  marginExposures,
  marginLiquidations,
  oracleValuations,
  riskConfigurations,
  settlementClaims,
  v2Offers,
  v2Positions,
  vaultBalances,
  vaultLedgerEntries,
  type RwcarDb,
} from '@rwcar/db';
import { and, eq, sql } from 'drizzle-orm';
import { hexToString, keccak256, stringToHex } from 'viem';

type RwcarTransaction = Parameters<Parameters<RwcarDb['transaction']>[0]>[0];

export type V2ProjectableEvent = {
  module: string;
  eventName: string;
  args: Record<string, unknown>;
  chainId: number;
  contractAddress: string;
  marketAddress: string;
  settlementToken: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

const address = (value: unknown) => String(value).toLowerCase();
const numberString = (value: unknown) => BigInt(value as bigint | string | number).toString();
const integer = (value: unknown) => Number(BigInt(value as bigint | string | number));
const date = (value: unknown) => new Date(integer(value) * 1000);
const zeroAddress = '0x0000000000000000000000000000000000000000';
const common = (event: V2ProjectableEvent) => ({
  lastTxHash: event.transactionHash,
  lastBlockNumber: event.blockNumber,
  updatedAt: new Date(Number(event.blockTimestamp) * 1000),
});

function requiredArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined || value === null) {
    throw new Error(`OfferFilled projection requires ${name}; refusing to persist incomplete immutable terms`);
  }
  return value;
}

/** Extracts the immutable risk/oracle snapshot carried by the final OfferFilled event. */
export function offerFilledPositionSnapshot(args: Record<string, unknown>) {
  const openingValuationDigest = String(requiredArg(args, 'openingValuationDigest'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(openingValuationDigest)) {
    throw new Error('OfferFilled projection requires a bytes32 openingValuationDigest');
  }
  return {
    defaultRateBps: integer(requiredArg(args, 'defaultAnnualRateBps')),
    liquidationFeeBps: integer(requiredArg(args, 'liquidationFeeBps')),
    auctionStartBps: integer(requiredArg(args, 'auctionStartBps')),
    auctionFloorBps: integer(requiredArg(args, 'auctionFloorBps')),
    auctionDurationSeconds: integer(requiredArg(args, 'auctionDuration')),
    maxOracleAgeSeconds: integer(requiredArg(args, 'maxOracleAge')),
    staleOracleFallbackDelaySeconds: integer(requiredArg(args, 'staleOracleFallbackDelay')),
    openingValuationDigest,
  };
}

const bucketHashes = new Map<string, string>([
  [keccak256(stringToHex('AVAILABLE')).toLowerCase(), 'AVAILABLE'],
  [keccak256(stringToHex('OFFER_RESERVED')).toLowerCase(), 'OFFER_RESERVED'],
  [keccak256(stringToHex('POSITION_LOCKED')).toLowerCase(), 'POSITION_LOCKED'],
  [keccak256(stringToHex('AUCTION_LOCKED')).toLowerCase(), 'AUCTION_LOCKED'],
  [keccak256(stringToHex('MARGIN_LOCKED')).toLowerCase(), 'MARGIN_LOCKED'],
]);

function bucketName(value: unknown) {
  const name = bucketHashes.get(String(value).toLowerCase());
  if (!name) throw new Error(`Unknown vault bucket ${String(value)}`);
  return name as 'AVAILABLE' | 'OFFER_RESERVED' | 'POSITION_LOCKED' | 'AUCTION_LOCKED' | 'MARGIN_LOCKED';
}

export function bytes32Label(value: unknown) {
  const raw = String(value);
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    if (/^0x0{64}$/i.test(raw)) return 'NONE';
    try {
      const decoded = hexToString(raw as `0x${string}`, { size: 32 }).replace(/\0+$/g, '');
      if (/^[\x20-\x7e]{1,32}$/.test(decoded)) return decoded;
    } catch {
      // Preserve unknown bytes32 markers as database-safe hex evidence.
    }
    return raw.toLowerCase();
  }
  const safe = raw.replace(/\0/g, '');
  return safe || 'NONE';
}

async function scheduleJob(
  db: RwcarTransaction,
  event: V2ProjectableEvent,
  action: string,
  resourceType: string,
  resourceId: string,
  scheduledFor: Date,
) {
  await db.insert(automationJobs).values({
    chainId: event.chainId,
    contractAddress: event.marketAddress,
    action,
    resourceType,
    resourceId,
    scheduledFor,
    nextAttemptAt: scheduledFor,
    metadata: { protocolVersion: 'v2' },
  }).onConflictDoUpdate({
    target: [
      automationJobs.chainId,
      automationJobs.contractAddress,
      automationJobs.action,
      automationJobs.resourceType,
      automationJobs.resourceId,
    ],
    set: {
      scheduledFor: sql`least(${automationJobs.scheduledFor}, excluded.scheduled_for)`,
      nextAttemptAt: sql`case when ${automationJobs.status} in ('PENDING', 'RETRY') then least(${automationJobs.nextAttemptAt}, excluded.next_attempt_at) else ${automationJobs.nextAttemptAt} end`,
      updatedAt: new Date(),
    },
  });
}

async function cancelJob(db: RwcarTransaction, event: V2ProjectableEvent, action: string, resourceType: string, resourceId: string) {
  await db.update(automationJobs).set({ status: 'CANCELLED', completedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(automationJobs.chainId, event.chainId),
    eq(automationJobs.contractAddress, event.marketAddress),
    eq(automationJobs.action, action),
    eq(automationJobs.resourceType, resourceType),
    eq(automationJobs.resourceId, resourceId),
  ));
}

async function cancelMarginAccountJobs(db: RwcarTransaction, event: V2ProjectableEvent, accountId: string) {
  await Promise.all([
    cancelJob(db, event, 'startMarginLiquidation', 'margin_account', accountId),
    cancelJob(db, event, 'startInKindOracleFallback', 'margin_account', accountId),
  ]);
}

async function cancelMarginExposureDefaultJobs(db: RwcarTransaction, event: V2ProjectableEvent, accountId: string) {
  const exposures = await db.select({ exposureId: marginExposures.exposureId }).from(marginExposures).where(and(
    eq(marginExposures.chainId, event.chainId),
    eq(marginExposures.marginEngineAddress, event.contractAddress),
    eq(marginExposures.accountId, accountId),
    eq(marginExposures.status, 'ACTIVE'),
  ));
  await Promise.all(exposures.map((exposure) =>
    cancelJob(db, event, 'declarePaymentDefault', 'margin_exposure', exposure.exposureId)));
}

export async function projectV2Event(db: RwcarTransaction, event: V2ProjectableEvent) {
  const args = event.args;
  if (event.module === 'REPO_MARKET') await projectMarket(db, event, args);
  else if (event.module === 'COLLATERAL_VAULT' && event.eventName === 'VaultBalanceChanged') await projectVault(db, event, args);
  else if (event.module === 'DUTCH_AUCTION') await projectAuction(db, event, args);
  else if (event.module === 'SETTLEMENT_ESCROW') await projectClaim(db, event, args);
  else if (event.module === 'VALUATION_ORACLE') await projectValuation(db, event, args);
  else if (event.module === 'RISK_MANAGER') await projectRisk(db, event, args);
  else if (event.module === 'MARGIN_ENGINE') await projectMargin(db, event, args);
}

const marginStatus = (value: unknown) => {
  const statuses = ['NONE', 'HEALTHY', 'MARGIN_CALL', 'LIQUIDATING', 'LIQUIDATED', 'AUCTION_FAILED', 'CLOSED'] as const;
  const status = statuses[integer(value)];
  if (!status || status === 'NONE') throw new Error(`Unknown margin account status ${String(value)}`);
  return status;
};

function marginSnapshotValues(args: Record<string, unknown>) {
  const value = requiredArg(args, 'accountSnapshot');
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Margin event requires named accountSnapshot');
  const snapshot = value as Record<string, unknown>;
  const nullableDate = (timestamp: unknown) => integer(timestamp) === 0 ? null : date(timestamp);
  return {
    owner: address(snapshot.seller),
    permittedLender: address(snapshot.permittedLender) === zeroAddress ? null : address(snapshot.permittedLender),
    collateralAmount: numberString(snapshot.collateralAmount),
    fundingTarget: numberString(snapshot.fundingTarget),
    minimumFunding: numberString(snapshot.minimumFunding),
    fundingDurationSeconds: integer(snapshot.fundingDuration),
    fundingExpiry: nullableDate(snapshot.fundingExpiry),
    maxAnnualRateBps: integer(snapshot.maxAnnualRateBps),
    fundingClosed: Boolean(snapshot.fundingClosed),
    totalFunded: numberString(snapshot.totalFunded),
    totalDebt: numberString(snapshot.totalFaceDebt),
    feeCharged: numberString(snapshot.feeCharged),
    frozenDebt: numberString(snapshot.frozenDebt),
    liquidationProceeds: numberString(snapshot.liquidationProceeds),
    remainingProceeds: numberString(snapshot.remainingProceeds),
    remainingCollateral: numberString(snapshot.remainingCollateral),
    marginCallDeadline: nullableDate(snapshot.marginCallDeadline),
    defaultDeclaredAt: nullableDate(snapshot.defaultDeclaredAt),
    maxOracleAgeSeconds: integer(snapshot.maxOracleAge),
    auctionDurationSeconds: integer(snapshot.auctionDuration),
    marginCallPeriodSeconds: integer(snapshot.marginCallPeriod),
    staleOracleFallbackDelaySeconds: integer(snapshot.staleOracleFallbackDelay),
    activeExposureCount: integer(snapshot.activeExposureCount),
    unclaimedExposureCount: integer(snapshot.unclaimedExposureCount),
    initialLtvBps: integer(snapshot.initialLtvBps),
    maintenanceLtvBps: integer(snapshot.maintenanceLtvBps),
    liquidationLtvBps: integer(snapshot.liquidationLtvBps),
    auctionStartBps: integer(snapshot.auctionStartBps),
    auctionFloorBps: integer(snapshot.auctionFloorBps),
    liquidationFeeBps: integer(snapshot.liquidationFeeBps),
    paymentDefaultDeclared: Boolean(snapshot.paymentDefaultDeclared),
    inKindCloseout: Boolean(snapshot.inKindCloseout),
    status: marginStatus(snapshot.status),
    auctionId: numberString(snapshot.auctionId) === '0' ? null : numberString(snapshot.auctionId),
    claimPoolId: numberString(snapshot.claimPoolId) === '0' ? null : numberString(snapshot.claimPoolId),
    closeoutValuationDigest: String(snapshot.closeoutValuationDigest),
  };
}

async function projectMarket(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  const offerWhere = args.offerId === undefined ? undefined : and(
    eq(v2Offers.chainId, event.chainId), eq(v2Offers.marketAddress, event.marketAddress), eq(v2Offers.offerId, numberString(args.offerId)),
  );
  const positionWhere = args.positionId === undefined ? undefined : and(
    eq(v2Positions.chainId, event.chainId), eq(v2Positions.marketAddress, event.marketAddress), eq(v2Positions.positionId, numberString(args.positionId)),
  );
  const blockTime = new Date(Number(event.blockTimestamp) * 1000);

  if (event.eventName === 'OfferCreated') {
    const duration = integer(args.duration);
    const minHoldBps = integer(args.earlyMinHoldBps ?? 0);
    await db.insert(v2Offers).values({
      chainId: event.chainId,
      marketAddress: event.marketAddress,
      offerId: numberString(args.offerId),
      seller: address(args.seller),
      permittedBuyer: address(args.permittedBuyer) === zeroAddress ? null : address(args.permittedBuyer),
      assetAddress: address(args.asset),
      settlementToken: event.settlementToken,
      totalCollateral: numberString(args.collateralAmount),
      remainingCollateral: numberString(args.collateralAmount),
      targetPrincipal: numberString(args.targetPrincipal),
      remainingPrincipal: numberString(args.targetPrincipal),
      minimumFill: numberString(args.minimumFill),
      annualRateBps: integer(args.annualRateBps),
      defaultRateBps: integer(args.defaultAnnualRateBps ?? args.annualRateBps),
      durationSeconds: duration,
      offerExpiry: date(args.offerExpiry),
      gracePeriodSeconds: integer(args.gracePeriod ?? args.gracePeriodSeconds),
      earlyRepurchaseEnabled: Boolean(args.earlyRepurchaseEnabled),
      minimumHoldSeconds: Math.floor(duration * minHoldBps / 10_000),
      breakFeeBps: integer(args.earlyBreakFeeBps ?? 0),
      valuationHash: String(args.valuationDigest),
      status: 'OPEN',
      createTxHash: event.transactionHash,
      ...common(event),
    }).onConflictDoNothing();
    await scheduleJob(db, event, 'finalizeOfferExpiry', 'offer', numberString(args.offerId), new Date(date(args.offerExpiry).getTime() + 1_000));
    return;
  }

  if (event.eventName === 'OfferFilled' && offerWhere) {
    const [offer] = await db.select().from(v2Offers).where(offerWhere).limit(1);
    if (!offer) throw new Error(`Offer projection missing for fill ${numberString(args.offerId)}`);
    const principal = BigInt(numberString(args.principal));
    const collateral = BigInt(numberString(args.collateral));
    const fee = BigInt(numberString(args.fee));
    const positionSnapshot = offerFilledPositionSnapshot(args);
    const remainingPrincipal = BigInt(offer.remainingPrincipal) - principal;
    const remainingCollateral = BigInt(offer.remainingCollateral) - collateral;
    await db.update(v2Offers).set({
      remainingPrincipal: remainingPrincipal.toString(),
      remainingCollateral: remainingCollateral.toString(),
      cumulativeFee: (BigInt(offer.cumulativeFee) + fee).toString(),
      status: remainingPrincipal === 0n ? 'FILLED' : 'PARTIALLY_FILLED',
      ...common(event),
    }).where(offerWhere);
    await db.insert(v2Positions).values({
      chainId: event.chainId,
      marketAddress: event.marketAddress,
      positionId: numberString(args.positionId),
      offerId: offer.offerId,
      seller: offer.seller,
      buyer: address(args.buyer),
      assetAddress: offer.assetAddress,
      settlementToken: offer.settlementToken,
      principal: principal.toString(),
      collateral: collateral.toString(),
      openingFee: fee.toString(),
      annualRateBps: offer.annualRateBps,
      ...positionSnapshot,
      acceptedAt: blockTime,
      maturityAt: date(args.maturity),
      repaymentDeadline: date(args.repaymentDeadline),
      status: 'ACTIVE',
      ...common(event),
    }).onConflictDoNothing();
    await scheduleJob(db, event, 'startAuction', 'position', numberString(args.positionId), new Date(date(args.repaymentDeadline).getTime() + 1_000));
    return;
  }

  if ((event.eventName === 'OfferCancelled' || event.eventName === 'OfferExpired') && offerWhere) {
    await db.update(v2Offers).set({
      status: event.eventName === 'OfferCancelled' ? 'CANCELLED' : 'EXPIRED',
      remainingCollateral: '0',
      closedAt: blockTime,
      ...common(event),
    }).where(offerWhere);
    await cancelJob(db, event, 'finalizeOfferExpiry', 'offer', numberString(args.offerId));
    return;
  }

  if (event.eventName === 'PositionRepaid' && positionWhere) {
    await db.update(v2Positions).set({ status: 'REPAID', payoffAmount: numberString(args.payoff), closedAt: blockTime, ...common(event) }).where(positionWhere);
    await cancelJob(db, event, 'startAuction', 'position', numberString(args.positionId));
    return;
  }
  if (event.eventName === 'PositionDefaulted' && positionWhere) {
    await db.update(v2Positions).set({
      status: 'AUCTION', auctionId: numberString(args.auctionId), frozenDebt: numberString(args.frozenDebt),
      defaultValuationDigest: String(args.valuationDigest), debtFrozenAt: blockTime, ...common(event),
    }).where(positionWhere);
    await db.update(auctions).set({ frozenDebt: numberString(args.frozenDebt), updatedAt: blockTime }).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.marketAddress),
      eq(auctions.positionId, numberString(args.positionId)),
      eq(auctions.auctionId, numberString(args.auctionId)),
    ));
    await db.update(auctions).set({ valuationDigest: String(args.valuationDigest), updatedAt: blockTime }).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.marketAddress),
      eq(auctions.auctionId, numberString(args.auctionId)),
    ));
    await cancelJob(db, event, 'startAuction', 'position', numberString(args.positionId));
    return;
  }
  if (event.eventName === 'PositionLiquidated' && positionWhere) {
    await db.update(v2Positions).set({ status: 'LIQUIDATED', closedAt: blockTime, ...common(event) }).where(positionWhere);
    const [auction] = await db.select().from(auctions).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.marketAddress),
      eq(auctions.auctionId, numberString(args.auctionId)),
    )).limit(1);
    if (auction) {
      await db.insert(auctionSettlements).values({
        chainId: event.chainId,
        auctionAddress: auction.auctionAddress,
        auctionId: numberString(args.auctionId),
        buyer: address(args.buyer),
        grossProceeds: numberString(args.salePrice),
        lenderProceeds: numberString(args.lenderPaid),
        protocolCost: numberString(args.feePaid),
        sellerSurplus: numberString(args.sellerSurplus),
        lenderShortfall: numberString(args.shortfall),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        settledAt: blockTime,
      }).onConflictDoNothing();
    }
    return;
  }
  if (event.eventName === 'AuctionFailed' && positionWhere) {
    await db.update(v2Positions).set({ status: 'AUCTION_FAILED', ...common(event) }).where(positionWhere);
    return;
  }
  if ((event.eventName === 'DefaultCollateralClaimed' || event.eventName === 'StaleOracleCollateralClaimed') && positionWhere) {
    await db.update(v2Positions).set({ status: 'COLLATERAL_CLAIMED', closedAt: blockTime, ...common(event) }).where(positionWhere);
  }
}

async function projectVault(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  const bucket = bucketName(args.bucket);
  const account = address(args.account);
  const assetAddress = address(args.asset);
  const balanceAfter = numberString(args.balanceAfter);
  await db.insert(vaultBalances).values({
    chainId: event.chainId,
    vaultAddress: event.contractAddress,
    account,
    assetAddress,
    bucket,
    amount: balanceAfter,
    lastBlockNumber: event.blockNumber,
    updatedAt: new Date(Number(event.blockTimestamp) * 1000),
  }).onConflictDoUpdate({
    target: [vaultBalances.chainId, vaultBalances.vaultAddress, vaultBalances.account, vaultBalances.assetAddress, vaultBalances.bucket],
    set: { amount: balanceAfter, lastBlockNumber: event.blockNumber, updatedAt: new Date(Number(event.blockTimestamp) * 1000) },
  });
  await db.insert(vaultLedgerEntries).values({
    chainId: event.chainId,
    vaultAddress: event.contractAddress,
    account,
    assetAddress,
    bucket,
    delta: numberString(args.delta),
    balanceAfter,
    referenceType: bytes32Label(args.referenceType),
    referenceId: numberString(args.referenceId),
    reason: bytes32Label(args.reason),
    txHash: event.transactionHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    occurredAt: new Date(Number(event.blockTimestamp) * 1000),
  }).onConflictDoNothing();
}

async function projectAuction(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  const auctionId = numberString(args.auctionId);
  const where = and(eq(auctions.chainId, event.chainId), eq(auctions.auctionAddress, event.contractAddress), eq(auctions.auctionId, auctionId));
  const blockTime = new Date(Number(event.blockTimestamp) * 1000);
  if (event.eventName === 'AuctionStarted') {
    const referenceId = numberString(args.referenceId);
    const referenceKind = integer(args.referenceKind);
    if (referenceKind === 2) {
      const [account] = await db.select().from(marginAccounts).where(and(
        eq(marginAccounts.chainId, event.chainId),
        eq(marginAccounts.marginEngineAddress, event.marketAddress),
        eq(marginAccounts.accountId, referenceId),
      )).limit(1);
      if (!account) throw new Error(`AuctionStarted projection missing margin account ${referenceId}`);
      await db.insert(auctions).values({
        chainId: event.chainId,
        auctionAddress: event.contractAddress,
        auctionId,
        marketAddress: event.marketAddress,
        marginAccountId: referenceId,
        seller: account.owner,
        lender: null,
        assetAddress: account.assetAddress,
        settlementToken: account.settlementToken,
        collateralAmount: numberString(args.assetAmount),
        frozenDebt: account.frozenDebt,
        liquidationFeeBps: account.liquidationFeeBps,
        valuationId: null,
        valuationDigest: account.closeoutValuationDigest,
        startPrice: numberString(args.startPrice),
        floorPrice: numberString(args.floorPrice),
        startsAt: blockTime,
        endsAt: date(args.endsAt),
        status: 'OPEN',
        ...common(event),
      }).onConflictDoNothing();
      await scheduleJob(db, event, 'finalizeFailedMarginAuction', 'margin_auction', auctionId, new Date(date(args.endsAt).getTime() + 1_000));
      return;
    }
    const [position] = await db.select().from(v2Positions).where(and(
      eq(v2Positions.chainId, event.chainId), eq(v2Positions.marketAddress, event.marketAddress), eq(v2Positions.positionId, referenceId),
    )).limit(1);
    if (!position) throw new Error(`AuctionStarted projection missing isolated position ${referenceId}`);
    await db.insert(auctions).values({
      chainId: event.chainId,
      auctionAddress: event.contractAddress,
      auctionId,
      marketAddress: event.marketAddress,
      positionId: referenceId,
      seller: position.seller,
      lender: position.buyer,
      assetAddress: position.assetAddress,
      settlementToken: position.settlementToken,
      collateralAmount: numberString(args.assetAmount),
      frozenDebt: position.frozenDebt ?? position.principal,
      liquidationFeeBps: position.liquidationFeeBps,
      valuationId: null,
      valuationDigest: position.defaultValuationDigest,
      startPrice: numberString(args.startPrice),
      floorPrice: numberString(args.floorPrice),
      startsAt: blockTime,
      endsAt: date(args.endsAt),
      status: 'OPEN',
      ...common(event),
    }).onConflictDoNothing();
    await scheduleJob(db, event, 'finalizeFailedAuction', 'auction', auctionId, new Date(date(args.endsAt).getTime() + 1_000));
  } else if (event.eventName === 'AuctionSold') {
    const [auctionProjection] = await db.select().from(auctions).where(where).limit(1);
    await db.update(auctions).set({ status: 'SETTLED', buyer: address(args.buyer), clearingPrice: numberString(args.price), closedAt: blockTime, ...common(event) }).where(where);
    const [marketSettlement] = await db.select({ payload: chainEvents.payload }).from(chainEvents).where(and(
      eq(chainEvents.chainId, event.chainId),
      eq(chainEvents.txHash, event.transactionHash),
      eq(chainEvents.eventName, 'PositionLiquidated'),
      eq(chainEvents.protocolVersion, 'v2'),
    )).limit(1);
    const [marginSettlement] = marketSettlement ? [] : await db.select({ payload: chainEvents.payload }).from(chainEvents).where(and(
      eq(chainEvents.chainId, event.chainId),
      eq(chainEvents.txHash, event.transactionHash),
      eq(chainEvents.eventName, 'MarginLiquidated'),
      eq(chainEvents.protocolVersion, 'v2'),
    )).limit(1);
    const settlement = marketSettlement ?? marginSettlement;
    if (settlement) {
      const payload = settlement.payload;
      await db.insert(auctionSettlements).values({
        chainId: event.chainId,
        auctionAddress: event.contractAddress,
        auctionId,
        buyer: address(payload.buyer),
        grossProceeds: numberString(payload.salePrice ?? payload.price),
        lenderProceeds: numberString(payload.lenderPaid ?? payload.lenderPool),
        protocolCost: numberString(payload.feePaid ?? payload.fee),
        sellerSurplus: numberString(payload.sellerSurplus),
        lenderShortfall: numberString(payload.shortfall),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        settledAt: blockTime,
      }).onConflictDoNothing();
    }
    await cancelJob(
      db,
      event,
      auctionProjection?.marginAccountId ? 'finalizeFailedMarginAuction' : 'finalizeFailedAuction',
      auctionProjection?.marginAccountId ? 'margin_auction' : 'auction',
      auctionId,
    );
  } else if (event.eventName === 'AuctionFailed') {
    const [auctionProjection] = await db.select().from(auctions).where(where).limit(1);
    await db.update(auctions).set({ status: 'EXPIRED', closedAt: blockTime, ...common(event) }).where(where);
    await cancelJob(
      db,
      event,
      auctionProjection?.marginAccountId ? 'finalizeFailedMarginAuction' : 'finalizeFailedAuction',
      auctionProjection?.marginAccountId ? 'margin_auction' : 'auction',
      auctionId,
    );
  }
}

async function projectClaim(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  const claimId = numberString(args.claimId);
  const where = and(
    eq(settlementClaims.chainId, event.chainId), eq(settlementClaims.escrowAddress, event.contractAddress), eq(settlementClaims.claimId, claimId),
  );
  if (event.eventName === 'ClaimRecorded') {
    await db.insert(settlementClaims).values({
      chainId: event.chainId,
      escrowAddress: event.contractAddress,
      claimId,
      beneficiary: address(args.beneficiary),
      tokenAddress: event.settlementToken,
      amount: numberString(args.amount),
      remaining: numberString(args.amount),
      sourceType: 'REFERENCE_HASH',
      sourceId: null,
      claimReference: String(args.claimReference),
      status: 'PENDING',
      createTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      createdAt: new Date(Number(event.blockTimestamp) * 1000),
    }).onConflictDoNothing();
  } else if (event.eventName === 'ClaimWithdrawn') {
    const remaining = numberString(args.remaining);
    await db.update(settlementClaims).set({
      remaining,
      status: remaining === '0' ? 'CLAIMED' : 'PENDING',
      claimTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      claimedAt: remaining === '0' ? new Date(Number(event.blockTimestamp) * 1000) : null,
    }).where(where);
  }
}

async function projectValuation(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  if (event.eventName === 'ValuationAccepted') {
    await db.insert(oracleValuations).values({
      chainId: event.chainId,
      oracleAddress: event.contractAddress,
      valuationId: numberString(args.nonce),
      assetAddress: address(args.asset),
      valueMinor: numberString(args.priceE18),
      priceE18: numberString(args.priceE18),
      currency: address(args.settlementToken),
      settlementToken: address(args.settlementToken),
      nonce: numberString(args.nonce),
      validFrom: date(args.observedAt),
      observedAt: date(args.observedAt),
      validUntil: date(args.validUntil),
      evidenceHash: String(args.evidenceHash),
      digest: String(args.digest),
      signatures: [],
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
    }).onConflictDoNothing();
  } else if (event.eventName === 'ValuationInvalidated') {
    await db.update(oracleValuations).set({ invalidated: true }).where(and(
      eq(oracleValuations.chainId, event.chainId),
      eq(oracleValuations.oracleAddress, event.contractAddress),
      eq(oracleValuations.assetAddress, address(args.asset)),
      eq(oracleValuations.nonce, numberString(args.nonce)),
    ));
  }
}

async function projectRisk(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  if (event.eventName === 'ConfigApplied') {
    const config = args.config && typeof args.config === 'object' && !Array.isArray(args.config)
      ? args.config as Record<string, unknown>
      : args;
    const version = event.blockNumber.toString();
    await db.update(riskConfigurations).set({ enabled: false }).where(and(
      eq(riskConfigurations.chainId, event.chainId),
      eq(riskConfigurations.riskManagerAddress, event.contractAddress),
      eq(riskConfigurations.assetAddress, address(args.asset)),
    ));
    await db.insert(riskConfigurations).values({
      chainId: event.chainId,
      riskManagerAddress: event.contractAddress,
      assetAddress: address(args.asset),
      configVersion: version,
      initialLtvBps: integer(config.initialLtvBps),
      maintenanceLtvBps: integer(config.maintenanceLtvBps),
      liquidationLtvBps: integer(config.liquidationLtvBps),
      auctionStartBps: integer(config.auctionStartBps),
      auctionFloorBps: integer(config.auctionFloorBps),
      liquidationFeeBps: integer(config.liquidationFeeBps),
      earlyMinHoldBps: integer(config.earlyMinHoldBps),
      earlyBreakFeeBps: integer(config.earlyBreakFeeBps),
      defaultSpreadBps: integer(config.defaultSpreadBps),
      maxDefaultRateBps: integer(config.maxDefaultRateBps),
      oracleMaxAgeSeconds: integer(config.maxOracleAge),
      auctionDurationSeconds: integer(config.auctionDuration),
      marginCallSeconds: integer(config.marginCallPeriod),
      staleOracleFallbackDelaySeconds: integer(config.staleOracleFallbackDelay),
      enabled: Boolean(config.enabled),
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
      activatedAt: new Date(Number(event.blockTimestamp) * 1000),
    }).onConflictDoNothing();
  }
}

async function projectMargin(db: RwcarTransaction, event: V2ProjectableEvent, args: Record<string, unknown>) {
  const accountId = args.accountId === undefined ? undefined : numberString(args.accountId);
  const exposureId = args.exposureId === undefined ? undefined : numberString(args.exposureId);
  const accountWhere = accountId === undefined ? undefined : and(
    eq(marginAccounts.chainId, event.chainId),
    eq(marginAccounts.marginEngineAddress, event.contractAddress),
    eq(marginAccounts.accountId, accountId),
  );
  const exposureWhere = exposureId === undefined ? undefined : and(
    eq(marginExposures.chainId, event.chainId),
    eq(marginExposures.marginEngineAddress, event.contractAddress),
    eq(marginExposures.exposureId, exposureId),
  );
  const blockTime = new Date(Number(event.blockTimestamp) * 1000);
  const snapshot = accountId === undefined ? undefined : marginSnapshotValues(args);

  if (event.eventName === 'MarginAccountOpened' && accountId && snapshot) {
    await db.insert(marginAccounts).values({
      chainId: event.chainId,
      marginEngineAddress: event.contractAddress,
      accountId,
      assetAddress: address(requiredArg(args, 'marginAsset')),
      settlementToken: address(requiredArg(args, 'marginSettlementToken')),
      rulesHash: 'ONCHAIN_IMMUTABLE_ACCOUNT_SNAPSHOT',
      ...snapshot,
      ltvBps: 0,
      lastTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      createdAt: blockTime,
      updatedAt: blockTime,
    }).onConflictDoNothing();
    return;
  }

  if (!accountWhere || !snapshot || !accountId) return;

  if (event.eventName === 'ExposureFunded' && exposureId) {
    const exposureRaw = requiredArg(args, 'exposureSnapshot');
    if (typeof exposureRaw !== 'object' || Array.isArray(exposureRaw)) throw new Error('ExposureFunded requires named exposureSnapshot');
    const exposure = exposureRaw as Record<string, unknown>;
    const openedAt = requiredArg(args, 'openedAt');
    const duration = integer(requiredArg(args, 'duration'));
    if (integer(args.maturity) !== integer(openedAt) + duration) {
      throw new Error('ExposureFunded maturity does not match its emitted openedAt and duration');
    }
    await db.insert(marginExposures).values({
      chainId: event.chainId,
      marginEngineAddress: event.contractAddress,
      exposureId,
      accountId,
      lender: address(args.lender),
      principal: numberString(args.principal),
      accruedDebt: numberString(args.faceDebt),
      openingFee: numberString(args.fee),
      annualRateBps: integer(requiredArg(args, 'annualRateBps')),
      openedAt: date(openedAt),
      maturityAt: date(args.maturity),
      status: 'ACTIVE',
      lastTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      createdAt: blockTime,
      updatedAt: blockTime,
    }).onConflictDoNothing();
    await scheduleJob(
      db,
      event,
      'declarePaymentDefault',
      'margin_exposure',
      exposureId,
      new Date(date(args.maturity).getTime() + integer(requiredArg(args, 'marginGracePeriod')) * 1_000 + 1_000),
    );
  } else if (event.eventName === 'ExposureRepaid' && exposureWhere) {
    await db.update(marginExposures).set({
      status: 'REPAID',
      settlementClaimId: Boolean(args.escrowed) ? numberString(args.claimId) : null,
      lastTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      updatedAt: blockTime,
    }).where(exposureWhere);
    await cancelJob(db, event, 'declarePaymentDefault', 'margin_exposure', exposureId!);
    if (snapshot.totalDebt === '0') await cancelMarginAccountJobs(db, event, accountId);
  } else if (event.eventName === 'PaymentDefaultDeclared') {
    if (exposureId) await cancelJob(db, event, 'declarePaymentDefault', 'margin_exposure', exposureId);
    await cancelMarginExposureDefaultJobs(db, event, accountId);
    await scheduleJob(db, event, 'startMarginLiquidation', 'margin_account', accountId, new Date(blockTime.getTime() + 1_000));
    await scheduleJob(
      db,
      event,
      'startInKindOracleFallback',
      'margin_account',
      accountId,
      new Date(date(args.declaredAt).getTime() + snapshot.staleOracleFallbackDelaySeconds * 1_000 + 1_000),
    );
  } else if (event.eventName === 'MarginCallOpened') {
    const callId = (event.blockNumber * 1_000_000n + BigInt(event.logIndex)).toString();
    await db.insert(marginCalls).values({
      chainId: event.chainId,
      marginEngineAddress: event.contractAddress,
      callId,
      accountId,
      openedLtvBps: integer(args.ltvBps),
      cureDeadline: date(args.cureDeadline),
      status: 'OPEN',
      openedTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      openedAt: blockTime,
    }).onConflictDoNothing();
    await scheduleJob(db, event, 'startMarginLiquidation', 'margin_account', accountId, new Date(date(args.cureDeadline).getTime() + 1_000));
  } else if (event.eventName === 'MarginCallCured') {
    await db.update(marginCalls).set({
      status: 'CURED', resolvedTxHash: event.transactionHash, resolvedAt: blockTime, lastBlockNumber: event.blockNumber,
    }).where(and(
      eq(marginCalls.chainId, event.chainId),
      eq(marginCalls.marginEngineAddress, event.contractAddress),
      eq(marginCalls.accountId, accountId),
      eq(marginCalls.status, 'OPEN'),
    ));
    await cancelJob(db, event, 'startMarginLiquidation', 'margin_account', accountId);
  } else if (event.eventName === 'MarginLiquidationStarted') {
    const auctionId = numberString(args.auctionId);
    await db.update(auctions).set({
      frozenDebt: numberString(args.frozenDebt),
      collateralAmount: numberString(args.collateral),
      liquidationFeeBps: snapshot.liquidationFeeBps,
      valuationDigest: String(args.valuationDigest),
      updatedAt: blockTime,
    }).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.contractAddress),
      eq(auctions.auctionId, auctionId),
    ));
    await db.insert(marginLiquidations).values({
      chainId: event.chainId,
      marginEngineAddress: event.contractAddress,
      liquidationId: auctionId,
      accountId,
      auctionId,
      frozenDebt: numberString(args.frozenDebt),
      collateralAmount: numberString(args.collateral),
      status: 'OPEN',
      startTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      startedAt: blockTime,
    }).onConflictDoNothing();
    await scheduleJob(
      db,
      event,
      'finalizeFailedMarginAuction',
      'margin_auction',
      auctionId,
      new Date(blockTime.getTime() + snapshot.auctionDurationSeconds * 1_000 + 1_000),
    );
    await cancelMarginAccountJobs(db, event, accountId);
    await cancelMarginExposureDefaultJobs(db, event, accountId);
  } else if (event.eventName === 'MarginLiquidated') {
    const auctionId = numberString(args.auctionId);
    const frozenDebt = BigInt(snapshot.frozenDebt);
    const lenderPool = BigInt(numberString(args.lenderPool));
    await db.update(marginLiquidations).set({
      totalProceeds: numberString(args.price),
      proceedsPerDebtRay: frozenDebt === 0n ? '0' : ((lenderPool * 10n ** 27n) / frozenDebt).toString(),
      status: 'SETTLED',
      settleTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      settledAt: blockTime,
    }).where(and(
      eq(marginLiquidations.chainId, event.chainId),
      eq(marginLiquidations.marginEngineAddress, event.contractAddress),
      eq(marginLiquidations.auctionId, auctionId),
    ));
    const [auction] = await db.select().from(auctions).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.contractAddress),
      eq(auctions.auctionId, auctionId),
    )).limit(1);
    if (auction) {
      await db.insert(auctionSettlements).values({
        chainId: event.chainId,
        auctionAddress: auction.auctionAddress,
        auctionId,
        buyer: address(args.buyer),
        grossProceeds: numberString(args.price),
        lenderProceeds: numberString(args.lenderPool),
        protocolCost: numberString(args.fee),
        sellerSurplus: numberString(args.sellerSurplus),
        lenderShortfall: numberString(args.shortfall),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        settledAt: blockTime,
      }).onConflictDoNothing();
    }
    await cancelJob(db, event, 'finalizeFailedMarginAuction', 'margin_auction', auctionId);
    const activeExposures = await db.select({ exposureId: marginExposures.exposureId }).from(marginExposures).where(and(
      eq(marginExposures.chainId, event.chainId),
      eq(marginExposures.marginEngineAddress, event.contractAddress),
      eq(marginExposures.accountId, accountId),
      eq(marginExposures.status, 'ACTIVE'),
    ));
    for (const exposure of activeExposures) {
      await scheduleJob(db, event, 'materializeLiquidationClaim', 'margin_exposure', exposure.exposureId, new Date(blockTime.getTime() + 1_000));
    }
  } else if (event.eventName === 'MarginAuctionFailed') {
    const auctionId = numberString(args.auctionId);
    await db.update(marginLiquidations).set({
      status: 'FAILED', settleTxHash: event.transactionHash, lastBlockNumber: event.blockNumber, settledAt: blockTime,
    }).where(and(
      eq(marginLiquidations.chainId, event.chainId),
      eq(marginLiquidations.marginEngineAddress, event.contractAddress),
      eq(marginLiquidations.auctionId, auctionId),
    ));
    await db.update(auctions).set({ status: 'EXPIRED', closedAt: blockTime, ...common(event) }).where(and(
      eq(auctions.chainId, event.chainId),
      eq(auctions.marketAddress, event.contractAddress),
      eq(auctions.auctionId, auctionId),
    ));
    await cancelJob(db, event, 'finalizeFailedMarginAuction', 'margin_auction', auctionId);
  } else if (event.eventName === 'MarginInKindCloseoutStarted') {
    const claimPoolId = numberString(args.claimPoolId);
    await db.insert(marginLiquidations).values({
      chainId: event.chainId,
      marginEngineAddress: event.contractAddress,
      liquidationId: claimPoolId,
      accountId,
      auctionId: '0',
      frozenDebt: snapshot.frozenDebt,
      collateralAmount: snapshot.collateralAmount,
      status: 'IN_KIND',
      startTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      startedAt: blockTime,
    }).onConflictDoNothing();
    await cancelMarginAccountJobs(db, event, accountId);
    await cancelMarginExposureDefaultJobs(db, event, accountId);
  } else if (event.eventName === 'LiquidationProceedsMaterialized' && exposureWhere) {
    await db.update(marginExposures).set({
      status: 'PROCEEDS_CLAIMED',
      settlementClaimId: numberString(args.claimId),
      liquidationClaimAmount: numberString(args.amount),
      lastTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      updatedAt: blockTime,
    }).where(exposureWhere);
    await cancelJob(db, event, 'materializeLiquidationClaim', 'margin_exposure', exposureId!);
  } else if (event.eventName === 'LiquidationCollateralClaimed' && exposureWhere) {
    await db.update(marginExposures).set({
      status: 'COLLATERAL_CLAIMED',
      liquidationClaimAmount: numberString(args.amount),
      lastTxHash: event.transactionHash,
      lastBlockNumber: event.blockNumber,
      updatedAt: blockTime,
    }).where(exposureWhere);
  } else if (event.eventName === 'MarginAccountClosed') {
    await cancelMarginAccountJobs(db, event, accountId);
    await cancelMarginExposureDefaultJobs(db, event, accountId);
  }

  const ltvBps = event.eventName === 'MarginCallOpened' || event.eventName === 'MarginCallCured'
    ? integer(args.ltvBps)
    : undefined;
  await db.update(marginAccounts).set({
    ...snapshot,
    ...(ltvBps === undefined ? {} : { ltvBps }),
    lastTxHash: event.transactionHash,
    lastBlockNumber: event.blockNumber,
    updatedAt: blockTime,
    closedAt: snapshot.status === 'CLOSED' ? blockTime : null,
  }).where(accountWhere);
}
