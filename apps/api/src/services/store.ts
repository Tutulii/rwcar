import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import {
  assets,
  auctions,
  automationJobs,
  chainEvents,
  indexerCheckpoints,
  marginAccounts,
  marginCalls,
  marginExposures,
  oracleValuations,
  protocolDeployments,
  repos,
  riskConfigurations,
  settlementClaims,
  v2Offers,
  v2Positions,
  vaultBalances,
  type RwcarDb,
} from '@rwcar/db';
import type { Address } from 'viem';

export const REPO_LIFECYCLE_EVENTS = [
  'OfferCreated',
  'OfferAccepted',
  'RepoRepaid',
  'RepoDefaulted',
  'OfferCancelled',
  'OfferExpired',
] as const;

export class StoreService {
  constructor(private readonly db: RwcarDb) {}

  listAssets() {
    return this.db.select().from(assets).where(and(eq(assets.enabled, true), eq(assets.cleanverseStatus, 'ISSUED')));
  }

  async getAsset(address: Address) {
    const [asset] = await this.db.select().from(assets).where(and(
      eq(assets.address, address.toLowerCase()),
      eq(assets.enabled, true),
    )).limit(1);
    return asset;
  }

  async getAssetIncludingDisabled(address: Address) {
    const [asset] = await this.db.select().from(assets).where(eq(assets.address, address.toLowerCase())).limit(1);
    return asset;
  }

  async getRepo(repoId: string, marketAddress: Address) {
    const [repo] = await this.db.select().from(repos).where(and(
      eq(repos.repoId, repoId),
      eq(repos.marketAddress, marketAddress.toLowerCase()),
    )).limit(1);
    return repo;
  }

  listOpenRepos() {
    return this.db.select().from(repos).where(and(
      eq(repos.status, 'OPEN'),
      gt(repos.offerExpiry, new Date()),
    )).orderBy(desc(repos.createdAt));
  }

  listV2OpenOffers(marketAddress?: Address, asOf = new Date()) {
    const market = marketAddress ? eq(v2Offers.marketAddress, marketAddress.toLowerCase()) : undefined;
    return this.db.select().from(v2Offers).where(and(
      inArray(v2Offers.status, ['OPEN', 'PARTIALLY_FILLED']),
      gt(v2Offers.offerExpiry, asOf),
      market,
    )).orderBy(desc(v2Offers.createdAt));
  }

  async getV2Offer(offerId: string, marketAddress?: Address) {
    const [offer] = await this.db.select().from(v2Offers).where(and(
      eq(v2Offers.offerId, offerId),
      marketAddress ? eq(v2Offers.marketAddress, marketAddress.toLowerCase()) : undefined,
    )).limit(1);
    return offer;
  }

  async listV2Positions(wallet: Address, marketAddress?: Address) {
    const normalized = wallet.toLowerCase();
    const positions = await this.db.select().from(v2Positions).where(and(
      or(eq(v2Positions.seller, normalized), eq(v2Positions.buyer, normalized)),
      marketAddress ? eq(v2Positions.marketAddress, marketAddress.toLowerCase()) : undefined,
    )).orderBy(desc(v2Positions.updatedAt));
    const offerIds = uniqueStrings(positions.map((position) => position.offerId));
    const parentOffers = offerIds.length > 0
      ? await this.db.select().from(v2Offers).where(and(
        inArray(v2Offers.offerId, offerIds),
        marketAddress ? eq(v2Offers.marketAddress, marketAddress.toLowerCase()) : undefined,
      ))
      : [];
    return positions.map((position) => {
      const offer = parentOffers.find((candidate) => candidate.offerId === position.offerId);
      return {
        ...position,
        offerTerms: offer ? {
          offerId: offer.offerId,
          durationSeconds: offer.durationSeconds,
          offerExpiry: offer.offerExpiry,
          earlyRepurchaseEnabled: offer.earlyRepurchaseEnabled,
          minimumHoldSeconds: offer.minimumHoldSeconds,
          breakFeeBps: offer.breakFeeBps,
          annualRateBps: offer.annualRateBps,
          defaultRateBps: offer.defaultRateBps,
          valuationHash: offer.valuationHash,
        } : null,
      };
    });
  }

  listV2SellerOffers(wallet: Address, marketAddress?: Address) {
    return this.db.select().from(v2Offers).where(and(
      eq(v2Offers.seller, wallet.toLowerCase()),
      inArray(v2Offers.status, ['OPEN', 'PARTIALLY_FILLED']),
      marketAddress ? eq(v2Offers.marketAddress, marketAddress.toLowerCase()) : undefined,
    )).orderBy(desc(v2Offers.createdAt));
  }

