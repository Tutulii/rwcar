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
    requestId: string,
    correlationId = randomUUID(),
    policyPool?: Address,
  ): Promise<ComplianceResult> {
    const pool = policyPool ?? (this.config.REPO_MARKET_ADDRESS as Address | undefined);
    const key = `${wallet.toLowerCase()}:${asset.toLowerCase()}:${requestId}:${pool?.toLowerCase() ?? 'none'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const [apass, verification, application] = await Promise.all([
      this.cleanverse.queryApass(MONAD_TESTNET.cleanverseChain, wallet),
      this.cleanverse.verifyApass(MONAD_TESTNET.cleanverseChain, asset, wallet),
      this.cleanverse.queryAssetApplication(requestId),
    ]);
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
      assetIssued: application.issued,
      assetPaused: application.paused,
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

  async evaluateTransferGraph(
    edges: TransferEdge[],
    requestIds: ReadonlyMap<string, string>,
    correlationId: CorrelationId,
    context: { action: string; resourceType: string; resourceId?: string },
  ): Promise<TransferGraphCheck[]> {
    const checks: TransferGraphCheck[] = [];
    for (const edge of edges) {
      const requestId = requestIds.get(edge.token.toLowerCase());
      if (!requestId) {
        throw new Error(`No Cleanverse request identifier configured for ${edge.token}`);
      }
      const [fromCompliance, toCompliance] = await Promise.all([
        this.verify(edge.from as Address, edge.token as Address, requestId, correlationId, edge.policyPool as Address),
        this.verify(edge.to as Address, edge.token as Address, requestId, correlationId, edge.policyPool as Address),
      ]);
      const blockingReasons = [...new Set([
        ...decisionReasons(fromCompliance),
        ...decisionReasons(toCompliance),
      ])];
      const eligible = blockingReasons.length === 0;
      checks.push({ edge, fromCompliance, toCompliance, eligible, blockingReasons });

      await this.db.insert(v2ComplianceDecisions).values([
        decisionRow(edge, fromCompliance, correlationId, context, 'FROM', eligible),
        decisionRow(edge, toCompliance, correlationId, context, 'TO', eligible),
      ]);
    }
    return checks;
  }
}

function decisionReasons(result: ComplianceResult): TransferGraphCheck['blockingReasons'] {
  const reasons: TransferGraphCheck['blockingReasons'] = [];
  if (!result.cviActive) reasons.push(result.verificationCode === 2 ? 'CVI_MISSING' : 'CVI_INACTIVE');
  if (result.verificationCode !== 4 || result.poolEligible === false) reasons.push('CVI_INELIGIBLE');
  if (!result.assetIssued) reasons.push('CVA_NOT_ISSUED');
  if (result.assetPaused) reasons.push('CVA_PAUSED');
  if (result.poolEligible === null) reasons.push('COMPLIANCE_UNAVAILABLE');
  return reasons;
}

function decisionRow(
  edge: TransferEdge,
  result: ComplianceResult,
  correlationId: CorrelationId,
  context: { action: string; resourceType: string; resourceId?: string },
  role: 'FROM' | 'TO',
  edgeEligible: boolean,
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
    decision: edgeEligible ? 'ALLOWED' : 'DENIED',
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
    },
    rawResult: { verificationCode: result.verificationCode, checkedAt: result.checkedAt },
  };
}
