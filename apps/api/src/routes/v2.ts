import { randomUUID } from 'node:crypto';
import { auditLogs, type RwcarDb } from '@rwcar/db';
import {
  AddressSchema,
  AuctionActionV2Schema,
  CreateOfferV2Schema,
  DepositV2Schema,
  FillOfferV2Schema,
  MarginActionV2Schema,
  OfferActionV2Schema,
  PositionLifecycleActionV2Schema,
  RepayPositionV2Schema,
  SettlementClaimV2Schema,
  UintStringSchema,
  WithdrawV2Schema,
} from '@rwcar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { AuthClaims, AuthService } from '../services/auth.js';
import type { ChainService } from '../services/chain.js';
import { calculateDutchAuctionPrice, calculateFillEconomics, calculateLiquidationWaterfall, calculatePayoffEconomics, uniqueVaultAddresses } from '../services/economics.js';
import { enrichMarginRiskRows } from '../services/margin-risk.js';
import { serializeRow, type StoreService } from '../services/store.js';
import type { V2PreflightService } from '../services/v2-preflight.js';

type Authenticate = (request: FastifyRequest) => Promise<AuthClaims>;

export function registerV2Routes(
  app: FastifyInstance,
  config: ApiConfig,
  auth: AuthService,
  preflight: V2PreflightService,
  store: StoreService,
  chain: ChainService,
  db: RwcarDb,
) {
  const market = config.REPO_MARKET_V2_ADDRESS as Address | undefined;
  const vault = config.COLLATERAL_VAULT_V2_ADDRESS as Address | undefined;
  const auctionHouse = config.DUTCH_AUCTION_V2_ADDRESS as Address | undefined;
  const marginEngine = config.MARGIN_ENGINE_V2_ADDRESS as Address | undefined;
  let marginRiskMetadataPending: ReturnType<ChainService['marginMetadata']> | undefined;
  const marginRiskMetadata = () => {
    if (!marginEngine) return Promise.reject(new Error('Margin engine is not configured'));
    if (!marginRiskMetadataPending) {
      marginRiskMetadataPending = chain.marginMetadata(marginEngine).catch((error) => {
        marginRiskMetadataPending = undefined;
        throw error;
      });
    }
    return marginRiskMetadataPending;
  };
  const withLiveMarginRisk = async <T extends { accountId: string | number | bigint }>(
    rows: T[],
    options: { includeLiveAccount?: boolean } = {},
  ) => {
    if (!marginEngine || rows.length === 0) return rows;
    const metadata = await marginRiskMetadata().catch(() => null);
    return enrichMarginRiskRows(chain, marginEngine, rows, metadata, options);
  };
  let auctionHouseCache: Address[] | undefined;
  let auctionHousePending: Promise<Address[]> | undefined;
  const auctionHouses = async () => {
    if (auctionHouseCache) return auctionHouseCache;
    if (auctionHousePending) return auctionHousePending;
    const pending = Promise.all([
      market ? chain.marketMetadata(market).then((value) => value.auctionHouse).catch(() => undefined) : undefined,
      marginEngine ? chain.marginMetadata(marginEngine).then((value) => value.auctionHouse).catch(() => undefined) : undefined,
    ]).then(([marketAuction, marginAuction]) => [...new Set(
      [marketAuction, marginAuction]
        .filter((value): value is Address => Boolean(value))
        .map((value) => value.toLowerCase() as Address),
    )]);
    auctionHousePending = pending;
    try {
      auctionHouseCache = await pending;
      return auctionHouseCache;
    } finally {
      auctionHousePending = undefined;
    }
  };

  let configCache: { expiresAt: number; value: unknown } | undefined;
  let configPending: Promise<unknown> | undefined;
  app.get('/v2/config', async () => {
    if (configCache && configCache.expiresAt > Date.now()) return configCache.value;
    if (configPending) return configPending;
    const pending = (async () => {
    const [enabledAssets, deployments, marketProof, marginMetadata, chainHead] = await Promise.all([
      store.listAssets(),
      store.listDeployments(),
      market ? chain.marketMetadata(market).catch(() => null) : Promise.resolve(null),
      marginEngine ? chain.marginMetadata(marginEngine).catch(() => null) : Promise.resolve(null),
      chain.blockNumber(),
    ]);
    const v2Deployments = deployments.filter((deployment) => deployment.chainId === 10_143
      && deployment.protocolVersion === 'v2');
    const deploymentRegistered = (module: string, address: Address | undefined, controller?: Address) => Boolean(address
      && v2Deployments.some((deployment) => deployment.module === module
        && deployment.address.toLowerCase() === address.toLowerCase()
        && (controller === undefined
          || String((deployment.metadata as Record<string, unknown> | null)?.controllerAddress ?? '').toLowerCase() === controller.toLowerCase())));
    const configuredVaults = new Set([
      ...v2Deployments.filter((deployment) => deployment.protocolVersion === 'v2'
          && deployment.module === 'COLLATERAL_VAULT'
          && String((deployment.metadata as Record<string, unknown> | null)?.controllerAddress ?? '').toLowerCase() === market?.toLowerCase())
        .map((deployment) => deployment.address.toLowerCase()),
    ]);
    const attestations = {
      repoPolicyPoolRegistered: config.V2_REPO_POLICY_POOL_REGISTERED,
      feeTreasuryAusdcEligible: config.V2_FEE_TREASURY_AUSDC_ELIGIBLE,
      settlementEscrowAusdcReady: config.V2_SETTLEMENT_ESCROW_AUSDC_READY,
      marginPolicyPoolRegistered: config.V2_MARGIN_POLICY_POOL_REGISTERED,
      marginVaultCustodyReady: config.V2_MARGIN_VAULT_CUSTODY_READY,
      marginEscrowAusdcReady: config.V2_MARGIN_ESCROW_AUSDC_READY,
      marginTreasuryAusdcEligible: config.V2_MARGIN_TREASURY_AUSDC_ELIGIBLE,
    };
    const assetProofs = market ? await Promise.all(enabledAssets.map(async (asset) => {
      const live = await chain.marketAssetConfig(market, asset.address as Address).catch(() => null);
      return {
        asset: asset.address,
        vault: live?.vault ?? null,
        marketReady: live?.cleanverseReady === true,
        projectionReady: asset.cleanverseStatus === 'ISSUED' && !asset.paused && asset.enabled,
        configuredVaultMatches: live !== null && configuredVaults.has(live.vault.toLowerCase()),
      };
    })) : [];
    const marketDeploymentMatches = marketProof !== null
      && deploymentRegistered('REPO_MARKET', market)
      && deploymentRegistered('DUTCH_AUCTION', marketProof.auctionHouse, market)
      && deploymentRegistered('SETTLEMENT_ESCROW', marketProof.settlementEscrow, market)
      && deploymentRegistered('VALUATION_ORACLE', marketProof.valuationOracle)
      && deploymentRegistered('RISK_MANAGER', marketProof.riskManager)
      && marketProof.settlementToken.toLowerCase() === config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase()
      && (!config.ASSET_REGISTRY_ADDRESS
        || marketProof.assetRegistry.toLowerCase() === config.ASSET_REGISTRY_ADDRESS.toLowerCase())
      && (!config.VALUATION_ORACLE_V2_ADDRESS
        || marketProof.valuationOracle.toLowerCase() === config.VALUATION_ORACLE_V2_ADDRESS.toLowerCase())
      && (!config.RISK_MANAGER_V2_ADDRESS
        || marketProof.riskManager.toLowerCase() === config.RISK_MANAGER_V2_ADDRESS.toLowerCase())
      && (!auctionHouse || marketProof.auctionHouse.toLowerCase() === auctionHouse.toLowerCase())
      && (!config.SETTLEMENT_ESCROW_V2_ADDRESS
        || marketProof.settlementEscrow.toLowerCase() === config.SETTLEMENT_ESCROW_V2_ADDRESS.toLowerCase())
      && (!config.FEE_TREASURY_ADDRESS
        || marketProof.feeTreasury.toLowerCase() === config.FEE_TREASURY_ADDRESS.toLowerCase());
    const vaultReady = marketDeploymentMatches
      && marketProof.entryPaused === false
      && attestations.repoPolicyPoolRegistered
      && attestations.feeTreasuryAusdcEligible
      && assetProofs.some((proof) => proof.marketReady && proof.projectionReady && proof.vault !== null
        && proof.vault !== zeroAddress && proof.configuredVaultMatches);
    const auctionReady = marketDeploymentMatches
      && attestations.settlementEscrowAusdcReady
      && Boolean(marketProof && marketProof.auctionHouse !== zeroAddress && marketProof.settlementEscrow !== zeroAddress);
    const marginChildRegistered = (module: string, child: Address | undefined) => Boolean(child && marginEngine
      && v2Deployments.some((deployment) => deployment.protocolVersion === 'v2'
        && deployment.module === module
        && deployment.address.toLowerCase() === child.toLowerCase()
        && String((deployment.metadata as Record<string, unknown> | null)?.controllerAddress ?? '').toLowerCase() === marginEngine.toLowerCase()));
    const marginDeploymentMatches = marginMetadata !== null
      && deploymentRegistered('MARGIN_ENGINE', marginEngine)
      && deploymentRegistered('VALUATION_ORACLE', marginMetadata.valuationOracle)
      && deploymentRegistered('RISK_MANAGER', marginMetadata.riskManager)
      && marginMetadata.settlementToken.toLowerCase() === config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase()
      && (!config.ASSET_REGISTRY_ADDRESS
        || marginMetadata.assetRegistry.toLowerCase() === config.ASSET_REGISTRY_ADDRESS.toLowerCase())
      && (!config.VALUATION_ORACLE_V2_ADDRESS
        || marginMetadata.valuationOracle.toLowerCase() === config.VALUATION_ORACLE_V2_ADDRESS.toLowerCase())
      && (!config.RISK_MANAGER_V2_ADDRESS
        || marginMetadata.riskManager.toLowerCase() === config.RISK_MANAGER_V2_ADDRESS.toLowerCase())
      && (!config.FEE_TREASURY_ADDRESS
        || marginMetadata.feeTreasury.toLowerCase() === config.FEE_TREASURY_ADDRESS.toLowerCase())
      && marginChildRegistered('COLLATERAL_VAULT', marginMetadata.vault)
      && marginChildRegistered('DUTCH_AUCTION', marginMetadata.auctionHouse)
      && marginChildRegistered('SETTLEMENT_ESCROW', marginMetadata.settlementEscrow);
    const marginProof = marginMetadata ? {
      configured: marginDeploymentMatches,
      deploymentMatches: marginDeploymentMatches,
      asset: marginMetadata.asset,
      vault: marginMetadata.vault,
      auctionHouse: marginMetadata.auctionHouse,
      settlementEscrow: marginMetadata.settlementEscrow,
      cleanverseCustodyReady: marginMetadata.cleanverseCustodyReady,
      entryPaused: marginMetadata.entryPaused,
    } : null;
    const marginReady = config.V2_MARGIN_ENABLED
      && marginDeploymentMatches
      && marginProof?.cleanverseCustodyReady === true
      && marginProof.entryPaused === false
      && attestations.marginPolicyPoolRegistered
      && attestations.marginVaultCustodyReady
      && attestations.marginEscrowAusdcReady
      && attestations.marginTreasuryAusdcEligible;
    const provenMarketVaults = [...new Set(assetProofs
      .filter((proof) => proof.vault && proof.configuredVaultMatches)
      .map((proof) => proof.vault!.toLowerCase()))];
    const primaryMarketVault = vault && provenMarketVaults.includes(vault.toLowerCase())
      ? vault
      : provenMarketVaults.length === 1 ? provenMarketVaults[0] as Address : null;
    const finalizedBlock = chainHead >= BigInt(config.INDEXER_CONFIRMATIONS) ? chainHead - BigInt(config.INDEXER_CONFIRMATIONS) : 0n;
    const finalizedChainTimestamp = await chain.blockTimestamp(finalizedBlock);
    return {
      protocolVersion: 'v2',
      chainId: 10_143,
      contracts: {
        repoMarket: market ?? null,
        collateralVault: primaryMarketVault,
        settlementEscrow: marketProof?.settlementEscrow ?? null,
        auctionHouse: marketProof?.auctionHouse ?? null,
        marginEngine: marginEngine ?? null,
        valuationOracle: marketProof?.valuationOracle ?? null,
        riskManager: marketProof?.riskManager ?? null,
      },
      terms: {
        allowedDurations: config.V2_ALLOWED_DURATIONS.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0),
        maxOfferLifetimeSeconds: 2_592_000,
      },
      features: {
        partialFills: vaultReady,
        earlyRepurchase: vaultReady,
        triPartyVault: vaultReady,
        dutchAuctions: auctionReady,
        crossMargin: marginReady,
      },
      readiness: {
        operatorAttestations: attestations,
        triPartyVault: { ready: vaultReady, deploymentMatches: marketDeploymentMatches, entryPaused: marketProof?.entryPaused ?? null, assetProofs },
        dutchAuctions: { ready: auctionReady, deploymentMatches: marketDeploymentMatches, requires: ['auctionHouse', 'settlementEscrow'] },
        crossMargin: { ready: marginReady, featureFlag: config.V2_MARGIN_ENABLED, proof: marginProof },
        automation: {
          actions: [
            'finalizeOfferExpiry', 'startAuction', 'finalizeFailedAuction', 'declarePaymentDefault',
            'startMarginLiquidation', 'finalizeFailedMarginAuction', 'startInKindOracleFallback',
            'materializeLiquidationClaim',
          ],
          statusEndpoint: '/v2/system/status',
        },
      },
      assets: assetProofs.map((proof) => ({
        ...enabledAssets.find((asset) => asset.address === proof.asset),
        vault: proof.vault,
        marketReady: proof.marketReady,
        configuredVaultMatches: proof.configuredVaultMatches,
      })),
      finalized: { blockNumber: finalizedBlock.toString(), chainTimestamp: finalizedChainTimestamp.toString() },
      quoteTtlSeconds: config.V2_QUOTE_TTL_SECONDS,
      settlementToken: { address: config.V2_SETTLEMENT_TOKEN_ADDRESS, symbol: 'aUSDC', decimals: 6 },
    };
    })();
    configPending = pending;
    try {
      const value = await pending;
      configCache = { expiresAt: Date.now() + 5_000, value };
      return value;
    } finally {
      configPending = undefined;
    }
  });

  app.get('/v2/offers', async () => {
    const blockNumber = await chain.blockNumber();
    const chainTimestamp = await chain.blockTimestamp(blockNumber);
    const offers = await store.listV2OpenOffers(market, new Date(Number(chainTimestamp) * 1_000));
    return serializeRow({ offers, asOf: { blockNumber, chainTimestamp } });
  });
  app.get('/v2/offers/:offerId', {
    schema: { params: z.object({ offerId: UintStringSchema }) },
  }, async (request) => {
    const { offerId } = request.params as { offerId: string };
    const offer = await store.getV2Offer(offerId, market);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'V2 offer was not found');
    return serializeRow(offer);
  });
  app.get('/v2/offers/:offerId/quote', {
    schema: {
      params: z.object({ offerId: UintStringSchema }),
      querystring: z.object({ principalAmount: UintStringSchema }),
    },
  }, async (request) => {
    const { offerId } = request.params as { offerId: string };
    const { principalAmount } = request.query as { principalAmount: string };
    const offer = await store.getV2Offer(offerId, market);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'V2 offer was not found');
    return calculateFillEconomics({
      totalCollateral: BigInt(offer.totalCollateral),
      targetPrincipal: BigInt(offer.targetPrincipal),
      remainingCollateral: BigInt(offer.remainingCollateral),
      remainingPrincipal: BigInt(offer.remainingPrincipal),
      cumulativeFee: BigInt(offer.cumulativeFee),
      fillPrincipal: BigInt(principalAmount),
    });
  });

  app.get('/v2/positions/:wallet', {
    schema: { params: z.object({ wallet: AddressSchema }) },
  }, async (request) => {
    const { wallet } = request.params as { wallet: Address };
    const [positions, sellerOffers, sellerOfferHistory] = await Promise.all([
      store.listV2Positions(wallet, market),
      store.listV2SellerOffers(wallet, market),
      store.listV2SellerOfferHistory(wallet, market),
    ]);
    return serializeRow({ positions, sellerOffers, sellerOfferHistory });
  });
  app.get('/v2/positions/:positionId/payoff', {
    schema: {
      params: z.object({ positionId: UintStringSchema }),
      querystring: z.object({ timestamp: z.coerce.number().int().positive().optional() }),
    },
  }, async (request) => {
    const { positionId } = request.params as { positionId: string };
    const { timestamp } = request.query as { timestamp?: number };
    const position = await store.getV2Position(positionId, market);
    if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'V2 position was not found');
    const offer = await store.getV2Offer(position.offerId, market);
    if (!offer) throw new AppError(409, 'OFFER_PROJECTION_MISSING', 'The position offer projection is unavailable');
    const chainBlock = await chain.blockNumber();
    const chainTimestamp = await chain.blockTimestamp(chainBlock);
    const atTimestamp = BigInt(timestamp ?? Number(chainTimestamp));
    const fallback = calculatePayoffEconomics({
      principal: BigInt(position.principal),
      annualRateBps: position.annualRateBps,
      defaultRateBps: position.defaultRateBps,
      acceptedAtSeconds: BigInt(Math.floor(position.acceptedAt.getTime() / 1000)),
      maturityAtSeconds: BigInt(Math.floor(position.maturityAt.getTime() / 1000)),
      timestampSeconds: atTimestamp,
      earlyRepurchaseEnabled: offer.earlyRepurchaseEnabled,
      minimumHoldSeconds: offer.minimumHoldSeconds,
      breakFeeBps: offer.breakFeeBps,
    });
    const livePayoff = market
      ? await chain.previewPayoff(market, BigInt(positionId), atTimestamp).catch(() => null)
      : null;
    return {
      ...fallback,
      payoff: livePayoff?.toString() ?? fallback.payoff,
      source: livePayoff === null ? 'projection-fallback' : 'onchain-preview',
      quoteAt: { chainBlock: chainBlock.toString(), chainTimestamp: chainTimestamp.toString(), atTimestamp: atTimestamp.toString() },
    };
  });

  app.get('/v2/vault/:wallet/balances', {
    schema: { params: z.object({ wallet: AddressSchema }) },
  }, async (request) => {
    const { wallet } = request.params as { wallet: Address };
    const projection = await store.listVaultBalances(wallet);
    const enabledAssets = await store.listAssets();
    const marketVaults = market ? await Promise.all(enabledAssets.map(async (asset) => ({
      asset: asset.address,
      config: await chain.marketAssetConfig(market, asset.address as Address).catch(() => null),
    }))) : [];
    const vaults = uniqueVaultAddresses([
      ...projection.map((row) => row.vaultAddress),
      ...marketVaults.flatMap((item) => item.config?.vault && item.config.vault !== zeroAddress ? [item.config.vault] : []),
    ]);
    if (vault && !vaults.includes(vault.toLowerCase())) vaults.push(vault.toLowerCase());
    const liveAvailableByVault = await Promise.all(vaults.map(async (vaultAddress) => ({
      vault: vaultAddress,
      assets: marketVaults.filter((item) => item.config?.vault.toLowerCase() === vaultAddress).map((item) => item.asset),
      available: await chain.vaultAvailable(vaultAddress as Address, wallet).catch(() => null),
    })));
    return serializeRow({
      wallet,
      liveAvailable: liveAvailableByVault.length === 1 ? liveAvailableByVault[0]?.available ?? null : null,
      liveAvailableByVault,
      balances: projection,
      buckets: projection,
    });
  });

  app.get('/v2/auctions', {
    schema: { querystring: z.object({
      includeClosed: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    }) },
  }, async (request) => {
    const { includeClosed } = request.query as { includeClosed: boolean };
    const houses = await auctionHouses();
    const rows = (await Promise.all(houses.map((address) => store.listAuctions(address, includeClosed))))
      .flat()
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const blockNumber = await chain.blockNumber();
    const chainTimestamp = await chain.blockTimestamp(blockNumber);
    return serializeRow({
      auctions: await Promise.all(rows.map((auction) => auctionWithWaterfall(
        auction,
        auction.auctionAddress as Address,
        chain,
        chainTimestamp,
      ))),
      asOf: { blockNumber, chainTimestamp },
    });
  });
  app.get('/v2/auctions/:auctionId', {
    schema: {
      params: z.object({ auctionId: UintStringSchema }),
      querystring: z.object({ auctionAddress: AddressSchema.optional() }),
    },
  }, async (request) => {
    const { auctionId } = request.params as { auctionId: string };
    const { auctionAddress } = request.query as { auctionAddress?: Address };
    const houses = await auctionHouses();
    if (auctionAddress && !houses.includes(auctionAddress.toLowerCase() as Address)) {
      throw new AppError(400, 'AUCTION_SOURCE_NOT_CONFIGURED', 'Auction source is not in the V2 deployment registry');
    }
    const candidates = auctionAddress
      ? [await store.getAuction(auctionId, auctionAddress)]
      : await Promise.all(houses.map((address) => store.getAuction(auctionId, address)));
    const matches = candidates.filter((value): value is NonNullable<typeof value> => value !== undefined);
    if (!auctionAddress && matches.length > 1) {
      throw new AppError(409, 'AMBIGUOUS_AUCTION_ID', 'Provide auctionAddress because auction IDs are local to each engine');
    }
    const auction = matches[0];
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction was not found');
    const source = auction.auctionAddress as Address;
    const livePrice = auction.status === 'OPEN'
      ? await chain.auctionPrice(source, BigInt(auctionId)).catch(() => null)
      : null;
    const blockNumber = await chain.blockNumber();
    const chainTimestamp = await chain.blockTimestamp(blockNumber);
    return serializeRow(await auctionWithWaterfall(auction, source, chain, chainTimestamp, livePrice));
  });

  app.get('/v2/margin/fundable', {
    schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) },
  }, async (request) => {
    if (!marginEngine || !config.V2_MARGIN_ENABLED) return { accounts: [], featureReady: false };
    const { limit } = request.query as { limit: number };
    const accounts = await store.listFundableMarginAccounts(marginEngine, limit);
    return serializeRow({
      accounts: await withLiveMarginRisk(accounts),
      featureReady: true,
    });
  });
  app.get('/v2/margin/accounts/id/:accountId', {
    schema: { params: z.object({ accountId: UintStringSchema }) },
  }, async (request) => {
    // This is also an exit/recovery read path. The entry flag may disable new
    // credit, but must never hide an already-deployed account from its parties.
    if (!marginEngine) throw new AppError(503, 'MARGIN_NOT_READY', 'Margin engine is not deployed');
    const { accountId } = request.params as { accountId: string };
    const projection = await store.getMarginAccountDetail(accountId, marginEngine);
    if (!projection) throw new AppError(404, 'MARGIN_ACCOUNT_NOT_FOUND', 'Margin account was not found');
    const [enriched] = await withLiveMarginRisk([projection], { includeLiveAccount: true });
    return serializeRow(enriched);
  });
  app.get('/v2/margin/accounts/:wallet', {
    schema: { params: z.object({ wallet: AddressSchema }) },
  }, async (request) => {
    const { wallet } = request.params as { wallet: Address };
    if (!marginEngine) return [];
    return serializeRow(await withLiveMarginRisk(await store.listMarginAccounts(wallet, marginEngine)));
  });
  app.get('/v2/claims/:wallet', {
    schema: { params: z.object({ wallet: AddressSchema }) },
  }, async (request) => {
    const { wallet } = request.params as { wallet: Address };
    return serializeRow(await store.listSettlementClaims(wallet));
  });

  app.get('/v2/system/status', async () => {
    const [chainHead, projection] = await Promise.all([chain.blockNumber(), store.systemStatus()]);
    return serializeRow({ status: 'ok', chainHead, ...projection, checkedAt: new Date() });
  });
  app.get('/v2/activity', {
    schema: { querystring: z.object({
      wallet: AddressSchema.optional(),
      limit: z.coerce.number().int().min(1).max(20).default(10),
    }) },
  }, async (request) => {
    const { wallet, limit } = request.query as { wallet?: Address; limit: number };
    return serializeRow(await store.listV2Activity(wallet, limit));
  });
  app.get('/v2/transactions/:txHash/status', {
    schema: { params: z.object({ txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }) },
  }, async (request) => {
    const { txHash } = request.params as { txHash: string };
    return serializeRow(await store.transactionIndexStatus(txHash));
  });

  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/deposit', DepositV2Schema, (body) => preflight.deposit(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/withdraw', WithdrawV2Schema, (body) => preflight.withdraw(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/create-offer', CreateOfferV2Schema, (body) => preflight.createOffer(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/fill', FillOfferV2Schema, (body) => preflight.fill(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/repay', RepayPositionV2Schema, (body) => preflight.repay(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/buy-auction', AuctionActionV2Schema, (body) => preflight.buyAuction(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/cancel-offer', OfferActionV2Schema, (body) => preflight.offerLifecycle(body, 'cancelOffer'));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/finalize-offer-expiry', OfferActionV2Schema, (body) => preflight.offerLifecycle(body, 'finalizeOfferExpiry'));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/start-auction', PositionLifecycleActionV2Schema, (body) => preflight.positionLifecycle(body, 'startAuction'));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/claim-collateral', PositionLifecycleActionV2Schema, (body) => preflight.positionLifecycle(body, 'claimDefaultCollateral'));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/claim-oracle-fallback', PositionLifecycleActionV2Schema, (body) => preflight.positionLifecycle(body, 'claimCollateralOnOracleFailure'));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/finalize-failed-auction', AuctionActionV2Schema, (body) => preflight.finalizeFailedAuction(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/claim-settlement', SettlementClaimV2Schema, (body) => preflight.claimSettlement(body));
  preflightRoute(app, auth.authenticate.bind(auth), db, '/v2/preflight/margin-action', MarginActionV2Schema, (body) => preflight.marginAction(body));
}

function preflightRoute<T extends z.ZodType<{ actor?: string; seller?: string }>>(
  app: FastifyInstance,
  authenticate: Authenticate,
  db: RwcarDb,
  path: string,
  schema: T,
  handler: (body: z.infer<T>) => Promise<{ eligible: boolean; blockingReasons: string[]; correlationId: string }>,
) {
  app.post(path, { schema: { body: schema } }, async (request) => {
    const claims = await authenticate(request);
    const body = request.body as z.infer<T>;
    const wallet = body.actor ?? body.seller;
    if (!wallet) throw new AppError(400, 'WALLET_REQUIRED', 'A wallet actor is required');
    if (!claims.wallets.includes(wallet.toLowerCase())) {
      throw new AppError(403, 'WALLET_MISMATCH', 'Authenticated wallet does not match the request actor');
    }
    const result = await handler(body);
    await db.insert(auditLogs).values({
      correlationId: result.correlationId as ReturnType<typeof randomUUID>,
      actor: wallet.toLowerCase(),
      action: path.split('/').at(-1)?.toUpperCase().replaceAll('-', '_') ?? 'V2_PREFLIGHT',
      resourceType: 'v2_preflight',
      resourceId: null,
      outcome: result.eligible ? 'ALLOWED' : 'DENIED',
      metadata: { blockingReasons: result.blockingReasons },
    });
    return result;
  });
}

async function auctionWithWaterfall(
  auction: NonNullable<Awaited<ReturnType<StoreService['getAuction']>>>,
  configuredAuction: Address | undefined,
  chain: ChainService,
  chainTimestamp: bigint,
  prefetchedPrice?: bigint | null,
) {
  let currentPrice = prefetchedPrice;
  if (currentPrice === undefined) {
    currentPrice = configuredAuction && auction.status === 'OPEN'
      ? await chain.auctionPrice(configuredAuction, BigInt(auction.auctionId)).catch(() => null)
      : null;
  }
  if (currentPrice === null && auction.status === 'OPEN') {
    currentPrice = calculateDutchAuctionPrice(
      BigInt(auction.startPrice),
      BigInt(auction.floorPrice),
      BigInt(Math.floor(auction.startsAt.getTime() / 1_000)),
      BigInt(Math.floor(auction.endsAt.getTime() / 1_000)),
      chainTimestamp,
    );
  }
  const price = currentPrice ?? (auction.clearingPrice ? BigInt(auction.clearingPrice) : null);
  if (price === null) return { ...auction, livePrice: null, waterfall: null };
  const waterfall = calculateLiquidationWaterfall(price, BigInt(auction.frozenDebt), auction.liquidationFeeBps);
  return {
    ...auction,
    livePrice: currentPrice,
    waterfall,
  };
}