  listV2SellerOfferHistory(wallet: Address, marketAddress?: Address) {
    return this.db.select().from(v2Offers).where(and(
      eq(v2Offers.seller, wallet.toLowerCase()),
      inArray(v2Offers.status, ['FILLED', 'CANCELLED', 'EXPIRED']),
      marketAddress ? eq(v2Offers.marketAddress, marketAddress.toLowerCase()) : undefined,
    )).orderBy(desc(v2Offers.updatedAt));
  }

  async getV2Position(positionId: string, marketAddress?: Address) {
    const [position] = await this.db.select().from(v2Positions).where(and(
      eq(v2Positions.positionId, positionId),
      marketAddress ? eq(v2Positions.marketAddress, marketAddress.toLowerCase()) : undefined,
    )).limit(1);
    return position;
  }

  listVaultBalances(wallet: Address, vaultAddress?: Address) {
    return this.db.select().from(vaultBalances).where(and(
      eq(vaultBalances.account, wallet.toLowerCase()),
      vaultAddress ? eq(vaultBalances.vaultAddress, vaultAddress.toLowerCase()) : undefined,
    )).orderBy(vaultBalances.assetAddress, vaultBalances.bucket);
  }

  listAuctions(auctionAddress?: Address, includeClosed = false) {
    return this.db.select().from(auctions).where(and(
      auctionAddress ? eq(auctions.auctionAddress, auctionAddress.toLowerCase()) : undefined,
      includeClosed ? undefined : eq(auctions.status, 'OPEN'),
    )).orderBy(desc(auctions.createdAt));
  }

  async getAuction(auctionId: string, auctionAddress?: Address) {
    const [auction] = await this.db.select().from(auctions).where(and(
      eq(auctions.auctionId, auctionId),
      auctionAddress ? eq(auctions.auctionAddress, auctionAddress.toLowerCase()) : undefined,
    )).limit(1);
    return auction;
  }

  async listMarginAccounts(wallet: Address, marginEngineAddress?: Address) {
    const normalized = wallet.toLowerCase();
    const [owned, lenderRefs] = await Promise.all([
      this.db.select().from(marginAccounts).where(and(
      eq(marginAccounts.owner, normalized),
      marginEngineAddress ? eq(marginAccounts.marginEngineAddress, marginEngineAddress.toLowerCase()) : undefined,
      )),
      this.db.select({
        chainId: marginExposures.chainId,
        marginEngineAddress: marginExposures.marginEngineAddress,
        accountId: marginExposures.accountId,
      }).from(marginExposures).where(and(
        eq(marginExposures.lender, normalized),
        marginEngineAddress ? eq(marginExposures.marginEngineAddress, marginEngineAddress.toLowerCase()) : undefined,
      )),
    ]);
    const lenderAccountPredicates = lenderRefs.map((reference) => and(
      eq(marginAccounts.chainId, reference.chainId),
      eq(marginAccounts.marginEngineAddress, reference.marginEngineAddress),
      eq(marginAccounts.accountId, reference.accountId),
    ));
    const lenderAccounts = lenderAccountPredicates.length === 0 ? [] : await this.db.select().from(marginAccounts)
      .where(or(...lenderAccountPredicates));
    const accounts = [...owned, ...lenderAccounts].filter((account, index, values) => values.findIndex((candidate) =>
      candidate.chainId === account.chainId
      && candidate.marginEngineAddress === account.marginEngineAddress
      && candidate.accountId === account.accountId) === index)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    if (accounts.length === 0) return [];
    const accountPredicates = accounts.map((account) => and(
      eq(marginExposures.chainId, account.chainId),
      eq(marginExposures.marginEngineAddress, account.marginEngineAddress),
      eq(marginExposures.accountId, account.accountId),
    ));
    const callPredicates = accounts.map((account) => and(
      eq(marginCalls.chainId, account.chainId),
      eq(marginCalls.marginEngineAddress, account.marginEngineAddress),
      eq(marginCalls.accountId, account.accountId),
    ));
    const [exposures, calls] = await Promise.all([
      this.db.select().from(marginExposures).where(or(...accountPredicates)),
      this.db.select().from(marginCalls).where(or(...callPredicates)),
    ]);
    return accounts.map((account) => ({
      ...account,
      role: account.owner === normalized ? 'OWNER' : 'LENDER',
      exposures: exposures.filter((exposure) => exposure.chainId === account.chainId
        && exposure.marginEngineAddress === account.marginEngineAddress && exposure.accountId === account.accountId),
      marginCalls: calls.filter((call) => call.chainId === account.chainId
        && call.marginEngineAddress === account.marginEngineAddress && call.accountId === account.accountId),
    }));
  }

