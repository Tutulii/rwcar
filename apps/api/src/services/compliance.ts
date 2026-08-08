import { randomUUID } from 'node:crypto';
import {
  CONTRACTS,
  MONAD_TESTNET,
  type ComplianceResult,
  type TransferEdge,
  type TransferGraphCheck,
} from '@rwcar/shared';
import { complianceChecks, v2ComplianceDecisions, type RwcarDb } from '@rwcar/db';
import type { Address } from 'viem';
import type { ApiConfig } from '../config.js';
import type { ChainService } from './chain.js';
import type { CleanverseClient } from './cleanverse.js';

type Cached = { expires: number; value: ComplianceResult };
type CorrelationId = ReturnType<typeof randomUUID>;

export class ComplianceService {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly config: ApiConfig,
    private readonly db: RwcarDb,
    private readonly cleanverse: CleanverseClient,
    private readonly chain: ChainService,
  ) {}

  async verify(
    wallet: Address,
    asset: Address,
    requestId: string | undefined,
    correlationId = randomUUID(),
    policyPool?: Address,
  ): Promise<ComplianceResult> {
    const pool = policyPool ?? (this.config.REPO_MARKET_ADDRESS as Address | undefined);
    const normalizedAsset = asset.toLowerCase();
    const supportedSettlementFallback = requestId === undefined
      && normalizedAsset === this.config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase();
    if (!requestId && !supportedSettlementFallback) {
      throw new Error(`No Cleanverse request identifier configured for ${asset}`);
    }
    const key = `${wallet.toLowerCase()}:${normalizedAsset}:${requestId ?? 'cleanverse-supported-token'}:${pool?.toLowerCase() ?? 'none'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const [apass, verification, application] = await Promise.all([
      this.cleanverse.queryApass(MONAD_TESTNET.cleanverseChain, wallet),
      this.cleanverse.verifyApass(MONAD_TESTNET.cleanverseChain, asset, wallet),
      requestId
        ? this.issuedAssetApplication(requestId, asset)
        : this.supportedSettlementApplication(asset),
    ]);
    const applicationBound = application.chain === MONAD_TESTNET.cleanverseChain
      && application.tokenAddress === normalizedAsset;
    const poolEligible = pool
      ? await this.chain.poolEligible(CONTRACTS.validator, pool, wallet)
      : null;
    const value: ComplianceResult = {
      wallet,
      asset,
      cviActive: apass.active,
      tier: apass.tier,
      subTier: apass.subTier,
      apassStatus: apass.status,
      apassExpiresAt: apass.expiresAt,
      group: apass.group,
      subGroup: apass.subGroup,
      countries: apass.countries,
      verificationCode: verification.code,
      assetIssued: application.issued && applicationBound,
      assetPaused: application.paused || !application.pauseKnown || !applicationBound,
      poolEligible,
      checkedAt: new Date().toISOString(),
    };
    await this.db.insert(complianceChecks).values({
      correlationId,
      wallet: wallet.toLowerCase(),
      assetAddress: asset.toLowerCase(),
      cviActive: value.cviActive,
      tier: value.tier,
      verificationCode: value.verificationCode,
      assetIssued: value.assetIssued,
      assetPaused: value.assetPaused,
      poolEligible: value.poolEligible,
      rawResult: { apass: apass.raw, verification: verification.raw, application: application.raw },
    });
    this.cache.set(key, { expires: Date.now() + this.config.COMPLIANCE_CACHE_SECONDS * 1000, value });
    return value;
  }

  private async issuedAssetApplication(requestId: string, asset: Address) {
    const [application, policyState] = await Promise.all([
      this.cleanverse.queryAssetApplication(requestId),
      this.chain.tokenPolicyState(asset).catch(() => null),
    ]);
    return {
      ...application,
      paused: policyState?.paused ?? true,
      pauseKnown: policyState !== null,
      raw: {
        application: application.raw,
        verificationSource: 'query_apply_status+policy.isPaused',
        policyAddress: policyState?.policy ?? null,
        policyPaused: policyState?.paused ?? null,
      },
    };
  }

  private async supportedSettlementApplication(asset: Address) {
    const [supported, policyState] = await Promise.all([
      this.cleanverse.querySupportedAsset(MONAD_TESTNET.cleanverseChain, asset),
      this.chain.tokenPolicyState(asset),
    ]);
    return {
      issued: supported !== null,
      paused: policyState.paused,
      pauseKnown: true,
      status: supported ? 'SUPPORTED' : null,
      chain: supported?.chain ?? MONAD_TESTNET.cleanverseChain,
      tokenAddress: supported?.tokenAddress ?? null,
      raw: {
        verificationSource: 'query_deposit_atoken_list+policy.isPaused',
        supportedAsset: supported?.raw ?? null,
        policyAddress: policyState.policy,
        policyPaused: policyState.paused,
      },
    };
  }

  async evaluateTransferGraph(
    edges: TransferEdge[],
    requestIds: ReadonlyMap<string, string>,
    correlationId: CorrelationId,
    context: { action: string; resourceType: string; resourceId?: string },
  ): Promise<TransferGraphCheck[]> {
    const checks: TransferGraphCheck[] = [];
    for (const edge of edges) {
      const requestId = requestIds.get(edge.token.toLowerCase());
      const isSettlementToken = edge.token.toLowerCase() === this.config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase();
      if (!requestId && !isSettlementToken) {
        throw new Error(`No Cleanverse request identifier configured for ${edge.token}`);
      }
      const [fromCompliance, toCompliance] = await Promise.all([
        this.verify(edge.from as Address, edge.token as Address, requestId, correlationId, edge.policyPool as Address),
        this.verify(edge.to as Address, edge.token as Address, requestId, correlationId, edge.policyPool as Address),
      ]);
      const [fromRegisteredCustody, toRegisteredCustody] = await Promise.all([
        this.registeredCustody(edge, fromCompliance),
        this.registeredCustody(edge, toCompliance),
      ]);
      const fromBlockingReasons = decisionReasons(fromCompliance, fromRegisteredCustody);
      const toBlockingReasons = decisionReasons(toCompliance, toRegisteredCustody);
      const blockingReasons = [...new Set([
        ...fromBlockingReasons,
        ...toBlockingReasons,
      ])];
      const eligible = blockingReasons.length === 0;
      checks.push({ edge, fromCompliance, toCompliance, eligible, blockingReasons });

      await this.db.insert(v2ComplianceDecisions).values([
        decisionRow(edge, fromCompliance, correlationId, context, 'FROM', fromBlockingReasons, fromRegisteredCustody),
        decisionRow(edge, toCompliance, correlationId, context, 'TO', toBlockingReasons, toRegisteredCustody),
      ]);
    }
    return checks;
  }

  private async registeredCustody(edge: TransferEdge, result: ComplianceResult) {
    const factory = this.config.PROTOCOL_MODULE_FACTORY_V2_ADDRESS as Address | undefined;
    if (!factory || result.poolEligible !== false) return false;
    return this.chain.factoryCustodyRegistered(
      factory,
      edge.policyPool as Address,
      edge.token as Address,
      result.wallet as Address,
    ).catch(() => false);
  }
}

function decisionReasons(
  result: ComplianceResult,
  registeredCustody = false,
): TransferGraphCheck['blockingReasons'] {
  const reasons: TransferGraphCheck['blockingReasons'] = [];
  if (!result.cviActive) reasons.push(result.verificationCode === 2 ? 'CVI_MISSING' : 'CVI_INACTIVE');
  if (result.verificationCode !== 4 || (!registeredCustody && result.poolEligible === false)) reasons.push('CVI_INELIGIBLE');
  if (!result.assetIssued) reasons.push('CVA_NOT_ISSUED');
  if (result.assetPaused) reasons.push('CVA_PAUSED');
  if (!registeredCustody && result.poolEligible === null) reasons.push('COMPLIANCE_UNAVAILABLE');
  return reasons;
}

function decisionRow(
  edge: TransferEdge,
  result: ComplianceResult,
  correlationId: CorrelationId,
  context: { action: string; resourceType: string; resourceId?: string },
  role: 'FROM' | 'TO',
  blockingReasons: TransferGraphCheck['blockingReasons'],
  registeredCustody: boolean,
) {
  return {
    correlationId,
    chainId: MONAD_TESTNET.id,
    action: context.action,
    role: `${edge.purpose}_${role}`,
    policyPool: edge.policyPool.toLowerCase(),
    tokenAddress: edge.token.toLowerCase(),
    wallet: result.wallet.toLowerCase(),
    transferFrom: edge.from.toLowerCase(),
    transferTo: edge.to.toLowerCase(),
    transferAmount: edge.amount,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    decision: blockingReasons.length === 0 ? 'ALLOWED' : 'DENIED',
    verificationCode: result.verificationCode,
    cviActive: result.cviActive,
    assetIssued: result.assetIssued,
    assetPaused: result.assetPaused,
    poolEligible: result.poolEligible,
    ruleSnapshot: {
      tier: result.tier,
      subTier: result.subTier,
      group: result.group,
      subGroup: result.subGroup,
      countries: result.countries,
      apassStatus: result.apassStatus,
      apassExpiresAt: result.apassExpiresAt,
      registeredCustody,
    },
    rawResult: {
      verificationCode: result.verificationCode,
      checkedAt: result.checkedAt,
      registeredCustody,
      blockingReasons,
    },
  };
}
