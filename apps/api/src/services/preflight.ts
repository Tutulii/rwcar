import { randomUUID } from 'node:crypto';
import {
  CONTRACTS,
  MONAD_TESTNET,
  UAT_TERMS,
  type ComplianceResult,
  type CreatePreflightInput,
  type PreflightResult,
} from '@rwcar/shared';
import type { Address } from 'viem';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ChainService } from './chain.js';
import type { ComplianceService } from './compliance.js';
import { calculateEconomics } from './economics.js';
import type { StoreService } from './store.js';

type Reason = PreflightResult['blockingReasons'][number];

function complianceReasons(result: ComplianceResult, reasons: Reason[]) {
  if (!result.cviActive) reasons.push(result.verificationCode === 2 ? 'CVI_MISSING' : 'CVI_INACTIVE');
  if (result.verificationCode !== 4) reasons.push('CVI_INELIGIBLE');
  if (!result.assetIssued) reasons.push('CVA_NOT_ISSUED');
  if (result.assetPaused) reasons.push('CVA_PAUSED');
  if (result.poolEligible === false) reasons.push('CVI_INELIGIBLE');
  if (result.poolEligible === null) reasons.push('COMPLIANCE_UNAVAILABLE');
}

export class PreflightService {
  constructor(
    private readonly config: ApiConfig,
    private readonly store: StoreService,
    private readonly compliance: ComplianceService,
    private readonly chain: ChainService,
  ) {}

  private market(): Address {
    if (!this.config.REPO_MARKET_ADDRESS) throw new AppError(503, 'MARKET_NOT_DEPLOYED', 'RepoMarketV1 is not configured');
    return this.config.REPO_MARKET_ADDRESS as Address;
  }