  listFundableMarginAccounts(marginEngineAddress: Address, limit: number) {
    return this.db.select().from(marginAccounts).where(and(
      eq(marginAccounts.marginEngineAddress, marginEngineAddress.toLowerCase()),
      eq(marginAccounts.status, 'HEALTHY'),
      eq(marginAccounts.fundingClosed, false),
      gt(marginAccounts.fundingExpiry, new Date()),
      sql`${marginAccounts.totalFunded} < ${marginAccounts.fundingTarget}`,
    )).orderBy(desc(marginAccounts.updatedAt)).limit(Math.min(Math.max(Math.trunc(limit), 1), 50));
  }

  async getMarginAccount(accountId: string, marginEngineAddress?: Address) {
    const [account] = await this.db.select().from(marginAccounts).where(and(
      eq(marginAccounts.accountId, accountId),
      marginEngineAddress ? eq(marginAccounts.marginEngineAddress, marginEngineAddress.toLowerCase()) : undefined,
    )).limit(1);
    return account;
  }

  async getMarginAccountDetail(accountId: string, marginEngineAddress: Address) {
    const account = await this.getMarginAccount(accountId, marginEngineAddress);
    if (!account) return undefined;
    const [exposures, calls] = await Promise.all([
      this.db.select().from(marginExposures).where(and(
        eq(marginExposures.chainId, account.chainId),
        eq(marginExposures.marginEngineAddress, account.marginEngineAddress),
        eq(marginExposures.accountId, account.accountId),
      )).orderBy(desc(marginExposures.updatedAt)),
      this.db.select().from(marginCalls).where(and(
        eq(marginCalls.chainId, account.chainId),
        eq(marginCalls.marginEngineAddress, account.marginEngineAddress),
        eq(marginCalls.accountId, account.accountId),
      )).orderBy(desc(marginCalls.openedAt)),
    ]);
    return { ...account, exposures, marginCalls: calls };
  }

  async getActiveRiskConfiguration(assetAddress: Address) {
    const [config] = await this.db.select().from(riskConfigurations).where(and(
      eq(riskConfigurations.assetAddress, assetAddress.toLowerCase()),
      eq(riskConfigurations.enabled, true),
    )).orderBy(desc(riskConfigurations.configVersion)).limit(1);
    return config;
  }

  async getOracleValuation(valuationId: string, oracleAddress?: Address) {
    const [valuation] = await this.db.select().from(oracleValuations).where(and(
      eq(oracleValuations.valuationId, valuationId),
      oracleAddress ? eq(oracleValuations.oracleAddress, oracleAddress.toLowerCase()) : undefined,
    )).limit(1);
    return valuation;
  }

  listSettlementClaims(wallet: Address) {
    return this.db.select().from(settlementClaims).where(eq(settlementClaims.beneficiary, wallet.toLowerCase()))
      .orderBy(desc(settlementClaims.createdAt));
  }

  async getSettlementClaim(claimId: string, escrowAddress?: Address) {
    const [claim] = await this.db.select().from(settlementClaims).where(and(
      eq(settlementClaims.claimId, claimId),
      escrowAddress ? eq(settlementClaims.escrowAddress, escrowAddress.toLowerCase()) : undefined,
    )).limit(1);
    return claim;
  }

  listDeployments() {
    return this.db.select().from(protocolDeployments).where(eq(protocolDeployments.enabled, true))
      .orderBy(protocolDeployments.protocolVersion, protocolDeployments.module);
  }

  async systemStatus() {
    const [checkpoints, deployments, pendingJobs, latestOracleValuations] = await Promise.all([
      this.db.select().from(indexerCheckpoints).orderBy(indexerCheckpoints.consumer),
      this.listDeployments(),
      this.db.select({
        action: automationJobs.action,
        status: automationJobs.status,
        count: sql<number>`count(*)::int`,
      }).from(automationJobs).groupBy(automationJobs.action, automationJobs.status),
      this.db.select({
        oracleAddress: oracleValuations.oracleAddress,
        assetAddress: oracleValuations.assetAddress,
        priceE18: oracleValuations.priceE18,
        nonce: oracleValuations.nonce,
        observedAt: oracleValuations.observedAt,
        validUntil: oracleValuations.validUntil,
        digest: oracleValuations.digest,
        txHash: oracleValuations.txHash,
        blockNumber: oracleValuations.blockNumber,
      }).from(oracleValuations).where(eq(oracleValuations.invalidated, false))
        .orderBy(desc(oracleValuations.blockNumber)).limit(1),
    ]);
    return {
      checkpoints,
      deployments,
      automationJobs: pendingJobs,
      latestOracleValuation: latestOracleValuations[0] ?? null,
    };
  }

