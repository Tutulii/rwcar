import { randomUUID } from 'node:crypto';
import {
  repoMarketV2Abi,
  marginEngineV2Abi,
  settlementEscrowV2Abi,
  type AuctionActionV2Input,
  type CreateOfferV2Input,
  type DepositV2Input,
  type FillOfferV2Input,
  type MarginActionV2Input,
  type OfferActionV2Input,
  type PositionLifecycleActionV2Input,
  type PreflightResultV2,
  type RepayPositionV2Input,
  type SettlementClaimV2Input,
  type TransferEdge,
  type WithdrawV2Input,
} from '@rwcar/shared';
import { encodeFunctionData, zeroAddress, type Address } from 'viem';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ChainService, MarketMetadata } from './chain.js';
import { hasEligibleCviProof, type ComplianceService } from './compliance.js';
import {
  calculateFillEconomics,
  calculateLiquidationWaterfall,
  calculatePayoffEconomics,
  calculateProRataClaim,
  ceilDiv,
  isStrictlyAfter,
} from './economics.js';
import type { StoreService } from './store.js';

type Reason = PreflightResultV2['blockingReasons'][number];
type Kind = PreflightResultV2['quote']['kind'];
type Transaction = PreflightResultV2['transactions'][number];
type CorrelationId = ReturnType<typeof randomUUID>;

const unique = <T>(values: T[]) => [...new Set(values)];
const unix = (date: Date) => BigInt(Math.floor(date.getTime() / 1000));
const MAX_UINT128 = (1n << 128n) - 1n;
const uniqueCompliance = (values: PreflightResultV2['compliance']) => values.filter((value, index) =>
  values.findIndex((candidate) => candidate.wallet.toLowerCase() === value.wallet.toLowerCase()
    && candidate.asset.toLowerCase() === value.asset.toLowerCase()) === index);

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new AppError(400, 'MARGIN_INPUT_REQUIRED', `${name} is required for this margin action`);
  return value;
}

export class V2PreflightService {
  constructor(
    private readonly config: ApiConfig,
    private readonly store: StoreService,
    private readonly compliance: ComplianceService,
    private readonly chain: ChainService,
  ) {}

  private market(): Address {
    if (!this.config.REPO_MARKET_V2_ADDRESS) {
      throw new AppError(503, 'V2_MARKET_NOT_DEPLOYED', 'RepoMarketV2 is not configured');
    }
    return this.config.REPO_MARKET_V2_ADDRESS as Address;
  }

  private settlementToken(): Address {
    return this.config.V2_SETTLEMENT_TOKEN_ADDRESS as Address;
  }

  private marketEntryConfigured(metadata: MarketMetadata | null): metadata is MarketMetadata {
    if (!metadata || metadata.entryPaused) return false;
    if (metadata.settlementToken.toLowerCase() !== this.settlementToken().toLowerCase()) return false;
    if (this.config.DUTCH_AUCTION_V2_ADDRESS
      && metadata.auctionHouse.toLowerCase() !== this.config.DUTCH_AUCTION_V2_ADDRESS.toLowerCase()) return false;
    if (this.config.SETTLEMENT_ESCROW_V2_ADDRESS
      && metadata.settlementEscrow.toLowerCase() !== this.config.SETTLEMENT_ESCROW_V2_ADDRESS.toLowerCase()) return false;
    if (this.config.FEE_TREASURY_ADDRESS
      && metadata.feeTreasury.toLowerCase() !== this.config.FEE_TREASURY_ADDRESS.toLowerCase()) return false;
    return true;
  }

  private async deploymentRegistered(module: string, address: Address, controller?: Address) {
    const deployments = await this.store.listDeployments();
    return deployments.some((deployment) => deployment.chainId === 10_143
      && deployment.protocolVersion === 'v2'
      && deployment.module === module
      && deployment.address.toLowerCase() === address.toLowerCase()
      && (controller === undefined
        || String((deployment.metadata as Record<string, unknown> | null)?.controllerAddress ?? '').toLowerCase() === controller.toLowerCase()));
  }

  private async marketSourcesRegistered(market: Address, metadata: MarketMetadata, vault?: Address) {
    const checks = await Promise.all([
      this.deploymentRegistered('REPO_MARKET', market),
      this.deploymentRegistered('DUTCH_AUCTION', metadata.auctionHouse, market),
      this.deploymentRegistered('SETTLEMENT_ESCROW', metadata.settlementEscrow, market),
      this.deploymentRegistered('VALUATION_ORACLE', metadata.valuationOracle),
      this.deploymentRegistered('RISK_MANAGER', metadata.riskManager),
      ...(vault ? [this.deploymentRegistered('COLLATERAL_VAULT', vault, market)] : []),
    ]);
    return checks.every(Boolean);
  }

  private async marginSourcesRegistered(engine: Address, metadata: Awaited<ReturnType<ChainService['marginMetadata']>>) {
    const checks = await Promise.all([
      this.deploymentRegistered('MARGIN_ENGINE', engine),
      this.deploymentRegistered('COLLATERAL_VAULT', metadata.vault, engine),
      this.deploymentRegistered('DUTCH_AUCTION', metadata.auctionHouse, engine),
      this.deploymentRegistered('SETTLEMENT_ESCROW', metadata.settlementEscrow, engine),
      this.deploymentRegistered('VALUATION_ORACLE', metadata.valuationOracle),
      this.deploymentRegistered('RISK_MANAGER', metadata.riskManager),
    ]);
    return checks.every(Boolean);
  }

  private async clock() {
    const block = await this.chain.blockNumber();
    return { block, timestamp: await this.chain.blockTimestamp(block) };
  }

  private quote(
    kind: Kind,
    chainBlock: bigint,
    chainTimestamp: bigint,
    amounts: Record<string, string>,
    projectedState: PreflightResultV2['quote']['projectedState'],
  ) {
    return {
      kind,
      quoteId: randomUUID(),
      chainBlock: chainBlock.toString(),
      chainTimestamp: chainTimestamp.toString(),
      expiresAt: new Date(Number(chainTimestamp + BigInt(this.config.V2_QUOTE_TTL_SECONDS)) * 1000).toISOString(),
      amounts,
      projectedState,
    };
  }

  private async requestIds(tokens: Address[]) {
    const result = new Map<string, string>();
    await Promise.all(unique(tokens.map((token) => token.toLowerCase())).map(async (token) => {
      const asset = await this.store.getAssetIncludingDisabled(token as Address);
      if (asset?.cleanverseRequestId) result.set(token, asset.cleanverseRequestId);
      else if (token === this.settlementToken().toLowerCase() && this.config.AUSDC_CLEANVERSE_REQUEST_ID) {
        result.set(token, this.config.AUSDC_CLEANVERSE_REQUEST_ID);
      }
    }));
    return result;
  }

  private async evaluateEdges(
    edges: TransferEdge[],
    correlationId: CorrelationId,
    context: { action: string; resourceType: string; resourceId?: string },
  ) {
    if (edges.length === 0) return { graph: [], reasons: [] as Reason[] };
    const requestIds = await this.requestIds(edges.map((edge) => edge.token as Address));
    const settlementToken = this.settlementToken().toLowerCase();
    const missing = edges.some((edge) => !requestIds.has(edge.token.toLowerCase())
      && edge.token.toLowerCase() !== settlementToken);
    if (missing) return { graph: [], reasons: ['COMPLIANCE_UNAVAILABLE'] as Reason[] };
    const graph = await this.compliance.evaluateTransferGraph(edges, requestIds, correlationId, context);
    return { graph, reasons: unique(graph.flatMap((check) => check.blockingReasons)) };
  }

  private complianceFromGraph(graph: Awaited<ReturnType<ComplianceService['evaluateTransferGraph']>>) {
    const values = graph.flatMap((check) => [check.fromCompliance, check.toCompliance]);
    return values.filter((value, index) => values.findIndex((candidate) =>
      candidate.wallet.toLowerCase() === value.wallet.toLowerCase()
      && candidate.asset.toLowerCase() === value.asset.toLowerCase()) === index);
  }

  private async evaluateParticipants(
    wallets: Address[],
    token: Address,
    policyPool: Address,
    correlationId: CorrelationId,
  ) {
    const requestIds = await this.requestIds([token]);
    const requestId = requestIds.get(token.toLowerCase());
    if (!requestId && token.toLowerCase() !== this.settlementToken().toLowerCase()) {
      return { compliance: [] as PreflightResultV2['compliance'], reasons: ['COMPLIANCE_UNAVAILABLE'] as Reason[] };
    }
    const compliance = await Promise.all(unique(wallets.map((wallet) => wallet.toLowerCase())).map((wallet) =>
      this.compliance.verify(wallet as Address, token, requestId, correlationId, policyPool)));
    const reasons: Reason[] = [];
    for (const result of compliance) {
      if (!result.cviActive) reasons.push(result.verificationCode === 2 ? 'CVI_MISSING' : 'CVI_INACTIVE');
      if (!hasEligibleCviProof(result) || result.poolEligible !== true) reasons.push('CVI_INELIGIBLE');
      if (!result.assetIssued) reasons.push('CVA_NOT_ISSUED');
      if (result.assetPaused) reasons.push('CVA_PAUSED');
      if (result.poolEligible === null) reasons.push('COMPLIANCE_UNAVAILABLE');
    }
    return { compliance, reasons: unique(reasons) };
  }