  async create(input: CreatePreflightInput): Promise<PreflightResult> {
    const correlationId = randomUUID();
    const reasons: Reason[] = [];
    const assetAddress = input.asset as Address;
    const seller = input.seller as Address;
    const asset = await this.store.getAsset(assetAddress);
    if (!asset) throw new AppError(422, 'ASSET_NOT_ALLOWED', 'The selected CVA is not enabled');
    if (!UAT_TERMS.allowedDurations.includes(input.durationSeconds as 300)) {
      throw new AppError(422, 'INVALID_DURATION', 'Duration is not enabled for this environment');
    }
    if (input.offerExpiry <= Math.floor(Date.now() / 1000)) reasons.push('OFFER_EXPIRED');

    const result = await this.compliance.verify(seller, assetAddress, asset.cleanverseRequestId, correlationId);
    complianceReasons(result, reasons);
    if (!asset.enabled) reasons.push('ASSET_NOT_ALLOWED');
    const needed = BigInt(input.collateralAmount);
    const [balance, allowance] = await Promise.all([
      this.chain.balanceOf(assetAddress, seller),
      this.chain.allowance(assetAddress, seller, this.market()),
    ]);
    if (balance < needed) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < needed) reasons.push('INSUFFICIENT_ALLOWANCE');
    const economics = calculateEconomics(BigInt(input.principalAmount), input.annualRateBps, input.durationSeconds);
    return {
      eligible: reasons.length === 0,
      blockingReasons: [...new Set(reasons)],
      compliance: [result],
      requiredApprovals: allowance < needed ? [{ token: assetAddress, spender: this.market(), amount: needed.toString() }] : [],
      economics,
      correlationId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async accept(actor: Address, repoId: string): Promise<PreflightResult> {
    const correlationId = randomUUID();
    const reasons: Reason[] = [];
    const repo = await this.store.getRepo(repoId, this.market());
    if (!repo) throw new AppError(404, 'REPO_NOT_FOUND', 'Repo offer was not found');
    if (repo.status !== 'OPEN') reasons.push('OFFER_NOT_OPEN');
    if (repo.offerExpiry.getTime() <= Date.now()) reasons.push('OFFER_EXPIRED');
    if (repo.permittedBuyer && repo.permittedBuyer !== actor.toLowerCase()) reasons.push('BUYER_NOT_PERMITTED');
    const asset = await this.store.getAsset(repo.assetAddress as Address);
    if (!asset) throw new AppError(422, 'ASSET_NOT_ALLOWED', 'The repo CVA is no longer enabled');
    const treasury = await this.chain.feeTreasury(this.market());
    const [result, sellerCompliance, treasuryCompliance] = await Promise.all([
      this.compliance.verify(actor, repo.assetAddress as Address, asset.cleanverseRequestId, correlationId),
      this.compliance.verify(repo.seller as Address, repo.assetAddress as Address, asset.cleanverseRequestId, correlationId),
      this.compliance.verify(treasury, repo.assetAddress as Address, asset.cleanverseRequestId, correlationId),
    ]);
    complianceReasons(result, reasons);
    complianceReasons(sellerCompliance, reasons);
    complianceReasons(treasuryCompliance, reasons);
    const needed = BigInt(repo.principalAmount);
    const [balance, settlementAllowance, returnAllowance] = await Promise.all([
      this.chain.balanceOf(CONTRACTS.aUsdc, actor),
      this.chain.allowance(CONTRACTS.aUsdc, actor, this.market()),
      this.chain.allowance(repo.assetAddress as Address, actor, this.market()),
    ]);
    if (balance < needed) reasons.push('INSUFFICIENT_BALANCE');
    if (settlementAllowance < needed || returnAllowance < BigInt(repo.collateralAmount)) reasons.push('INSUFFICIENT_ALLOWANCE');
    const requiredApprovals = [];
    if (settlementAllowance < needed) requiredApprovals.push({ token: CONTRACTS.aUsdc, spender: this.market(), amount: needed.toString() });
    if (returnAllowance < BigInt(repo.collateralAmount)) {
      requiredApprovals.push({ token: repo.assetAddress as Address, spender: this.market(), amount: repo.collateralAmount });
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: [...new Set(reasons)],
      compliance: [result, sellerCompliance, treasuryCompliance],
      requiredApprovals,
      economics: calculateEconomics(needed, repo.annualRateBps, repo.durationSeconds),
      correlationId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async repurchase(actor: Address, repoId: string): Promise<PreflightResult> {
    const correlationId = randomUUID();
    const reasons: Reason[] = [];
    const repo = await this.store.getRepo(repoId, this.market());
    if (!repo) throw new AppError(404, 'REPO_NOT_FOUND', 'Repo position was not found');
    if (repo.status !== 'ACTIVE') reasons.push('OFFER_NOT_OPEN');
    if (repo.seller !== actor.toLowerCase()) throw new AppError(403, 'NOT_SELLER', 'Only the seller can repurchase');
    if (!repo.maturityAt || repo.maturityAt.getTime() > Date.now()) reasons.push('NOT_AT_MATURITY');
    if (repo.graceEndsAt && repo.graceEndsAt.getTime() < Date.now()) reasons.push('REPAYMENT_WINDOW_CLOSED');
    const asset = await this.store.getAsset(repo.assetAddress as Address);
    if (!asset) throw new AppError(422, 'ASSET_NOT_ALLOWED', 'The repo CVA is not enabled');
    const [sellerCompliance, buyerCompliance] = await Promise.all([
      this.compliance.verify(actor, repo.assetAddress as Address, asset.cleanverseRequestId, correlationId),
      this.compliance.verify(repo.buyer as Address, repo.assetAddress as Address, asset.cleanverseRequestId, correlationId),
    ]);
    complianceReasons(sellerCompliance, reasons);
    if (!buyerCompliance.cviActive || buyerCompliance.verificationCode !== 4 || buyerCompliance.poolEligible === false) reasons.push('RETURN_BLOCKED');
    const needed = BigInt(repo.repurchaseAmount ?? repo.principalAmount);
    const [balance, allowance, buyerAssetBalance, buyerReturnAllowance] = await Promise.all([
      this.chain.balanceOf(CONTRACTS.aUsdc, actor),
      this.chain.allowance(CONTRACTS.aUsdc, actor, this.market()),
      this.chain.balanceOf(repo.assetAddress as Address, repo.buyer as Address),
      this.chain.allowance(repo.assetAddress as Address, repo.buyer as Address, this.market()),
    ]);
    if (balance < needed) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < needed) reasons.push('INSUFFICIENT_ALLOWANCE');
    if (buyerAssetBalance < BigInt(repo.collateralAmount) || buyerReturnAllowance < BigInt(repo.collateralAmount)) {
      reasons.push('RETURN_BLOCKED');
    }
    return {
      eligible: reasons.length === 0,
      blockingReasons: [...new Set(reasons)],
      compliance: [sellerCompliance, buyerCompliance],
      requiredApprovals: allowance < needed ? [{ token: CONTRACTS.aUsdc, spender: this.market(), amount: needed.toString() }] : [],
      economics: calculateEconomics(BigInt(repo.principalAmount), repo.annualRateBps, repo.durationSeconds),
      correlationId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }
}