  async transactionIndexStatus(txHash: string) {
    const [events, deployments, checkpoints] = await Promise.all([
      this.db.select({
        protocolVersion: chainEvents.protocolVersion,
        module: chainEvents.module,
        contractAddress: chainEvents.contractAddress,
        eventName: chainEvents.eventName,
        blockNumber: chainEvents.blockNumber,
        finalized: chainEvents.finalized,
        removed: chainEvents.removed,
        observedAt: chainEvents.observedAt,
      }).from(chainEvents).where(eq(chainEvents.txHash, txHash.toLowerCase())).orderBy(chainEvents.logIndex),
      this.db.select().from(protocolDeployments).where(and(
        eq(protocolDeployments.enabled, true),
        eq(protocolDeployments.protocolVersion, 'v2'),
      )),
      this.db.select().from(indexerCheckpoints),
    ]);
    const txBlock = events.reduce<bigint | null>((latest, event) => latest === null || event.blockNumber > latest ? event.blockNumber : latest, null);
    const sourceCoverage = transactionSourceCoverage(txBlock, deployments, checkpoints);
    const sourcesComplete = txBlock !== null && sourceCoverage.every((source) => source.completeThroughTransaction);
    return {
      indexed: events.length > 0,
      transactionBlock: txBlock,
      sourcesComplete,
      finalized: events.length > 0 && sourcesComplete && events.every((event) => event.finalized && !event.removed),
      eventCoverage: events.map((event) => ({
        module: event.module,
        contractAddress: event.contractAddress,
        eventName: event.eventName,
        blockNumber: event.blockNumber,
      })),
      sourceCoverage,
      events,
    };
  }