  async deposit(input: DepositV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const actor = input.actor as Address;
    const assetAddress = input.asset as Address;
    const amount = BigInt(input.amount);
    const reasons: Reason[] = [];
    if (amount <= 0n || amount > MAX_UINT128) reasons.push('INVALID_FILL_AMOUNT');
    const marketMetadata = await this.chain.marketMetadata(market).catch(() => null);
    const asset = await this.store.getAsset(assetAddress);
    if (!asset) reasons.push('ASSET_NOT_ALLOWED');
    const clock = await this.clock();
    const [balance, assetConfig] = await Promise.all([
      this.chain.balanceOf(assetAddress, actor),
      this.chain.marketAssetConfig(market, assetAddress),
    ]);
    const vault = assetConfig.vault;
    const sourceProof = marketMetadata && vault !== zeroAddress
      ? await this.marketSourcesRegistered(market, marketMetadata, vault)
      : false;
    const registryEnabled = marketMetadata
      ? await this.chain.assetEnabled(marketMetadata.assetRegistry, assetAddress).catch(() => false)
      : false;
    if (vault === zeroAddress || !assetConfig.cleanverseReady || !this.config.V2_REPO_POLICY_POOL_REGISTERED
      || !this.marketEntryConfigured(marketMetadata) || !sourceProof || !registryEnabled) {
      reasons.push('VAULT_NOT_AUTHORIZED');
    }
    const allowance = await this.chain.allowance(assetAddress, actor, vault);
    if (balance < amount) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < amount) reasons.push('INSUFFICIENT_ALLOWANCE');
    const edges: TransferEdge[] = [{
      token: assetAddress,
      from: actor,
      to: vault,
      amount: amount.toString(),
      purpose: 'COLLATERAL_DEPOSIT',
      policyPool: market,
    }];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'DEPOSIT_COLLATERAL', resourceType: 'vault' });
    reasons.push(...evaluated.reasons);
    const data = encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'depositCollateral', args: [assetAddress, amount] });
    if (reasons.length === 0 && allowance >= amount) {
      try { await this.chain.simulateTransaction(actor, market, data); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: this.complianceFromGraph(evaluated.graph),
      transferGraph: evaluated.graph,
      requiredApprovals: allowance < amount ? [{ token: assetAddress, spender: vault, amount: amount.toString() }] : [],
      transactions: [{
        to: market,
        data,
        value: '0',
        description: `Deposit ${amount} units into the tri-party vault`,
      }],
      quote: this.quote('DEPOSIT', clock.block, clock.timestamp, { amount: amount.toString() }, { bucket: 'AVAILABLE' }),
      correlationId,
    };
  }

  async withdraw(input: WithdrawV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const actor = input.actor as Address;
    const recipient = (input.recipient ?? input.actor) as Address;
    const assetAddress = input.asset as Address;
    const amount = BigInt(input.amount);
    const clock = await this.clock();
    const assetConfig = await this.chain.marketAssetConfig(market, assetAddress);
    const vault = assetConfig.vault;
    const available = await this.chain.vaultAvailable(vault, actor);
    const reasons: Reason[] = [];
    if (amount <= 0n || amount > MAX_UINT128) reasons.push('INVALID_FILL_AMOUNT');
    if (available < amount) reasons.push('INSUFFICIENT_BALANCE');
    const edges: TransferEdge[] = [{
      token: assetAddress,
      from: vault,
      to: recipient,
      amount: amount.toString(),
      purpose: 'COLLATERAL_RELEASE',
      policyPool: market,
    }];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'WITHDRAW_COLLATERAL', resourceType: 'vault' });
    reasons.push(...evaluated.reasons);
    const participants = await this.evaluateParticipants([actor, recipient], assetAddress, market, correlationId);
    reasons.push(...participants.reasons);
    const data = encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'withdrawCollateral', args: [assetAddress, amount, recipient] });
    if (reasons.length === 0) {
      try { await this.chain.simulateTransaction(actor, market, data); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...participants.compliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: [],
      transactions: [{
        to: market,
        data,
        value: '0',
        description: `Withdraw ${amount} available collateral units`,
      }],
      quote: this.quote('WITHDRAW', clock.block, clock.timestamp, {
        amount: amount.toString(),
        availableBefore: available.toString(),
        availableAfter: available >= amount ? (available - amount).toString() : '0',
      }, { recipient }),
      correlationId,
    };
  }

  async createOffer(input: CreateOfferV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const seller = input.seller as Address;
    const assetAddress = input.asset as Address;
    const collateral = BigInt(input.totalCollateral);
    const principal = BigInt(input.targetPrincipal);
    const minimumFill = BigInt(input.minimumFill);
    const reasons: Reason[] = [];
    const marketMetadata = await this.chain.marketMetadata(market).catch(() => null);
    const asset = await this.store.getAsset(assetAddress);
    if (!asset) reasons.push('ASSET_NOT_ALLOWED');
    if (minimumFill <= 0n || minimumFill > principal) reasons.push('INVALID_FILL_AMOUNT');
    const clock = await this.clock();
    if (BigInt(input.offerExpiry) <= clock.timestamp) reasons.push('OFFER_EXPIRED');
    if (BigInt(input.offerExpiry) > clock.timestamp + 30n * 24n * 60n * 60n) reasons.push('INVALID_OFFER_EXPIRY');
    const allowedDurations = this.config.V2_ALLOWED_DURATIONS.split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    if (!allowedDurations.includes(input.durationSeconds)) reasons.push('INVALID_DURATION');

    const assetConfig = await this.chain.marketAssetConfig(market, assetAddress);
    const vault = assetConfig.vault;
    const sourceProof = marketMetadata && vault !== zeroAddress
      ? await this.marketSourcesRegistered(market, marketMetadata, vault)
      : false;
    const registryEnabled = marketMetadata
      ? await this.chain.assetEnabled(marketMetadata.assetRegistry, assetAddress).catch(() => false)
      : false;
    if (vault === zeroAddress || !assetConfig.cleanverseReady
      || !this.config.V2_REPO_POLICY_POOL_REGISTERED
      || !this.config.V2_FEE_TREASURY_AUSDC_ELIGIBLE
      || !this.marketEntryConfigured(marketMetadata)
      || !sourceProof
      || !registryEnabled) reasons.push('VAULT_NOT_AUTHORIZED');
    const available = vault === zeroAddress ? 0n : await this.chain.vaultAvailable(vault, seller);
    const depositDeficit = available >= collateral ? 0n : collateral - available;
    let walletBalance = 0n;
    let allowance = 0n;
    if (depositDeficit > 0n) {
      [walletBalance, allowance] = await Promise.all([
        this.chain.balanceOf(assetAddress, seller),
        this.chain.allowance(assetAddress, seller, vault),
      ]);
      if (walletBalance < depositDeficit) reasons.push('INSUFFICIENT_BALANCE');
      if (allowance < depositDeficit) reasons.push('INSUFFICIENT_ALLOWANCE');
    }

    let ltvBps: number | null = null;
    let valuationDigest: `0x${string}` | null = null;
    let collateralValue = 0n;
    let riskTerms: Awaited<ReturnType<ChainService['riskConfig']>> | null = null;
    if (!marketMetadata) {
      reasons.push('CONTRACT_NOT_CONFIGURED');
    } else {
      try {
        riskTerms = await this.chain.riskConfig(marketMetadata.riskManager, assetAddress);
        if (!riskTerms.enabled) reasons.push('ASSET_NOT_ALLOWED');
        const valuation = await this.chain.freshPrice(
          marketMetadata.valuationOracle,
          assetAddress,
          this.settlementToken(),
          riskTerms.maxOracleAge,
        );
        valuationDigest = valuation.digest;
        const valueE18 = collateral * valuation.priceE18 / 10n ** BigInt(assetConfig.decimals);
        collateralValue = valueE18 * 10n ** 6n / 10n ** 18n;
        ltvBps = collateralValue === 0n
          ? Number.MAX_SAFE_INTEGER
          : Number((principal * 10_000n + collateralValue - 1n) / collateralValue);
        if (ltvBps > riskTerms.initialLtvBps) reasons.push('LTV_LIMIT_EXCEEDED');
      } catch {
        reasons.push('ORACLE_STALE');
      }
    }

    const edges: TransferEdge[] = depositDeficit > 0n ? [{
      token: assetAddress,
      from: seller,
      to: vault,
      amount: depositDeficit.toString(),
      purpose: 'COLLATERAL_DEPOSIT',
      policyPool: market,
    }] : [];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'CREATE_OFFER', resourceType: 'asset', resourceId: assetAddress });
    reasons.push(...evaluated.reasons);
    const sellerEligibility = await this.evaluateParticipants([seller], assetAddress, market, correlationId);
    reasons.push(...sellerEligibility.reasons);
    const transactions: Transaction[] = [];
    if (depositDeficit > 0n) {
      transactions.push({
        to: market,
        data: encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'depositCollateral', args: [assetAddress, depositDeficit] }),
        value: '0',
        description: `Top up ${depositDeficit} collateral units in the vault`,
      });
    }
    transactions.push({
      to: market,
      data: encodeFunctionData({
        abi: repoMarketV2Abi,
        functionName: 'createOffer',
        args: [{
          asset: assetAddress,
          collateralAmount: collateral,
          targetPrincipal: principal,
          minimumFill,
          annualRateBps: input.annualRateBps,
          duration: BigInt(input.durationSeconds),
          offerExpiry: BigInt(input.offerExpiry),
          permittedBuyer: (input.permittedBuyer ?? zeroAddress) as Address,
          earlyRepurchaseEnabled: input.earlyRepurchaseEnabled,
        }],
      }),
      value: '0',
      description: `Reserve ${collateral} collateral units and create the offer`,
    });
    if (reasons.length === 0 && depositDeficit === 0n) {
      try { await this.chain.simulateTransaction(seller, market, transactions.at(-1)!.data as `0x${string}`); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    } else if (reasons.length === 0 && allowance >= depositDeficit && depositDeficit > 0n) {
      try { await this.chain.simulateTransaction(seller, market, transactions[0]!.data as `0x${string}`); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...sellerEligibility.compliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: depositDeficit > 0n && allowance < depositDeficit
        ? [{ token: assetAddress, spender: vault, amount: depositDeficit.toString() }]
        : [],
      transactions,
      quote: this.quote('CREATE_OFFER', clock.block, clock.timestamp, {
        collateral: collateral.toString(),
        targetPrincipal: principal.toString(),
        minimumFill: minimumFill.toString(),
        vaultAvailable: available.toString(),
        depositDeficit: depositDeficit.toString(),
        ltvBps: ltvBps === null ? '0' : String(ltvBps),
        collateralValue: collateralValue.toString(),
      }, {
        offerStatus: 'OPEN',
        collateralBucket: 'OFFER_RESERVED',
        valuationDigest,
        defaultRateBps: riskTerms ? Math.min(input.annualRateBps + riskTerms.defaultSpreadBps, riskTerms.maxDefaultRateBps) : null,
        earlyMinHoldBps: riskTerms?.earlyMinHoldBps ?? null,
        earlyBreakFeeBps: riskTerms?.earlyBreakFeeBps ?? null,
      }),
      correlationId,
    };
  }

  async fill(input: FillOfferV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const actor = input.actor as Address;
    const offer = await this.store.getV2Offer(input.offerId, market);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'V2 offer was not found');
    const clock = await this.clock();
    const amount = BigInt(input.principalAmount);
    const remaining = BigInt(offer.remainingPrincipal);
    const minimum = BigInt(offer.minimumFill);
    const reasons: Reason[] = [];
    const marketMetadata = await this.chain.marketMetadata(market).catch(() => null);
    if (!this.config.V2_REPO_POLICY_POOL_REGISTERED || !this.config.V2_FEE_TREASURY_AUSDC_ELIGIBLE) {
      reasons.push('VAULT_NOT_AUTHORIZED');
    }
    if (!this.marketEntryConfigured(marketMetadata)) reasons.push('VAULT_NOT_AUTHORIZED');
    if (!['OPEN', 'PARTIALLY_FILLED'].includes(offer.status)) reasons.push('OFFER_NOT_OPEN');
    if (clock.timestamp > unix(offer.offerExpiry)) reasons.push('OFFER_EXPIRED');
    if (offer.permittedBuyer && offer.permittedBuyer !== actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
    if (offer.seller === actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
    if (amount <= 0n || amount > remaining) reasons.push('INVALID_FILL_AMOUNT');
    if (amount < minimum && amount !== remaining) reasons.push('BELOW_MINIMUM_FILL');
    let economics;
    let liveFill: Awaited<ReturnType<ChainService['previewFill']>> | null = null;
    try {
      liveFill = await this.chain.previewFill(market, BigInt(input.offerId), amount);
      const projected = calculateFillEconomics({
        totalCollateral: BigInt(offer.totalCollateral),
        targetPrincipal: BigInt(offer.targetPrincipal),
        remainingCollateral: BigInt(offer.remainingCollateral),
        remainingPrincipal: remaining,
        cumulativeFee: BigInt(offer.cumulativeFee),
        fillPrincipal: amount,
      });
      economics = {
        ...projected,
        collateral: liveFill.collateral.toString(),
        openingFee: liveFill.fee.toString(),
        sellerProceeds: liveFill.sellerProceeds.toString(),
      };
    } catch {
      reasons.push('INVALID_FILL_AMOUNT');
      economics = { principal: amount.toString(), collateral: '0', openingFee: '0', sellerProceeds: '0', remainingPrincipal: remaining.toString(), remainingCollateral: offer.remainingCollateral, cumulativeFeeAfter: offer.cumulativeFee };
    }
    const fee = BigInt(economics.openingFee);
    const sellerProceeds = BigInt(economics.sellerProceeds);
    const treasury = marketMetadata?.feeTreasury ?? await this.chain.feeTreasury(market);
    const [balance, allowance] = await Promise.all([
      this.chain.balanceOf(this.settlementToken(), actor),
      this.chain.allowance(this.settlementToken(), actor, market),
    ]);
    if (balance < amount) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < amount) reasons.push('INSUFFICIENT_ALLOWANCE');
    const edges: TransferEdge[] = [
      ...(sellerProceeds > 0n ? [{ token: this.settlementToken(), from: actor, to: offer.seller as Address, amount: sellerProceeds.toString(), purpose: 'PRINCIPAL' as const, policyPool: market }] : []),
      ...(fee > 0n ? [{ token: this.settlementToken(), from: actor, to: treasury, amount: fee.toString(), purpose: 'PROTOCOL_FEE' as const, policyPool: market }] : []),
    ];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'FILL_OFFER', resourceType: 'offer', resourceId: input.offerId });
    reasons.push(...evaluated.reasons);
    const [asset, liveAssetConfig] = await Promise.all([
      this.store.getAssetIncludingDisabled(offer.assetAddress as Address),
      this.chain.marketAssetConfig(market, offer.assetAddress as Address).catch(() => null),
    ]);
    if (!asset) reasons.push('ASSET_NOT_ALLOWED');
    if (!liveAssetConfig || liveAssetConfig.vault === zeroAddress || !liveAssetConfig.cleanverseReady) {
      reasons.push('VAULT_NOT_AUTHORIZED');
    }
    if (marketMetadata && liveAssetConfig) {
      const [sourceProof, registryEnabled] = await Promise.all([
        this.marketSourcesRegistered(market, marketMetadata, liveAssetConfig.vault),
        this.chain.assetEnabled(marketMetadata.assetRegistry, offer.assetAddress as Address).catch(() => false),
      ]);
      if (!sourceProof || !registryEnabled) reasons.push('VAULT_NOT_AUTHORIZED');
      try {
        const risk = await this.chain.riskConfig(marketMetadata.riskManager, offer.assetAddress as Address);
        if (!risk.enabled) reasons.push('ASSET_NOT_ALLOWED');
        const valuation = await this.chain.freshPrice(
          marketMetadata.valuationOracle,
          offer.assetAddress as Address,
          this.settlementToken(),
          risk.maxOracleAge,
        );
        const collateralValueE18 = BigInt(economics.collateral) * valuation.priceE18
          / 10n ** BigInt(liveAssetConfig.decimals);
        const collateralValue = collateralValueE18 * 10n ** 6n / 10n ** 18n;
        const ltv = collateralValue === 0n ? 10_001n : ceilDiv(amount * 10_000n, collateralValue);
        if (ltv > BigInt(risk.initialLtvBps)) reasons.push('LTV_LIMIT_EXCEEDED');
      } catch {
        reasons.push('ORACLE_STALE');
      }
    }
    const buyerAssetEligibility = asset
      ? await this.evaluateParticipants([actor, offer.seller as Address], offer.assetAddress as Address, market, correlationId)
      : { compliance: [] as PreflightResultV2['compliance'], reasons: [] as Reason[] };
    reasons.push(...buyerAssetEligibility.reasons);
    const fillData = encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'fillOffer', args: [BigInt(input.offerId), amount, fee] });
    if (reasons.length === 0 && allowance >= amount) {
      try { await this.chain.simulateTransaction(actor, market, fillData); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...buyerAssetEligibility.compliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: allowance < amount ? [{ token: this.settlementToken(), spender: market, amount: amount.toString() }] : [],
      transactions: [{
        to: market,
        data: fillData,
        value: '0',
        description: `Fill ${amount} principal units with a maximum ${fee} opening fee`,
      }],
      quote: this.quote('FILL', clock.block, clock.timestamp, economics, {
        offerId: input.offerId,
        offerStatus: amount === remaining ? 'FILLED' : 'PARTIALLY_FILLED',
        maturityAt: new Date(Number(clock.timestamp + BigInt(offer.durationSeconds)) * 1000).toISOString(),
      }),
      correlationId,
    };
  }

  async repay(input: RepayPositionV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const actor = input.actor as Address;
    const position = await this.store.getV2Position(input.positionId, market);
    if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'V2 position was not found');
    if (position.seller !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the seller can repurchase');
    const offer = await this.store.getV2Offer(position.offerId, market);
    if (!offer) throw new AppError(409, 'OFFER_PROJECTION_MISSING', 'The position offer projection is unavailable');
    const reasons: Reason[] = [];
    if (position.status !== 'ACTIVE') reasons.push('POSITION_NOT_ACTIVE');
    const clock = await this.clock();
    const marketMetadata = await this.chain.marketMetadata(market);
    if (!await this.marketSourcesRegistered(market, marketMetadata)) reasons.push('CONTRACT_NOT_CONFIGURED');
    const nowSeconds = clock.timestamp;
    let economics;
    try {
      economics = calculatePayoffEconomics({
        principal: BigInt(position.principal),
        annualRateBps: position.annualRateBps,
        defaultRateBps: position.defaultRateBps,
        acceptedAtSeconds: unix(position.acceptedAt),
        maturityAtSeconds: unix(position.maturityAt),
        timestampSeconds: nowSeconds,
        earlyRepurchaseEnabled: offer.earlyRepurchaseEnabled,
        minimumHoldSeconds: offer.minimumHoldSeconds,
        breakFeeBps: offer.breakFeeBps,
      });
    } catch {
      reasons.push('EARLY_REPURCHASE_DISABLED');
      economics = { principal: position.principal, contractualInterest: '0', defaultInterest: '0', breakFee: '0', payoff: position.principal, early: false };
    }
    const payoff = BigInt(economics.payoff);
    let livePayoff = payoff;
    try {
      livePayoff = await this.chain.previewPayoff(market, BigInt(input.positionId), nowSeconds);
    } catch {
      reasons.push('TRANSACTION_WOULD_REVERT');
    }
    economics.payoff = livePayoff.toString();
    const maxPayoff = input.maxPayoff ? BigInt(input.maxPayoff) : livePayoff;
    if (maxPayoff < livePayoff) reasons.push('SLIPPAGE_EXCEEDED');
    const settlementAsset = await this.store.getAssetIncludingDisabled(this.settlementToken());
    const settlementRequestId = settlementAsset?.cleanverseRequestId ?? this.config.AUSDC_CLEANVERSE_REQUEST_ID;
    const buyerCompliance = await this.compliance.verify(
      position.buyer as Address,
      this.settlementToken(),
      settlementRequestId,
      correlationId,
      market,
    );
    const useEscrow = !buyerCompliance.cviActive || !hasEligibleCviProof(buyerCompliance)
      || buyerCompliance.poolEligible !== true;
    const paymentRecipient = useEscrow
      ? marketMetadata.settlementEscrow
      : position.buyer as Address;
    if (!paymentRecipient) reasons.push('CONTRACT_NOT_CONFIGURED');
    const [balance, allowance] = await Promise.all([
      this.chain.balanceOf(this.settlementToken(), actor),
      this.chain.allowance(this.settlementToken(), actor, market),
    ]);
    if (balance < livePayoff) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < livePayoff) reasons.push('INSUFFICIENT_ALLOWANCE');
    const edges: TransferEdge[] = paymentRecipient ? [
      { token: this.settlementToken(), from: actor, to: paymentRecipient, amount: livePayoff.toString(), purpose: 'REPAYMENT', policyPool: market },
    ] : [];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'REPAY_POSITION', resourceType: 'position', resourceId: input.positionId });
    reasons.push(...evaluated.reasons);
    const repayData = encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'repurchase', args: [BigInt(input.positionId), maxPayoff, useEscrow] });
    if (reasons.length === 0 && allowance >= livePayoff) {
      try { await this.chain.simulateTransaction(actor, market, repayData); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: this.complianceFromGraph(evaluated.graph),
      transferGraph: evaluated.graph,
      requiredApprovals: allowance < livePayoff ? [{ token: this.settlementToken(), spender: market, amount: livePayoff.toString() }] : [],
      transactions: [{
        to: market,
        data: repayData,
        value: '0',
        description: useEscrow ? 'Repurchase and discharge payment into compliant escrow' : 'Repurchase and release collateral atomically',
      }],
      quote: this.quote('REPAY', clock.block, clock.timestamp, {
        principal: economics.principal,
        contractualInterest: economics.contractualInterest,
        defaultInterest: economics.defaultInterest,
        breakFee: economics.breakFee,
        payoff: economics.payoff,
        early: economics.early ? '1' : '0',
      }, { positionId: input.positionId, useEscrow }),
      correlationId,
    };
  }

  async buyAuction(input: AuctionActionV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const marketMetadata = await this.chain.marketMetadata(market);
    const auctionHouse = marketMetadata.auctionHouse;
    const actor = input.actor as Address;
    const auction = await this.store.getAuction(input.auctionId, auctionHouse);
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction was not found');
    const clock = await this.clock();
    const reasons: Reason[] = [];
    if (!await this.marketSourcesRegistered(market, marketMetadata)) reasons.push('CONTRACT_NOT_CONFIGURED');
    if (auction.status !== 'OPEN') reasons.push('AUCTION_NOT_OPEN');
    if (auction.seller.toLowerCase() === actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
    if (clock.timestamp > unix(auction.endsAt)) reasons.push('AUCTION_EXPIRED');
    const [livePrice, assetConfig] = await Promise.all([
      this.chain.auctionPrice(auctionHouse, BigInt(input.auctionId)),
      this.chain.marketAssetConfig(market, auction.assetAddress as Address),
    ]);
    if (!await this.marketSourcesRegistered(market, marketMetadata, assetConfig.vault)) reasons.push('CONTRACT_NOT_CONFIGURED');
    const maxPrice = input.maxPrice ? BigInt(input.maxPrice) : livePrice;
    if (maxPrice < livePrice) reasons.push('SLIPPAGE_EXCEEDED');
    const [balance, allowance] = await Promise.all([
      this.chain.balanceOf(this.settlementToken(), actor),
      this.chain.allowance(this.settlementToken(), actor, market),
    ]);
    if (balance < livePrice) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < livePrice) reasons.push('INSUFFICIENT_ALLOWANCE');
    const settlementEscrow = marketMetadata.settlementEscrow;
    if (!settlementEscrow) reasons.push('CONTRACT_NOT_CONFIGURED');
    const waterfall = calculateLiquidationWaterfall(livePrice, BigInt(auction.frozenDebt), auction.liquidationFeeBps);
    const edges: TransferEdge[] = [
      ...(settlementEscrow ? [{ token: this.settlementToken(), from: actor, to: settlementEscrow, amount: livePrice.toString(), purpose: 'AUCTION_PURCHASE' as const, policyPool: market }] : []),
      { token: auction.assetAddress as Address, from: assetConfig.vault, to: actor, amount: auction.collateralAmount, purpose: 'AUCTION_DELIVERY', policyPool: market },
    ];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'BUY_AUCTION', resourceType: 'auction', resourceId: input.auctionId });
    reasons.push(...evaluated.reasons);
    const buyData = encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'buyAuction', args: [BigInt(input.auctionId), maxPrice] });
    if (reasons.length === 0 && allowance >= livePrice) {
      try { await this.chain.simulateTransaction(actor, market, buyData); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: this.complianceFromGraph(evaluated.graph),
      transferGraph: evaluated.graph,
      requiredApprovals: allowance < livePrice ? [{ token: this.settlementToken(), spender: market, amount: livePrice.toString() }] : [],
      transactions: [{
        to: market,
        data: buyData,
        value: '0',
        description: `Buy auction collateral for at most ${maxPrice}`,
      }],
      quote: this.quote('AUCTION', clock.block, clock.timestamp, {
        currentPrice: livePrice.toString(),
        maxPrice: maxPrice.toString(),
        lenderProceeds: waterfall.lenderProceeds.toString(),
        liquidationFee: waterfall.liquidationFee.toString(),
        sellerSurplus: waterfall.sellerSurplus.toString(),
        lenderShortfall: waterfall.lenderShortfall.toString(),
      }, { auctionId: input.auctionId, statusAfter: 'SETTLED' }),
      correlationId,
    };
  }

  async offerLifecycle(input: OfferActionV2Input, action: 'cancelOffer' | 'finalizeOfferExpiry'): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const offer = await this.store.getV2Offer(input.offerId, market);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'V2 offer was not found');
    const reasons: Reason[] = [];
    if (!['OPEN', 'PARTIALLY_FILLED'].includes(offer.status)) reasons.push('OFFER_NOT_OPEN');
    if (action === 'cancelOffer' && offer.seller !== input.actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the seller can cancel an offer');
    const chainBlock = await this.chain.blockNumber();
    const chainTimestamp = await this.chain.blockTimestamp(chainBlock);
    if (action === 'finalizeOfferExpiry' && chainTimestamp <= unix(offer.offerExpiry)) reasons.push('OFFER_NOT_OPEN');
    return this.simpleLifecycleResult(correlationId, reasons, chainBlock, chainTimestamp, input.actor as Address, market, action, [BigInt(input.offerId)], 'offer', input.offerId);
  }

  async positionLifecycle(
    input: PositionLifecycleActionV2Input,
    action: 'startAuction' | 'claimDefaultCollateral' | 'claimCollateralOnOracleFailure',
  ): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const position = await this.store.getV2Position(input.positionId, market);
    if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'V2 position was not found');
    const reasons: Reason[] = [];
    const marketMetadata = await this.chain.marketMetadata(market);
    if (!await this.marketSourcesRegistered(market, marketMetadata)) reasons.push('CONTRACT_NOT_CONFIGURED');
    const chainBlock = await this.chain.blockNumber();
    const chainTimestamp = await this.chain.blockTimestamp(chainBlock);
    if (action === 'startAuction') {
      if (position.status !== 'ACTIVE') reasons.push('POSITION_NOT_ACTIVE');
      if (!isStrictlyAfter(chainTimestamp, unix(position.repaymentDeadline))) reasons.push('NOT_AT_MATURITY');
      const oracle = marketMetadata.valuationOracle;
      if (reasons.length === 0) {
        try {
          const fresh = await this.chain.hasFreshPrice(
            oracle,
            position.assetAddress as Address,
            position.settlementToken as Address,
            BigInt(position.maxOracleAgeSeconds),
          );
          if (!fresh) reasons.push('ORACLE_STALE');
        } catch {
          reasons.push('COMPLIANCE_UNAVAILABLE');
        }
      }
      return this.simpleLifecycleResult(
        correlationId,
        reasons,
        chainBlock,
        chainTimestamp,
        input.actor as Address,
        market,
        action,
        [BigInt(input.positionId)],
        'position',
        input.positionId,
      );
    }

    if (position.buyer !== input.actor.toLowerCase()) {
      throw new AppError(403, 'NOT_LENDER', 'Only the lender can claim collateral');
    }
    const recipient = (input.recipient ?? input.actor) as Address;
    if (action === 'claimDefaultCollateral') {
      if (position.status !== 'AUCTION_FAILED') reasons.push('POSITION_NOT_ACTIVE');
    } else {
      if (position.status !== 'ACTIVE') reasons.push('POSITION_NOT_ACTIVE');
      const fallbackOpensAt = unix(position.repaymentDeadline) + BigInt(position.staleOracleFallbackDelaySeconds);
      if (!isStrictlyAfter(chainTimestamp, fallbackOpensAt)) reasons.push('ORACLE_FALLBACK_NOT_OPEN');
      const oracle = marketMetadata.valuationOracle;
      if (!reasons.includes('ORACLE_FALLBACK_NOT_OPEN') && !reasons.includes('POSITION_NOT_ACTIVE')) {
        try {
          const fresh = await this.chain.hasFreshPrice(
            oracle,
            position.assetAddress as Address,
            position.settlementToken as Address,
            BigInt(position.maxOracleAgeSeconds),
          );
          if (fresh) reasons.push('ORACLE_STILL_LIVE');
        } catch {
          reasons.push('COMPLIANCE_UNAVAILABLE');
        }
      }
    }
    const assetConfig = await this.chain.marketAssetConfig(market, position.assetAddress as Address);
    // Readiness is an entry gate. A later operational pause must not block an
    // eligible lender from taking already-encumbered collateral.
    if (assetConfig.vault === zeroAddress) reasons.push('VAULT_NOT_AUTHORIZED');
    const edges: TransferEdge[] = [{
      token: position.assetAddress as Address,
      from: assetConfig.vault,
      to: recipient,
      amount: position.collateral,
      purpose: 'COLLATERAL_RELEASE',
      policyPool: market,
    }];
    const evaluated = await this.evaluateEdges(edges, correlationId, {
      action: action === 'claimDefaultCollateral' ? 'CLAIM_DEFAULT_COLLATERAL' : 'CLAIM_STALE_ORACLE_COLLATERAL',
      resourceType: 'position',
      resourceId: input.positionId,
    });
    reasons.push(...evaluated.reasons);
    const callerEligibility = await this.evaluateParticipants(
      [input.actor as Address],
      position.assetAddress as Address,
      market,
      correlationId,
    );
    reasons.push(...callerEligibility.reasons);
    const data = action === 'claimDefaultCollateral'
      ? encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'claimDefaultCollateral', args: [BigInt(input.positionId), recipient] })
      : encodeFunctionData({ abi: repoMarketV2Abi, functionName: 'claimCollateralOnOracleFailure', args: [BigInt(input.positionId), recipient] });
    if (reasons.length === 0) {
      try { await this.chain.simulateTransaction(input.actor as Address, market, data); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...callerEligibility.compliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: [],
      transactions: [{
        to: market,
        data,
        value: '0',
        description: action === 'claimDefaultCollateral'
          ? `Claim failed-auction collateral for position ${input.positionId}`
          : `Claim collateral after the bounded oracle-failure delay for position ${input.positionId}`,
      }],
      quote: this.quote('CLAIM', chainBlock, chainTimestamp, { collateral: position.collateral }, {
        positionId: input.positionId,
        recipient,
        statusAfter: 'COLLATERAL_CLAIMED',
        claimPath: action,
      }),
      correlationId,
    };
  }

  async finalizeFailedAuction(input: AuctionActionV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const marketMetadata = await this.chain.marketMetadata(market);
    const auction = await this.store.getAuction(input.auctionId, marketMetadata.auctionHouse);
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction was not found');
    const reasons: Reason[] = [];
    if (!await this.marketSourcesRegistered(market, marketMetadata)) reasons.push('CONTRACT_NOT_CONFIGURED');
    if (auction.status !== 'OPEN') reasons.push('AUCTION_NOT_OPEN');
    const chainBlock = await this.chain.blockNumber();
    const chainTimestamp = await this.chain.blockTimestamp(chainBlock);
    if (chainTimestamp <= unix(auction.endsAt)) reasons.push('AUCTION_NOT_OPEN');
    return this.simpleLifecycleResult(correlationId, reasons, chainBlock, chainTimestamp, input.actor as Address, market, 'finalizeFailedAuction', [BigInt(input.auctionId)], 'auction', input.auctionId);
  }

  async claimSettlement(input: SettlementClaimV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const market = this.market();
    const escrow = input.escrowAddress as Address;
    const marketMetadata = await this.chain.marketMetadata(market);
    const repoEscrow = marketMetadata.settlementEscrow;
    const marginEngine = this.config.MARGIN_ENGINE_V2_ADDRESS as Address | undefined;
    const marginMetadata = marginEngine ? await this.chain.marginMetadata(marginEngine).catch(() => null) : null;
    const policyPool = settlementClaimPolicyPool(escrow, market, repoEscrow, marginEngine, marginMetadata?.settlementEscrow);
    if (!policyPool) {
      throw new AppError(403, 'ESCROW_NOT_ALLOWED', 'Claim escrow is not an on-chain-proven RWCAR settlement escrow');
    }
    const claim = await this.store.getSettlementClaim(input.claimId, escrow);
    if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', 'Settlement claim was not found');
    if (claim.beneficiary !== input.actor.toLowerCase()) throw new AppError(403, 'NOT_BENEFICIARY', 'Only the claim beneficiary can withdraw');
    const amount = BigInt(input.amount);
    const remaining = BigInt(claim.remaining);
    const recipient = (input.recipient ?? input.actor) as Address;
    const reasons: Reason[] = [];
    if (claim.status !== 'PENDING' || amount <= 0n || amount > remaining) reasons.push('INVALID_FILL_AMOUNT');
    const edges: TransferEdge[] = amount > 0n ? [{
      token: claim.tokenAddress as Address,
      from: escrow,
      to: recipient,
      amount: amount.toString(),
      purpose: 'ESCROW_CLAIM',
      policyPool,
    }] : [];
    const evaluated = await this.evaluateEdges(edges, correlationId, { action: 'CLAIM_SETTLEMENT', resourceType: 'claim', resourceId: input.claimId });
    reasons.push(...evaluated.reasons);
    const callerEligibility = await this.evaluateParticipants(
      [input.actor as Address],
      claim.tokenAddress as Address,
      policyPool,
      correlationId,
    );
    reasons.push(...callerEligibility.reasons);
    const clock = await this.clock();
    const claimData = encodeFunctionData({ abi: settlementEscrowV2Abi, functionName: 'claim', args: [BigInt(input.claimId), amount, recipient] });
    if (reasons.length === 0) {
      try { await this.chain.simulateTransaction(input.actor as Address, escrow, claimData); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...callerEligibility.compliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: [],
      transactions: [{
        to: escrow,
        data: claimData,
        value: '0',
        description: `Withdraw ${amount} settlement units from claim ${input.claimId}`,
      }],
      quote: this.quote('CLAIM', clock.block, clock.timestamp, {
        amount: amount.toString(),
        remainingBefore: remaining.toString(),
        remainingAfter: amount <= remaining ? (remaining - amount).toString() : remaining.toString(),
      }, { claimId: input.claimId, escrowAddress: escrow, recipient }),
      correlationId,
    };
  }

  async marginAction(input: MarginActionV2Input): Promise<PreflightResultV2> {
    const correlationId = randomUUID();
    const clock = await this.clock();
    const engine = this.config.MARGIN_ENGINE_V2_ADDRESS as Address | undefined;
    const action = normalizeMarginAction(input.action);
    if (!engine) {
      return {
        eligible: false,
        blockingReasons: ['CONTRACT_NOT_CONFIGURED'],
        compliance: [],
        transferGraph: [],
        requiredApprovals: [],
        transactions: [],
        quote: this.quote('MARGIN', clock.block, clock.timestamp, { amount: input.amount ?? '0' }, {
          action,
          accountId: input.accountId ?? null,
          state: 'CONTRACT_NOT_CONFIGURED',
        }),
        correlationId,
      };
    }

    const actor = input.actor as Address;
    const metadata = await this.chain.marginMetadata(engine);
    const reasons: Reason[] = [];
    const edges: TransferEdge[] = [];
    const approvals: PreflightResultV2['requiredApprovals'] = [];
    const participantChecks: Array<{ wallets: Address[]; token: Address }> = [];
    const amounts: Record<string, string> = { amount: input.amount ?? '0' };
    const projectedState: PreflightResultV2['quote']['projectedState'] = {
      action,
      accountId: input.accountId ?? null,
      exposureId: input.exposureId ?? null,
      auctionId: input.auctionId ?? null,
    };
    let data: `0x${string}`;
    let description: string;
    let prerequisitesSatisfied = true;
    if (!await this.marginSourcesRegistered(engine, metadata)) reasons.push('CONTRACT_NOT_CONFIGURED');
    if (input.asset && input.asset.toLowerCase() !== metadata.asset.toLowerCase()) reasons.push('ASSET_NOT_ALLOWED');
    if (['DEPOSIT', 'OPEN_ACCOUNT', 'FUND_ACCOUNT'].includes(action)) {
      const assetEnabled = await this.chain.assetEnabled(metadata.assetRegistry, metadata.asset).catch(() => false);
      if (!assetEnabled) reasons.push('ASSET_NOT_ALLOWED');
    }

    // The feature flag controls new credit entry, never repayment or exit.
    if (['OPEN_ACCOUNT', 'FUND_ACCOUNT'].includes(action)) {
      if (!this.config.V2_MARGIN_ENABLED) reasons.push('MARGIN_ACCOUNT_RESTRICTED');
      if (!this.config.V2_MARGIN_POLICY_POOL_REGISTERED
        || !this.config.V2_MARGIN_VAULT_CUSTODY_READY
        || !this.config.V2_MARGIN_ESCROW_AUSDC_READY
        || !this.config.V2_MARGIN_TREASURY_AUSDC_ELIGIBLE
        || !metadata.cleanverseCustodyReady
        || metadata.entryPaused) reasons.push('VAULT_NOT_AUTHORIZED');
    }

    // Deposits are risk-reducing and remain available while new entry is
    // paused, but the destination must still be proven compliant custody.
    if (action === 'DEPOSIT'
      && (!this.config.V2_MARGIN_POLICY_POOL_REGISTERED
        || !this.config.V2_MARGIN_VAULT_CUSTODY_READY
        || !metadata.cleanverseCustodyReady)) reasons.push('VAULT_NOT_AUTHORIZED');

    const loadAccount = async (explicitId?: string) => {
      const accountId = BigInt(required(explicitId ?? input.accountId, 'accountId'));
      const account = await this.chain.marginAccount(engine, accountId);
      if (account.status === 0) throw new AppError(404, 'MARGIN_ACCOUNT_NOT_FOUND', 'Margin account was not found');
      return { accountId, account };
    };
    const loadExposure = async () => {
      const exposureId = BigInt(required(input.exposureId, 'exposureId'));
      const exposure = await this.chain.marginExposure(engine, exposureId);
      if (exposure.status === 0) throw new AppError(404, 'MARGIN_EXPOSURE_NOT_FOUND', 'Margin exposure was not found');
      const account = await this.chain.marginAccount(engine, exposure.accountId);
      return { exposureId, exposure, accountId: exposure.accountId, account };
    };

    if (action === 'DEPOSIT') {
      const amount = BigInt(required(input.amount, 'amount'));
      const [balance, allowance] = await Promise.all([
        this.chain.balanceOf(metadata.asset, actor),
        this.chain.allowance(metadata.asset, actor, metadata.vault),
      ]);
      if (balance < amount) reasons.push('INSUFFICIENT_BALANCE');
      if (allowance < amount) {
        reasons.push('INSUFFICIENT_ALLOWANCE');
        approvals.push({ token: metadata.asset, spender: metadata.vault, amount: amount.toString() });
      }
      edges.push({ token: metadata.asset, from: actor, to: metadata.vault, amount: amount.toString(), purpose: 'MARGIN_COLLATERAL', policyPool: engine });
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'depositCollateral', args: [amount] });
      description = `Deposit ${amount} CVA units into the margin vault`;
      projectedState.bucket = 'AVAILABLE';
    } else if (action === 'WITHDRAW') {
      const amount = BigInt(required(input.amount, 'amount'));
      const recipient = (input.recipient ?? actor) as Address;
      const available = await this.chain.vaultAvailable(metadata.vault, actor);
      if (available < amount) reasons.push('INSUFFICIENT_BALANCE');
      edges.push({ token: metadata.asset, from: metadata.vault, to: recipient, amount: amount.toString(), purpose: 'COLLATERAL_RELEASE', policyPool: engine });
      participantChecks.push({ wallets: [actor], token: metadata.asset });
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'withdrawAvailable', args: [amount, recipient] });
      description = `Withdraw ${amount} available margin collateral units`;
      amounts.availableBefore = available.toString();
      projectedState.recipient = recipient;
    } else if (action === 'OPEN_ACCOUNT') {
      const amount = BigInt(required(input.amount, 'amount'));
      const fundingTarget = BigInt(required(input.fundingTarget, 'fundingTarget'));
      const minimumFunding = BigInt(required(input.minimumFunding, 'minimumFunding'));
      const maxAnnualRateBps = required(input.maxAnnualRateBps, 'maxAnnualRateBps');
      const duration = BigInt(required(input.durationSeconds, 'durationSeconds'));
      const fundingExpiry = BigInt(required(input.fundingExpiry, 'fundingExpiry'));
      const permittedLender = (input.permittedLender ?? zeroAddress) as Address;
      const available = await this.chain.vaultAvailable(metadata.vault, actor);
      if (available < amount) reasons.push('INSUFFICIENT_BALANCE');
      if (amount <= 0n || amount > MAX_UINT128 || fundingTarget <= 0n || fundingTarget > MAX_UINT128
        || minimumFunding <= 0n || minimumFunding > fundingTarget) reasons.push('INVALID_FILL_AMOUNT');
      const allowedDurations = this.config.V2_ALLOWED_DURATIONS.split(',').map((value) => BigInt(value.trim()));
      if (!allowedDurations.includes(duration)) reasons.push('INVALID_DURATION');
      if (fundingExpiry <= clock.timestamp || fundingExpiry > clock.timestamp + 30n * 24n * 60n * 60n) reasons.push('INVALID_OFFER_EXPIRY');
      if (permittedLender.toLowerCase() === actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
      try {
        const liveRisk = await this.chain.riskConfig(metadata.riskManager, metadata.asset);
        if (!liveRisk.enabled) reasons.push('ASSET_NOT_ALLOWED');
      } catch {
        reasons.push('CONTRACT_NOT_CONFIGURED');
      }
      participantChecks.push({ wallets: [actor], token: metadata.asset });
      data = encodeFunctionData({
        abi: marginEngineV2Abi,
        functionName: 'openMarginAccount',
        args: [{
          collateralAmount: amount,
          fundingTarget,
          minimumFunding,
          maxAnnualRateBps,
          duration,
          fundingExpiry,
          permittedLender,
        }],
      });
      description = `Open a shared-collateral funding mandate with ${amount} collateral units`;
      amounts.availableBefore = available.toString();
      Object.assign(amounts, {
        fundingTarget: fundingTarget.toString(),
        minimumFunding: minimumFunding.toString(),
      });
      projectedState.statusAfter = 'HEALTHY';
    } else if (action === 'ADD_COLLATERAL') {
      const amount = BigInt(required(input.amount, 'amount'));
      const { accountId, account } = await loadAccount();
      if (account.seller.toLowerCase() !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the account seller can add collateral');
      const available = await this.chain.vaultAvailable(metadata.vault, actor);
      if (available < amount) reasons.push('INSUFFICIENT_BALANCE');
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'addMarginCollateral', args: [accountId, amount] });
      description = `Add ${amount} collateral units to margin account ${accountId}`;
      amounts.collateralAfter = (account.collateralAmount + amount).toString();
    } else if (action === 'WITHDRAW_EXCESS') {
      const amount = BigInt(required(input.amount, 'amount'));
      const recipient = (input.recipient ?? actor) as Address;
      const { accountId, account } = await loadAccount();
      if (account.seller.toLowerCase() !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the account seller can withdraw collateral');
      if (amount > account.collateralAmount) reasons.push('INSUFFICIENT_BALANCE');
      edges.push({ token: metadata.asset, from: metadata.vault, to: recipient, amount: amount.toString(), purpose: 'COLLATERAL_RELEASE', policyPool: engine });
      participantChecks.push({ wallets: [actor], token: metadata.asset });
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'withdrawExcessCollateral', args: [accountId, amount, recipient] });
      description = `Withdraw ${amount} excess collateral units from margin account ${accountId}`;
      amounts.collateralAfter = account.collateralAmount >= amount ? (account.collateralAmount - amount).toString() : '0';
      projectedState.recipient = recipient;
    } else if (action === 'FUND_ACCOUNT') {
      const principal = BigInt(required(input.amount, 'amount'));
      const annualRateBps = required(input.annualRateBps, 'annualRateBps');
      const { accountId, account } = await loadAccount();
      const duration = account.fundingDuration;
      const remainingFunding = account.fundingTarget - account.totalFunded;
      if (actor.toLowerCase() === account.seller.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
      if (account.permittedLender !== zeroAddress && actor.toLowerCase() !== account.permittedLender.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
      if (account.fundingClosed || clock.timestamp > account.fundingExpiry) reasons.push('OFFER_NOT_OPEN');
      if (principal <= 0n || principal > remainingFunding
        || (principal < account.minimumFunding && principal !== remainingFunding)) reasons.push('INVALID_FILL_AMOUNT');
      if (annualRateBps > account.maxAnnualRateBps) reasons.push('INVALID_RATE');
      const interest = ceilDiv(principal * BigInt(annualRateBps) * BigInt(duration), 10_000n * 365n * 24n * 60n * 60n);
      const faceDebt = principal + interest;
      try {
        const liveRisk = await this.chain.riskConfig(metadata.riskManager, metadata.asset);
        if (!liveRisk.enabled) reasons.push('ASSET_NOT_ALLOWED');
        const maxAge = account.maxOracleAge < liveRisk.maxOracleAge ? account.maxOracleAge : liveRisk.maxOracleAge;
        const valuation = await this.chain.freshPrice(
          metadata.valuationOracle,
          metadata.asset,
          metadata.settlementToken,
          maxAge,
        );
        const collateralValueE18 = account.collateralAmount * valuation.priceE18 / 10n ** BigInt(metadata.assetDecimals);
        const collateralValue = collateralValueE18 * 10n ** BigInt(metadata.settlementDecimals) / 10n ** 18n;
        const debtAfter = account.totalFaceDebt + faceDebt;
        const ltv = collateralValue === 0n ? 10_001n : ceilDiv(debtAfter * 10_000n, collateralValue);
        const ltvLimit = Math.min(account.initialLtvBps, liveRisk.initialLtvBps);
        if (ltv > BigInt(ltvLimit)) reasons.push('LTV_LIMIT_EXCEEDED');
        Object.assign(amounts, { collateralValue: collateralValue.toString(), ltvBps: ltv.toString() });
      } catch {
        reasons.push('ORACLE_STALE');
      }
      const cumulativeFee = ceilDiv((account.totalFunded + principal) * BigInt(metadata.protocolFeeBps), 10_000n);
      const fee = cumulativeFee - account.feeCharged;
      const maxFee = input.maxFee ? BigInt(input.maxFee) : fee;
      if (maxFee < fee) reasons.push('SLIPPAGE_EXCEEDED');
      const [balance, allowance] = await Promise.all([
        this.chain.balanceOf(metadata.settlementToken, actor),
        this.chain.allowance(metadata.settlementToken, actor, engine),
      ]);
      if (balance < principal) reasons.push('INSUFFICIENT_BALANCE');
      if (allowance < principal) {
        reasons.push('INSUFFICIENT_ALLOWANCE');
        approvals.push({ token: metadata.settlementToken, spender: engine, amount: principal.toString() });
      }
      const sellerProceeds = principal > fee ? principal - fee : 0n;
      if (sellerProceeds > 0n) edges.push({ token: metadata.settlementToken, from: actor, to: account.seller, amount: sellerProceeds.toString(), purpose: 'PRINCIPAL', policyPool: engine });
      if (fee > 0n) {
        const treasury = await this.evaluateParticipants([metadata.feeTreasury], metadata.settlementToken, engine, correlationId);
        const feeRecipient = treasury.reasons.length === 0 ? metadata.feeTreasury : metadata.settlementEscrow;
        edges.push({ token: metadata.settlementToken, from: actor, to: feeRecipient, amount: fee.toString(), purpose: 'PROTOCOL_FEE', policyPool: engine });
      }
      participantChecks.push({ wallets: [actor, account.seller], token: metadata.asset });
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'fundMarginAccount', args: [accountId, principal, annualRateBps, maxFee] });
      description = `Fund margin account ${accountId} with ${principal} settlement units`;
      Object.assign(amounts, { principal: principal.toString(), interest: interest.toString(), faceDebt: faceDebt.toString(), openingFee: fee.toString(), sellerProceeds: sellerProceeds.toString() });
      projectedState.maturityAt = new Date(Number(clock.timestamp + BigInt(duration)) * 1000).toISOString();
    } else if (action === 'REPAY') {
      const { exposureId, exposure, account } = await loadExposure();
      if (account.seller.toLowerCase() !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the account seller can repay an exposure');
      const maxFaceDebt = input.maxFaceDebt ? BigInt(input.maxFaceDebt) : exposure.faceDebt;
      if (maxFaceDebt < exposure.faceDebt) reasons.push('SLIPPAGE_EXCEEDED');
      const lenderEligibility = await this.evaluateParticipants([exposure.lender], metadata.settlementToken, engine, correlationId);
      const useEscrow = input.useEscrow ?? lenderEligibility.reasons.length > 0;
      const recipient = useEscrow ? metadata.settlementEscrow : exposure.lender;
      const [balance, allowance] = await Promise.all([
        this.chain.balanceOf(metadata.settlementToken, actor),
        this.chain.allowance(metadata.settlementToken, actor, engine),
      ]);
      if (balance < exposure.faceDebt) reasons.push('INSUFFICIENT_BALANCE');
      if (allowance < exposure.faceDebt) {
        reasons.push('INSUFFICIENT_ALLOWANCE');
        approvals.push({ token: metadata.settlementToken, spender: engine, amount: exposure.faceDebt.toString() });
      }
      edges.push({ token: metadata.settlementToken, from: actor, to: recipient, amount: exposure.faceDebt.toString(), purpose: 'REPAYMENT', policyPool: engine });
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'repayExposure', args: [exposureId, maxFaceDebt, useEscrow] });
      description = `Repay margin exposure ${exposureId} atomically`;
      amounts.faceDebt = exposure.faceDebt.toString();
      projectedState.useEscrow = useEscrow;
    } else if (action === 'DECLARE_PAYMENT_DEFAULT') {
      const { exposureId } = await loadExposure();
      data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'declarePaymentDefault', args: [exposureId] });
      description = `Declare payment default for exposure ${exposureId}`;
      projectedState.paymentDefaultDeclared = true;
    } else if (action === 'CLOSE_FUNDING' || action === 'OPEN_MARGIN_CALL' || action === 'CURE' || action === 'LIQUIDATE' || action === 'START_IN_KIND_ORACLE_FALLBACK' || action === 'CLOSE_ACCOUNT') {
      const { accountId, account } = await loadAccount();
      if (['CLOSE_FUNDING', 'CLOSE_ACCOUNT'].includes(action) && account.seller.toLowerCase() !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the account seller can perform this action');
      if (action === 'CLOSE_FUNDING') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'closeFunding', args: [accountId] });
        description = `Permanently close further funding for margin account ${accountId}`;
        projectedState.fundingClosed = true;
      } else if (action === 'OPEN_MARGIN_CALL') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'openMarginCall', args: [accountId] });
        description = `Open a margin call for account ${accountId}`;
        projectedState.statusAfter = 'MARGIN_CALL';
      } else if (action === 'CURE') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'cureMarginCall', args: [accountId] });
        description = `Cure the margin call for account ${accountId}`;
        projectedState.statusAfter = 'HEALTHY';
      } else if (action === 'LIQUIDATE') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'startMarginLiquidation', args: [accountId] });
        description = `Start the shared-collateral liquidation for account ${accountId}`;
        projectedState.statusAfter = 'LIQUIDATING';
      } else if (action === 'START_IN_KIND_ORACLE_FALLBACK') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'startInKindOracleFallback', args: [accountId] });
        description = `Start the bounded in-kind oracle fallback for account ${accountId}`;
        projectedState.statusAfter = 'AUCTION_FAILED';
      } else {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'closeMarginAccount', args: [accountId] });
        description = `Close debt-free margin account ${accountId}`;
        projectedState.statusAfter = 'CLOSED';
      }
    } else if (action === 'BUY_AUCTION' || action === 'FINALIZE_FAILED_AUCTION') {
      const auctionId = BigInt(required(input.auctionId, 'auctionId'));
      if (action === 'FINALIZE_FAILED_AUCTION') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'finalizeFailedMarginAuction', args: [auctionId] });
        description = `Finalize failed margin auction ${auctionId}`;
        projectedState.statusAfter = 'AUCTION_FAILED';
      } else {
        const auction = await this.store.getAuction(auctionId.toString(), metadata.auctionHouse);
        if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Margin auction projection was not found');
        if (auction.seller.toLowerCase() === actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
        const price = await this.chain.auctionPrice(metadata.auctionHouse, auctionId);
        const maxPrice = input.maxPrice ? BigInt(input.maxPrice) : price;
        if (maxPrice < price) reasons.push('SLIPPAGE_EXCEEDED');
        const [balance, allowance] = await Promise.all([
          this.chain.balanceOf(metadata.settlementToken, actor),
          this.chain.allowance(metadata.settlementToken, actor, engine),
        ]);
        if (balance < price) reasons.push('INSUFFICIENT_BALANCE');
        if (allowance < price) {
          reasons.push('INSUFFICIENT_ALLOWANCE');
          approvals.push({ token: metadata.settlementToken, spender: engine, amount: price.toString() });
        }
        edges.push({ token: metadata.settlementToken, from: actor, to: metadata.settlementEscrow, amount: price.toString(), purpose: 'AUCTION_PURCHASE', policyPool: engine });
        edges.push({ token: metadata.asset, from: metadata.vault, to: actor, amount: auction.collateralAmount, purpose: 'AUCTION_DELIVERY', policyPool: engine });
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'buyMarginAuction', args: [auctionId, maxPrice] });
        description = `Buy the complete collateral lot in margin auction ${auctionId}`;
        Object.assign(amounts, { currentPrice: price.toString(), maxPrice: maxPrice.toString() });
        projectedState.statusAfter = 'LIQUIDATED';
      }
    } else if (action === 'MATERIALIZE_LIQUIDATION_CLAIM' || action === 'CLAIM_FAILED_COLLATERAL') {
      const { exposureId, exposure, account } = await loadExposure();
      if (action === 'MATERIALIZE_LIQUIDATION_CLAIM') {
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'materializeLiquidationClaim', args: [exposureId] });
        description = `Materialize lender settlement claim for exposure ${exposureId}`;
        projectedState.claimBeneficiary = exposure.lender;
      } else {
        if (exposure.lender.toLowerCase() !== actor.toLowerCase()) throw new AppError(403, 'NOT_LENDER', 'Only the exposure lender can claim in-kind collateral');
        const recipient = (input.recipient ?? actor) as Address;
        let amount = 0n;
        try {
          amount = calculateProRataClaim(
            account.collateralAmount,
            account.remainingCollateral,
            exposure.faceDebt,
            account.frozenDebt,
            account.unclaimedExposureCount,
          );
        } catch {
          reasons.push('TRANSACTION_WOULD_REVERT');
        }
        edges.push({ token: metadata.asset, from: metadata.vault, to: recipient, amount: amount.toString(), purpose: 'COLLATERAL_RELEASE', policyPool: engine });
        participantChecks.push({ wallets: [actor], token: metadata.asset });
        data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'claimFailedCollateral', args: [exposureId, recipient] });
        description = `Claim pro-rata in-kind collateral for exposure ${exposureId}`;
        amounts.collateralClaim = amount.toString();
        projectedState.recipient = recipient;
      }
    } else {
      prerequisitesSatisfied = false;
      throw new AppError(400, 'UNSUPPORTED_MARGIN_ACTION', `Unsupported margin action ${action}`);
    }

    const marginResourceId = input.exposureId ?? input.auctionId ?? input.accountId;
    const evaluated = await this.evaluateEdges(edges, correlationId, {
      action: `MARGIN_${action}`,
      resourceType: input.exposureId ? 'margin_exposure' : input.auctionId ? 'margin_auction' : 'margin_account',
      ...(marginResourceId === undefined ? {} : { resourceId: marginResourceId }),
    });
    reasons.push(...evaluated.reasons);
    const standaloneCompliance: PreflightResultV2['compliance'] = [];
    for (const check of participantChecks) {
      const result = await this.evaluateParticipants(check.wallets, check.token, engine, correlationId);
      standaloneCompliance.push(...result.compliance);
      reasons.push(...result.reasons);
    }
    if (prerequisitesSatisfied && reasons.length === 0 && approvals.length === 0) {
      try {
        await this.chain.simulateTransaction(actor, engine, data);
      } catch {
        reasons.push('TRANSACTION_WOULD_REVERT');
      }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: uniqueCompliance([...this.complianceFromGraph(evaluated.graph), ...standaloneCompliance]),
      transferGraph: evaluated.graph,
      requiredApprovals: approvals,
      transactions: [{ to: engine, data, value: '0', description }],
      quote: this.quote('MARGIN', clock.block, clock.timestamp, amounts, projectedState),
      correlationId,
    };
  }

  private async simpleLifecycleResult(
    correlationId: CorrelationId,
    reasons: Reason[],
    chainBlock: bigint,
    chainTimestamp: bigint,
    actor: Address,
    market: Address,
    functionName: 'cancelOffer' | 'finalizeOfferExpiry' | 'startAuction' | 'finalizeFailedAuction',
    args: readonly [bigint],
    resourceType: string,
    resourceId: string,
  ): Promise<PreflightResultV2> {
    const data = encodeFunctionData({ abi: repoMarketV2Abi, functionName, args });
    if (reasons.length === 0) {
      try { await this.chain.simulateTransaction(actor, market, data); } catch { reasons.push('TRANSACTION_WOULD_REVERT'); }
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: unique(reasons),
      compliance: [],
      transferGraph: [],
      requiredApprovals: [],
      transactions: [{ to: market, data, value: '0', description: `${functionName} ${resourceType} ${resourceId}` }],
      quote: this.quote(functionName.includes('Auction') || functionName.includes('Collateral') ? 'AUCTION' : 'CREATE_OFFER', chainBlock, chainTimestamp, {}, { functionName, resourceType, resourceId }),
      correlationId,
    };
  }
}

export function normalizeMarginAction(action: MarginActionV2Input['action']) {
  if (action === 'DEPOSIT_COLLATERAL') return 'DEPOSIT';
  if (action === 'WITHDRAW_AVAILABLE') return 'WITHDRAW';
  if (action === 'REPAY_EXPOSURE') return 'REPAY';
  if (action === 'CURE_MARGIN_CALL') return 'CURE';
  if (action === 'START_LIQUIDATION') return 'LIQUIDATE';
  return action;
}

export function settlementClaimPolicyPool(
  escrow: Address,
  repoMarket: Address,
  repoEscrow?: Address,
  marginEngine?: Address,
  marginEscrow?: Address,
) {
  if (repoEscrow?.toLowerCase() === escrow.toLowerCase()) return repoMarket;
  if (marginEngine && marginEscrow?.toLowerCase() === escrow.toLowerCase()) return marginEngine;
  return undefined;
}