  async listV2Activity(wallet: Address | undefined, limit: number) {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
    const events = await this.db.select({
      module: chainEvents.module,
      eventName: chainEvents.eventName,
      payload: chainEvents.payload,
      contractAddress: chainEvents.contractAddress,
      txHash: chainEvents.txHash,
      blockNumber: chainEvents.blockNumber,
      logIndex: chainEvents.logIndex,
      blockTimestamp: chainEvents.blockTimestamp,
    }).from(chainEvents).where(and(
      eq(chainEvents.protocolVersion, 'v2'),
      eq(chainEvents.finalized, true),
      eq(chainEvents.removed, false),
    )).orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex)).limit(wallet ? 200 : boundedLimit);

    const payloads = events.map((event) => event.payload);
    const offerIds = uniqueStrings(payloads.flatMap((payload) => payload.offerId === undefined ? [] : [String(payload.offerId)]));
    const positionIds = uniqueStrings(payloads.flatMap((payload) => payload.positionId === undefined ? [] : [String(payload.positionId)]));
    const accountIds = uniqueStrings(payloads.flatMap((payload) => payload.accountId === undefined ? [] : [String(payload.accountId)]));
    const exposureIds = uniqueStrings(payloads.flatMap((payload) => payload.exposureId === undefined ? [] : [String(payload.exposureId)]));
    const [offers, positions, accounts, exposures] = await Promise.all([
      offerIds.length ? this.db.select().from(v2Offers).where(inArray(v2Offers.offerId, offerIds)) : [],
      positionIds.length ? this.db.select().from(v2Positions).where(inArray(v2Positions.positionId, positionIds)) : [],
      accountIds.length ? this.db.select().from(marginAccounts).where(inArray(marginAccounts.accountId, accountIds)) : [],
      exposureIds.length ? this.db.select().from(marginExposures).where(inArray(marginExposures.exposureId, exposureIds)) : [],
    ]);
    const normalized = wallet?.toLowerCase();
    return events.flatMap((event) => {
      const payload = event.payload;
      const offer = payload.offerId === undefined ? undefined : offers.find((row) => row.offerId === String(payload.offerId));
      const position = payload.positionId === undefined ? undefined : positions.find((row) => row.positionId === String(payload.positionId));
      const exposure = payload.exposureId === undefined ? undefined : exposures.find((row) => row.exposureId === String(payload.exposureId));
      const accountId = payload.accountId === undefined ? exposure?.accountId : String(payload.accountId);
      const account = accountId === undefined ? undefined : accounts.find((row) => row.accountId === accountId);
      const directParticipants = ['seller', 'buyer', 'lender', 'beneficiary', 'recipient'].flatMap((key) =>
        typeof payload[key] === 'string' ? [String(payload[key]).toLowerCase()] : []);
      const participants = uniqueStrings([
        ...directParticipants,
        ...(offer ? [offer.seller, ...(offer.permittedBuyer ? [offer.permittedBuyer] : [])] : []),
        ...(position ? [position.seller, position.buyer] : []),
        ...(account ? [account.owner] : []),
        ...(exposure ? [exposure.lender] : []),
      ]);
      if (normalized && !participants.includes(normalized)) return [];
      const resource = payload.exposureId !== undefined ? { type: 'margin_exposure', id: String(payload.exposureId) }
        : payload.accountId !== undefined ? { type: 'margin_account', id: String(payload.accountId) }
          : payload.positionId !== undefined ? { type: 'position', id: String(payload.positionId) }
            : payload.offerId !== undefined ? { type: 'offer', id: String(payload.offerId) }
              : payload.auctionId !== undefined ? { type: 'auction', id: String(payload.auctionId) }
                : payload.claimId !== undefined ? { type: 'claim', id: String(payload.claimId) }
                  : { type: 'protocol', id: event.contractAddress };
      const amountKey = ['amount', 'principal', 'faceDebt', 'payoff', 'price', 'salePrice', 'collateral', 'collateralAmount']
        .find((key) => payload[key] !== undefined);
      return [{
        ...event,
        resource,
        assetAddress: offer?.assetAddress ?? position?.assetAddress ?? account?.assetAddress ?? null,
        amount: amountKey ? String(payload[amountKey!]) : null,
        participants,
      }];
    }).slice(0, boundedLimit);
  }

  listPositions(wallet: Address) {
    const normalized = wallet.toLowerCase();
    return this.db.select().from(repos).where(or(eq(repos.seller, normalized), eq(repos.buyer, normalized))).orderBy(desc(repos.updatedAt));
  }

  listActivity(wallet: Address | undefined, limit: number) {
    const normalized = wallet?.toLowerCase();
    const participant = normalized
      ? or(eq(repos.seller, normalized), eq(repos.buyer, normalized))
      : undefined;
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);

    return this.db.select({
      eventName: chainEvents.eventName,
      repoId: repos.repoId,
      txHash: chainEvents.txHash,
      blockNumber: chainEvents.blockNumber,
      logIndex: chainEvents.logIndex,
      observedAt: chainEvents.observedAt,
      assetAddress: repos.assetAddress,
      assetName: assets.name,
      assetSymbol: assets.symbol,
      principalAmount: repos.principalAmount,
      repurchaseAmount: repos.repurchaseAmount,
      annualRateBps: repos.annualRateBps,
      seller: repos.seller,
      buyer: repos.buyer,
      currentStatus: repos.status,
    }).from(chainEvents).innerJoin(repos, and(
      eq(chainEvents.chainId, repos.chainId),
      eq(chainEvents.contractAddress, repos.marketAddress),
      sql`${chainEvents.payload}->>'repoId' = ${repos.repoId}::text`,
    )).leftJoin(assets, and(
      eq(assets.chainId, repos.chainId),
      eq(assets.address, repos.assetAddress),
    )).where(and(
      inArray(chainEvents.eventName, [...REPO_LIFECYCLE_EVENTS]),
      participant,
    )).orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex)).limit(boundedLimit);
  }
}

export function serializeRow<T>(row: T): unknown {
  if (row instanceof Date) return row.toISOString();
  if (typeof row === 'bigint') return row.toString();
  if (Array.isArray(row)) return row.map(serializeRow);
  if (row && typeof row === 'object') {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeRow(value)]));
  }
  return row;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function transactionSourceCoverage(
  txBlock: bigint | null,
  deployments: Array<{ chainId: number; module: string; address: string }>,
  checkpoints: Array<{ chainId: number; consumer: string; blockNumber: bigint }>,
) {
  return deployments.map((deployment) => {
    const consumer = `v2:${deployment.module.toLowerCase()}:${deployment.address.toLowerCase()}`;
    const checkpoint = checkpoints.find((candidate) => candidate.chainId === deployment.chainId && candidate.consumer === consumer);
    return {
      module: deployment.module,
      address: deployment.address,
      consumer,
      checkpointBlock: checkpoint?.blockNumber ?? null,
      completeThroughTransaction: txBlock !== null && checkpoint !== undefined && checkpoint.blockNumber >= txBlock,
    };
  });
}
