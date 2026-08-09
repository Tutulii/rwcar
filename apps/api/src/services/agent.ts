import { createHash, randomUUID } from 'node:crypto';
import { PrivyClient } from '@privy-io/node';
import {
  agentApprovals,
  agentCredentials,
  agentEvents,
  agentIntents,
  agentIntentSteps,
  agentMandates,
  agents,
  institutionMembers,
  institutions,
  agentUsageBuckets,
  type RwcarDb,
} from '@rwcar/db';
import {
  AgentMandateConstraintsSchema,
  AgentScopeSchema,
  marginEngineV2Abi,
  repoMarketV2Abi,
  settlementEscrowV2Abi,
  type AgentAction,
  type AgentIntentState,
  type AgentMandateConstraints,
  type AgentScope,
  type PreflightResultV2,
} from '@rwcar/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  encodeFunctionData,
  decodeFunctionData,
  erc20Abi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import type { ApiConfig } from '../config.js';
import { AppError, UpstreamError } from '../errors.js';
import type { AuthClaims } from './auth.js';
import type { ChainService } from './chain.js';
import type { ComplianceService } from './compliance.js';
import type { CleanverseClient } from './cleanverse.js';
import { hasEligibleCviProof } from './compliance.js';
import { calculateFillEconomics } from './economics.js';
import { enrichMarginRiskRows } from './margin-risk.js';
import {
  AgentJwtService,
  canonicalHash,
  canonicalJson,
  generateCredential,
  hashClientSecret,
  intentApprovalTypedData,
  mandateTypedData,
  recoverMandateSigner,
  verifyClientSecret,
  walletBindingTypedData,
  type AgentTokenClaims,
} from './agent-crypto.js';
import { serializeRow, type StoreService } from './store.js';
import type { V2PreflightService } from './v2-preflight.js';

type IntentInput = Record<string, unknown> & { idempotencyKey: string };
type IntentRow = typeof agentIntents.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type MandateRow = typeof agentMandates.$inferSelect;
type AgentDbTransaction = Parameters<Parameters<RwcarDb['transaction']>[0]>[0];

const ACTIVE_INTENT_STATES = ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING'] as const;
const ALLOWANCE_ONLY = new Set(['INSUFFICIENT_ALLOWANCE']);
const SUPERVISED_RISK_ACTIONS = new Set<AgentAction>([
  'VAULT_WITHDRAW',
  'START_AUCTION',
  'BUY_AUCTION',
  'CLAIM_COLLATERAL',
  'CLAIM_ORACLE_FALLBACK',
  'MARGIN_ACTION',
]);

const BLOCKING_GUIDANCE: Record<string, { message: string; recovery: string }> = {
  ACTION_NOT_ALLOWED: {
    message: 'The active institutional mandate does not authorize this semantic action.',
    recovery: 'Ask the institution administrator to replace the mandate with this action explicitly enabled.',
  },
  ASSET_NOT_ALLOWED: {
    message: 'The asset is outside the active mandate or protocol allowlist.',
    recovery: 'Choose a verified allowed asset or ask the administrator to replace the mandate.',
  },
  ROLE_NOT_ALLOWED: {
    message: 'The bound wallet does not hold the on-chain role required for this action.',
    recovery: 'Use the seller, lender, beneficiary, or eligible third-party wallet identified by the resource guidance.',
  },
  PREREQUISITE_MISSING: {
    message: 'A required earlier workflow step or input is missing.',
    recovery: 'Complete the listed prerequisite and prepare a new intent with a fresh idempotency key.',
  },
  INSUFFICIENT_BALANCE: {
    message: 'Usable wallet and selected vault balances do not cover the requested amount.',
    recovery: 'Fund the wallet, reduce the amount, or select AUTO/REPO_VAULT collateral sourcing for a margin deposit.',
  },
  ORACLE_STALE: {
    message: 'The approved signed valuation is outside its live validity window.',
    recovery: 'Wait for the server-managed oracle heartbeat and prepare again; agents never post arbitrary valuations.',
  },
  NOT_AT_MATURITY: {
    message: 'The repayment grace deadline has not passed on Monad.',
    recovery: 'Wait until the chain timestamp is strictly after repaymentDeadline, then prepare again.',
  },
  POSITION_NOT_ACTIVE: {
    message: 'The position has already left the repayable ACTIVE lifecycle.',
    recovery: 'Refresh get_portfolio and follow its role-specific auction or claim nextActions; do not retry repayment against an auctioned position.',
  },
  CVI_INELIGIBLE: {
    message: 'The wallet does not satisfy the live Cleanverse policy pool.',
    recovery: 'Refresh A-Pass/CVI eligibility for this wallet and asset before preparing again.',
  },
  POLICY_DENIED: {
    message: 'Institutional policy denied the prepared action.',
    recovery: 'Inspect the mandate and prepare a corrected bounded action.',
  },
  ADMIN_REJECTED: {
    message: 'The institution administrator rejected this exact intent.',
    recovery: 'Do not execute it. If the user still wants the action, revise the terms and prepare a new intent for review.',
  },
  RECIPIENT_NOT_ALLOWED: {
    message: 'The requested recipient is neither the agent wallet nor an address admitted by the signed mandate.',
    recovery: 'Withdraw to the bound agent wallet or ask the administrator to add the recipient in a replacement mandate.',
  },
};

const MARKET_FUNCTIONS: Record<Exclude<AgentAction, 'CLAIM_SETTLEMENT' | 'MARGIN_ACTION'>, Set<string>> = {
  VAULT_DEPOSIT: new Set(['depositCollateral']),
  VAULT_WITHDRAW: new Set(['withdrawCollateral']),
  CREATE_OFFER: new Set(['depositCollateral', 'createOffer']),
  FILL_OFFER: new Set(['fillOffer']),
  CANCEL_OFFER: new Set(['cancelOffer']),
  FINALIZE_OFFER_EXPIRY: new Set(['finalizeOfferExpiry']),
  REPAY_POSITION: new Set(['repurchase']),
  START_AUCTION: new Set(['startAuction']),
  CLAIM_COLLATERAL: new Set(['claimDefaultCollateral']),
  CLAIM_ORACLE_FALLBACK: new Set(['claimCollateralOnOracleFailure']),
  BUY_AUCTION: new Set(['buyAuction']),
  FINALIZE_FAILED_AUCTION: new Set(['finalizeFailedAuction']),
};

const MARGIN_FUNCTION_BY_ACTION: Record<string, string> = {
  DEPOSIT: 'depositCollateral',
  DEPOSIT_COLLATERAL: 'depositCollateral',
  WITHDRAW: 'withdrawAvailable',
  WITHDRAW_AVAILABLE: 'withdrawAvailable',
  OPEN_ACCOUNT: 'openMarginAccount',
  ADD_COLLATERAL: 'addMarginCollateral',
  WITHDRAW_EXCESS: 'withdrawExcessCollateral',
  FUND_ACCOUNT: 'fundMarginAccount',
  CLOSE_FUNDING: 'closeFunding',
  REPAY: 'repayExposure',
  REPAY_EXPOSURE: 'repayExposure',
  DECLARE_PAYMENT_DEFAULT: 'declarePaymentDefault',
  OPEN_MARGIN_CALL: 'openMarginCall',
  CURE: 'cureMarginCall',
  CURE_MARGIN_CALL: 'cureMarginCall',
  LIQUIDATE: 'startMarginLiquidation',
  START_LIQUIDATION: 'startMarginLiquidation',
  BUY_AUCTION: 'buyMarginAuction',
  FINALIZE_FAILED_AUCTION: 'finalizeFailedMarginAuction',
  START_IN_KIND_ORACLE_FALLBACK: 'startInKindOracleFallback',
  MATERIALIZE_LIQUIDATION_CLAIM: 'materializeLiquidationClaim',
  CLAIM_FAILED_COLLATERAL: 'claimFailedCollateral',
  CLOSE_ACCOUNT: 'closeMarginAccount',
};

function requiredAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) throw new AppError(503, 'CONTRACT_NOT_CONFIGURED', `${name} is not configured`);
  return value.toLowerCase() as Address;
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function moveUsageReservation(tx: AgentDbTransaction, intent: IntentRow, completed: boolean) {
  if (BigInt(intent.reservedNotional) === 0n) return;
  const bucketStart = startOfUtcDay(intent.createdAt);
  const [bucket] = await tx.select().from(agentUsageBuckets).where(and(
    eq(agentUsageBuckets.agentId, intent.agentId),
    eq(agentUsageBuckets.mandateId, intent.mandateId),
    eq(agentUsageBuckets.bucketStart, bucketStart),
  )).limit(1);
  if (!bucket) return;
  const reserved = BigInt(bucket.reservedNotional);
  const released = BigInt(intent.reservedNotional);
  await tx.update(agentUsageBuckets).set({
    reservedNotional: (reserved >= released ? reserved - released : 0n).toString(),
    completedNotional: (BigInt(bucket.completedNotional) + (completed ? released : 0n)).toString(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentUsageBuckets.agentId, intent.agentId),
    eq(agentUsageBuckets.mandateId, intent.mandateId),
    eq(agentUsageBuckets.bucketStart, bucketStart),
  ));
}

async function lockAgentAuthority(tx: AgentDbTransaction, agentId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-authority:${agentId}`}))`);
}

async function terminateIntentInTransaction(
  tx: AgentDbTransaction,
  intent: IntentRow,
  state: Extract<AgentIntentState, 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'FAILED_WITH_ALLOWANCE'>,
  code: string,
  message: string,
  fromStates: AgentIntentState[] = [...ACTIVE_INTENT_STATES],
) {
  const [updated] = await tx.update(agentIntents).set({
    state,
    errorCode: code,
    errorMessage: message,
    updatedAt: new Date(),
  }).where(and(eq(agentIntents.id, intent.id), inArray(agentIntents.state, fromStates))).returning();
  if (!updated) return false;
  await moveUsageReservation(tx, intent, false);
  await tx.insert(agentEvents).values({
    agentId: intent.agentId,
    intentId: intent.id,
    eventType: `INTENT_${state}`,
    payload: { code, message },
  });
  return true;
}

function scopeFor(action: AgentAction): AgentScope {
  if (action.startsWith('VAULT_')) return 'vault:write';
  if (['CREATE_OFFER', 'FILL_OFFER', 'CANCEL_OFFER', 'FINALIZE_OFFER_EXPIRY'].includes(action)) return 'offers:write';
  if (['REPAY_POSITION', 'START_AUCTION', 'CLAIM_COLLATERAL', 'CLAIM_ORACLE_FALLBACK'].includes(action)) return 'positions:write';
  if (['BUY_AUCTION', 'FINALIZE_FAILED_AUCTION'].includes(action)) return 'auctions:write';
  if (action === 'CLAIM_SETTLEMENT') return 'claims:write';
  return 'margin:write';
}

function isExecutablePreflight(preflight: PreflightResultV2) {
  return preflight.eligible || preflight.blockingReasons.every((reason) => ALLOWANCE_ONLY.has(reason));
}

function intentNextActions(state: AgentIntentState, reasons: string[], agentId: string, intentId: string) {
  if (state === 'APPROVAL_REQUIRED') return [{
    action: 'REQUEST_ADMIN_APPROVAL',
    description: `Ask the institution administrator to review intent ${intentId} in the RWCAR Agent Console.`,
    agentId,
    intentId,
  }];
  if (state === 'PREPARED' || state === 'APPROVED') return [{
    action: 'EXECUTE_INTENT',
    description: 'Call execute_intent with this exact intentId and intentHash before expiry.',
    intentId,
  }];
  if (['QUEUED', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING'].includes(state)) return [{
    action: 'GET_EXECUTION_STATUS',
    description: 'Wait for the durable state event or poll get_execution_status; do not create a duplicate intent.',
    intentId,
  }];
  if (state === 'COMPLETED') return [{
    action: 'REFRESH_PROTOCOL_STATE',
    description: 'Refresh portfolio, margin accounts, or auctions from the finalized projection.',
  }];
  const actions: Array<{ action: string; description: string }> = [];
  if (reasons.includes('ACTION_NOT_ALLOWED')) actions.push({
    action: 'ADMIN_REPLACE_MANDATE',
    description: 'The institution administrator must sign a replacement mandate that explicitly allows this action.',
  });
  if (reasons.includes('ORACLE_STALE')) actions.push({
    action: 'WAIT_FOR_ORACLE_HEARTBEAT',
    description: 'Use get_protocol_info or get_portfolio until oracleFresh is true, then prepare a new intent.',
  });
  if (reasons.includes('INSUFFICIENT_BALANCE')) actions.push({
    action: 'FUND_OR_SELECT_COLLATERAL_SOURCE',
    description: 'Fund the wallet, reduce the amount, or use collateralSource AUTO/REPO_VAULT for margin deposits.',
  });
  if (actions.length === 0) actions.push({
    action: 'CORRECT_AND_REPREPARE',
    description: 'Resolve every blocking reason, then prepare a new intent with a fresh UUID idempotency key.',
  });
  return actions;
}

export function deriveRepoPositionLifecycle(
  position: { status: string; seller: string; buyer: string; repaymentDeadline: Date },
  wallet: Address,
  chainTimestamp: bigint,
  oracleFresh: boolean,
) {
  const normalizedWallet = wallet.toLowerCase();
  const role = position.seller === normalizedWallet ? 'SELLER' : position.buyer === normalizedWallet ? 'LENDER' : 'OBSERVER';
  const deadline = BigInt(Math.floor(position.repaymentDeadline.getTime() / 1_000));
  const overdue = position.status === 'ACTIVE' && chainTimestamp > deadline;
  const lifecycleState = overdue ? 'OVERDUE' : position.status;
  const nextActions: Array<{ action: string; actorRole: string; description: string }> = [];
  if (position.status === 'ACTIVE' && role === 'SELLER') nextActions.push({
    action: 'REPAY',
    actorRole: 'SELLER',
    description: overdue
      ? 'Repay immediately before the automatic default transaction lands.'
      : 'Repay at or before the grace deadline; early-repurchase terms remain enforced on-chain.',
  });
  if (overdue) {
    nextActions.push({
      action: oracleFresh ? 'START_AUCTION' : 'WAIT_FOR_ORACLE_HEARTBEAT',
      actorRole: 'ANY_AUTHORIZED_KEEPER',
      description: oracleFresh
        ? 'Default is open. The durable keeper is scheduled; any mandate-authorized positions agent may also prepare START_AUCTION.'
        : 'Default is open but the signed valuation must be refreshed by the server-managed heartbeat first.',
    });
  }
  if (position.status === 'AUCTION') nextActions.push({
    action: 'LIST_AUCTIONS',
    actorRole: 'ELIGIBLE_NON_SELLER',
    description: 'Read the live Dutch price; the first successful eligible purchase closes the auction.',
  });
  if (position.status === 'AUCTION_FAILED' && role === 'LENDER') nextActions.push({
    action: 'CLAIM_COLLATERAL',
    actorRole: 'LENDER',
    description: 'Claim the lender collateral recovery after failed-auction finalization.',
  });
  return { onChainStatus: position.status, lifecycleState, role, overdue, nextActions };
}

export function resolveIntentDiagnostics(
  state: string,
  approvalReason: string | null,
  errorCode: string | null,
  preflight: Partial<PreflightResultV2>,
) {
  const approvalWillResolveAllowance = (preflight.requiredApprovals?.length ?? 0) > 0;
  const preflightReasons = (preflight.blockingReasons ?? []).filter((reason) =>
    reason !== 'INSUFFICIENT_ALLOWANCE' || !approvalWillResolveAllowance);
  const policyReasons = state === 'DENIED' && approvalReason
    ? approvalReason.split(',').map((reason) => reason.trim()).filter(Boolean)
    : [];
  const failureReasons = ['DENIED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'REVERTED', 'FAILED', 'FAILED_WITH_ALLOWANCE'].includes(state)
    && errorCode ? [errorCode] : [];
  const blockingReasons = [...new Set([...policyReasons, ...preflightReasons, ...failureReasons])];
  if (state === 'DENIED' && blockingReasons.length === 0) blockingReasons.push('POLICY_DENIED');
  if (state === 'REJECTED' && blockingReasons.length === 0) blockingReasons.push('ADMIN_REJECTED');
  return {
    blockingReasons,
    resolvedByTransactions: approvalWillResolveAllowance ? ['INSUFFICIENT_ALLOWANCE'] : [],
  };
}

export function preflightMatchesRemainingProtocolSteps(
  saved: Array<{ kind: string; status: string; destination: string; calldata: string; nativeValue: string }>,
  transactions: PreflightResultV2['transactions'],
) {
  const remaining = saved.filter((step) => step.kind === 'PROTOCOL'
    && step.status !== 'CONFIRMED' && step.status !== 'SKIPPED');
  return remaining.length === transactions.length && remaining.every((step, index) => {
    const current = transactions[index];
    return current && step.destination.toLowerCase() === current.to.toLowerCase()
      && step.calldata.toLowerCase() === current.data.toLowerCase()
      && step.nativeValue === current.value;
  });
}

function firstUint(...candidates: unknown[]): bigint {
  for (const value of candidates) {
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  }
  return 0n;
}

// Mandate notional is denominated in settlement-token base units. Collateral
// quantities are deliberately not compared as though one CVA unit equalled one
// aUSDC; collateral-only movements are separately action-gated and remain
// bounded by vault availability plus the signed execution mode.
function notionalFrom(action: AgentAction, preflight: PreflightResultV2, input: IntentInput): bigint {
  const amounts = preflight.quote.amounts;
  if (action === 'CREATE_OFFER') return firstUint(amounts.targetPrincipal, input.targetPrincipal);
  if (action === 'FILL_OFFER') return firstUint(amounts.principal, input.principalAmount);
  if (action === 'REPAY_POSITION') return firstUint(amounts.payoff, input.maxPayoff);
  if (action === 'BUY_AUCTION') return firstUint(input.maxPrice, amounts.currentPrice, amounts.maxPrice);
  if (action === 'CLAIM_SETTLEMENT') return firstUint(amounts.amount, input.amount);
  if (action === 'MARGIN_ACTION') {
    const marginAction = typeof input.action === 'string' ? input.action : '';
    if (marginAction === 'OPEN_ACCOUNT') return firstUint(input.fundingTarget, amounts.fundingTarget);
    if (marginAction === 'FUND_ACCOUNT') return firstUint(amounts.principal, input.amount);
    if (['REPAY', 'REPAY_EXPOSURE'].includes(marginAction)) return firstUint(amounts.faceDebt, input.maxFaceDebt);
    if (marginAction === 'BUY_AUCTION') return firstUint(input.maxPrice, amounts.currentPrice, amounts.price);
  }
  return 0n;
}

export function resolveMandateApproval(
  constraints: AgentMandateConstraints,
  action: AgentAction,
  notional: bigint,
) {
  if (constraints.executionMode === 'AUTONOMOUS') {
    return { decision: 'AUTO_APPROVED' as const, reason: null };
  }
  if (SUPERVISED_RISK_ACTIONS.has(action)) {
    return { decision: 'HUMAN_REQUIRED' as const, reason: 'RISK_SENSITIVE_ACTION' };
  }
  if (notional > BigInt(constraints.autoExecuteUpTo)) {
    return { decision: 'HUMAN_REQUIRED' as const, reason: 'AUTO_EXECUTE_LIMIT_EXCEEDED' };
  }
  return { decision: 'AUTO_APPROVED' as const, reason: null };
}

function publicIntent(row: IntentRow, steps: Array<typeof agentIntentSteps.$inferSelect> = []) {
  const preflight = (row.preflight ?? {}) as PreflightResultV2;
  const { blockingReasons, resolvedByTransactions } = resolveIntentDiagnostics(
    row.state,
    row.approvalReason,
    row.errorCode,
    preflight,
  );
  const quote = preflight.quote ?? null;
  return serializeRow({
    intentId: row.id,
    intentHash: row.intentHash,
    action: row.action,
    state: row.state,
    policyDecision: row.policyDecision,
    approvalRequired: row.approvalRequired,
    approvalReason: row.approvalReason,
    correlationId: row.correlationId,
    blockingReasons,
    blockingDetails: blockingReasons.map((code) => ({
      code,
      ...(BLOCKING_GUIDANCE[code] ?? {
        message: `The action is blocked by ${code}.`,
        recovery: 'Inspect the resource state and prepare a corrected intent after the condition is resolved.',
      }),
    })),
    resolvedByTransactions,
    nextActions: intentNextActions(row.state as AgentIntentState, blockingReasons, row.agentId, row.id),
    quote,
    projectedState: quote?.projectedState ?? null,
    freshness: {
      chainBlock: quote?.chainBlock ?? null,
      chainTimestamp: quote?.chainTimestamp ?? null,
      quoteExpiresAt: row.quoteExpiresAt,
      intentUpdatedAt: row.updatedAt,
    },
    approvalHandoff: row.state === 'APPROVAL_REQUIRED' ? {
      signerRole: 'INSTITUTION_ADMIN',
      challengeEndpoint: `/v2/agents/${row.agentId}/intents/${row.id}/approval/challenge`,
      submissionEndpoint: `/v2/agents/${row.agentId}/intents/${row.id}/approval`,
      intentId: row.id,
      intentHash: row.intentHash,
    } : null,
    reservedNotional: row.reservedNotional,
    txHash: row.txHash,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    expiresAt: row.intentExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    transactionSummary: steps.map((step) => ({
      stepIndex: step.stepIndex,
      kind: step.kind,
      to: step.destination,
      selector: step.calldata.slice(0, 10),
      value: step.nativeValue,
      description: step.description,
      status: step.status,
      txHash: step.txHash,
    })),
  });
}

export class AgentService {
  readonly jwt: AgentJwtService | undefined;
  private readonly dummySecretHash: Promise<string>;
  private readonly privy: PrivyClient;

  constructor(
    private readonly config: ApiConfig,
    private readonly db: RwcarDb,
    private readonly store: StoreService,
    private readonly compliance: ComplianceService,
    private readonly chain: ChainService,
    private readonly preflight: V2PreflightService,
    private readonly cleanverse: CleanverseClient,
  ) {
    this.jwt = config.AGENT_PLATFORM_ENABLED ? new AgentJwtService(config) : undefined;
    this.privy = new PrivyClient({ appId: config.PRIVY_APP_ID, appSecret: config.PRIVY_APP_SECRET });
    // Keep unknown-client and wrong-secret authentication paths close in cost
    // so client identifiers cannot be enumerated through a cheap timing probe.
    this.dummySecretHash = config.AGENT_PLATFORM_ENABLED
      ? hashClientSecret(generateCredential().clientSecret)
      : Promise.resolve('');
  }

  assertEnabled() {
    if (!this.config.AGENT_PLATFORM_ENABLED || !this.jwt) {
      throw new AppError(503, 'AGENT_PLATFORM_DISABLED', 'The agent platform is not enabled on this deployment');
    }
  }

  private market() {
    return requiredAddress(this.config.REPO_MARKET_V2_ADDRESS, 'RepoMarketV2');
  }

  private assertPrivySignerPolicy(signerId: string, policyId: string) {
    if (signerId !== this.config.PRIVY_AGENT_SIGNER_ID || policyId !== this.config.PRIVY_AGENT_POLICY_ID) {
      throw new AppError(403, 'UNTRUSTED_AGENT_SIGNER_POLICY', 'The agent wallet must use the deployment-reviewed Privy signer and policy');
    }
  }

  private async assertLivePrivyWallet(input: {
    walletAddress: Address;
    privyWalletId: string;
    signerId: string;
    policyId: string;
  }) {
    let wallet: Awaited<ReturnType<ReturnType<PrivyClient['wallets']>['get']>>;
    try {
      wallet = await this.privy.wallets().get(input.privyWalletId);
    } catch {
      throw new UpstreamError('Privy', 'The proposed agent wallet could not be verified');
    }
    const signer = wallet.additional_signers.find((candidate) => candidate.signer_id === input.signerId);
    const signerPolicies = signer?.override_policy_ids ?? wallet.policy_ids;
    if (wallet.chain_type !== 'ethereum'
      || wallet.address.toLowerCase() !== input.walletAddress.toLowerCase()
      || !signer
      || !signerPolicies.includes(input.policyId)
      || wallet.exported_at !== null
      || wallet.imported_at !== null) {
      throw new AppError(403, 'UNTRUSTED_PRIVY_WALLET', 'The wallet must be a fresh, non-exported Privy Ethereum wallet with the reviewed signer policy attached');
    }
  }

  private assertManifestAllowed(manifestHash: Hex) {
    const allowed = new Set(this.config.AGENT_ALLOWED_MANIFEST_HASHES
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean));
    if (!allowed.has(manifestHash.toLowerCase())) {
      throw new AppError(403, 'UNTRUSTED_AGENT_MANIFEST', 'The signed mandate references an agent skill manifest that is not approved by this deployment');
    }
  }

  private async adminMembership(claims: AuthClaims) {
    const [membership] = await this.db.select({ member: institutionMembers, institution: institutions })
      .from(institutionMembers)
      .innerJoin(institutions, eq(institutionMembers.institutionId, institutions.id))
      .where(and(eq(institutionMembers.privyUserId, claims.userId), eq(institutionMembers.role, 'ADMIN')))
      .limit(1);
    return membership;
  }

  private async assertAdminAgent(claims: AuthClaims, agentId: string) {
    const membership = await this.adminMembership(claims);
    if (!membership) throw new AppError(403, 'INSTITUTION_ADMIN_REQUIRED', 'Institution administrator access is required');
    const [agent] = await this.db.select().from(agents).where(and(
      eq(agents.id, agentId),
      eq(agents.institutionId, membership.institution.id),
    )).limit(1);
    if (!agent) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent was not found');
    return { agent, institution: membership.institution };
  }

  async listAgents(claims: AuthClaims) {
    this.assertEnabled();
    const membership = await this.adminMembership(claims);
    if (!membership) return { institution: null, agents: [] };
    const rows = await this.db.select().from(agents)
      .where(eq(agents.institutionId, membership.institution.id))
      .orderBy(desc(agents.createdAt));
    return serializeRow({ institution: membership.institution, agents: rows });
  }

  async getAdminAgent(claims: AuthClaims, agentId: string) {
    const { agent, institution } = await this.assertAdminAgent(claims, agentId);
    await this.expirePreparedIntents(agentId);
    const [mandates, credentials, intents, nativeBalance] = await Promise.all([
      this.db.select().from(agentMandates).where(eq(agentMandates.agentId, agentId)).orderBy(desc(agentMandates.version)),
      this.db.select({
        id: agentCredentials.id,
        clientId: agentCredentials.clientId,
        label: agentCredentials.label,
        scopes: agentCredentials.scopes,
        status: agentCredentials.status,
        expiresAt: agentCredentials.expiresAt,
        lastUsedAt: agentCredentials.lastUsedAt,
        createdAt: agentCredentials.createdAt,
      }).from(agentCredentials).where(eq(agentCredentials.agentId, agentId)).orderBy(desc(agentCredentials.createdAt)),
      this.db.select().from(agentIntents).where(eq(agentIntents.agentId, agentId)).orderBy(desc(agentIntents.createdAt)).limit(20),
      agent.walletAddress
        ? this.chain.nativeBalance(agent.walletAddress as Address).then((value) => value.toString()).catch(() => null)
        : Promise.resolve(null),
    ]);
    return serializeRow({
      institution,
      agent,
      walletHealth: { nativeBalance, gasReady: nativeBalance !== null && BigInt(nativeBalance) > 0n },
      mandates,
      credentials,
      intents: intents.map((intent) => publicIntent(intent)),
    });
  }

  async createAgent(claims: AuthClaims, input: { name: string; adminWallet: Address }) {
    this.assertEnabled();
    if (!claims.wallets.includes(input.adminWallet.toLowerCase())) {
      throw new AppError(403, 'WALLET_NOT_LINKED', 'The administrator wallet is not linked to this Privy session');
    }
    const row = await this.db.transaction(async (tx) => {
      let membership = await tx.select({ member: institutionMembers, institution: institutions })
        .from(institutionMembers)
        .innerJoin(institutions, eq(institutionMembers.institutionId, institutions.id))
        .where(and(eq(institutionMembers.privyUserId, claims.userId), eq(institutionMembers.role, 'ADMIN')))
        .limit(1)
        .then((rows) => rows[0]);
      if (!membership) {
        const [institution] = await tx.insert(institutions).values({
          name: `${input.name} Institution`,
          adminPrivyUserId: claims.userId,
          adminWallet: input.adminWallet.toLowerCase(),
        }).returning();
        if (!institution) throw new Error('Institution insert returned no row');
        const [member] = await tx.insert(institutionMembers).values({
          institutionId: institution.id,
          privyUserId: claims.userId,
          wallet: input.adminWallet.toLowerCase(),
          role: 'ADMIN',
        }).returning();
        if (!member) throw new Error('Institution member insert returned no row');
        membership = { member, institution };
      }
      const [agent] = await tx.insert(agents).values({
        institutionId: membership.institution.id,
        name: input.name,
        createdBy: claims.userId,
      }).returning();
      if (!agent) throw new Error('Agent insert returned no row');
      await tx.insert(agentEvents).values({ agentId: agent.id, eventType: 'AGENT_CREATED', payload: { name: input.name } });
      return agent;
    });
    return serializeRow(row);
  }

  async walletBindingChallenge(claims: AuthClaims, agentId: string, input: {
    walletAddress: Address;
    privyWalletId: string;
    signerId: string;
    policyId: string;
  }) {
    const { agent } = await this.assertAdminAgent(claims, agentId);
    if (agent.walletAddress || agent.privyWalletId || agent.status !== 'PENDING_WALLET') {
      throw new AppError(409, 'AGENT_WALLET_IMMUTABLE', 'A bound agent wallet cannot be replaced; revoke this agent and create a new one');
    }
    this.assertPrivySignerPolicy(input.signerId, input.policyId);
    const signedAt = Math.floor(Date.now() / 1_000);
    return serializeRow(walletBindingTypedData(this.market(), {
      agentId,
      wallet: input.walletAddress,
      privyWalletId: input.privyWalletId,
      signerId: input.signerId,
      policyId: input.policyId,
      signedAt,
    }));
  }

  async bindWallet(claims: AuthClaims, agentId: string, input: {
    walletAddress: Address;
    privyWalletId: string;
    signerId: string;
    policyId: string;
    signedAt: number;
    signature: Hex;
  }) {
    const { agent } = await this.assertAdminAgent(claims, agentId);
    this.assertPrivySignerPolicy(input.signerId, input.policyId);
    if (agent.status === 'REVOKED') throw new AppError(409, 'AGENT_REVOKED', 'A revoked agent cannot bind a wallet');
    if (agent.walletAddress || agent.privyWalletId || agent.status !== 'PENDING_WALLET') {
      throw new AppError(409, 'AGENT_WALLET_IMMUTABLE', 'A bound agent wallet cannot be replaced; revoke this agent and create a new one');
    }
    if (Math.abs(Math.floor(Date.now() / 1_000) - input.signedAt) > 300) {
      throw new AppError(400, 'SIGNATURE_EXPIRED', 'The wallet binding signature challenge has expired');
    }
    await this.assertLivePrivyWallet(input);
    const recovered = await recoverTypedDataAddress({
      ...walletBindingTypedData(this.market(), {
        agentId,
        wallet: input.walletAddress,
        privyWalletId: input.privyWalletId,
        signerId: input.signerId,
        policyId: input.policyId,
        signedAt: input.signedAt,
      }),
      signature: input.signature,
    });
    if (recovered.toLowerCase() !== input.walletAddress.toLowerCase()) {
      throw new AppError(403, 'INVALID_WALLET_BINDING', 'The binding must be signed by the agent wallet');
    }
    const updated = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const [liveAgent] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!liveAgent || liveAgent.walletAddress || liveAgent.privyWalletId || liveAgent.status !== 'PENDING_WALLET') {
        throw new AppError(409, 'AGENT_WALLET_IMMUTABLE', 'The agent wallet was bound concurrently; it cannot be replaced');
      }
      const [row] = await tx.update(agents).set({
        walletAddress: input.walletAddress.toLowerCase(),
        privyWalletId: input.privyWalletId,
        signerId: input.signerId,
        policyId: input.policyId,
        status: 'PENDING_CVI',
        updatedAt: new Date(),
      }).where(and(eq(agents.id, agentId), eq(agents.status, 'PENDING_WALLET'))).returning();
      if (!row) throw new AppError(409, 'AGENT_WALLET_IMMUTABLE', 'The agent wallet was bound concurrently; it cannot be replaced');
      await tx.insert(agentEvents).values({ agentId, eventType: 'AGENT_WALLET_BOUND', payload: { wallet: input.walletAddress.toLowerCase() } });
      return row;
    });
    return serializeRow(updated);
  }

  async mandateChallenge(claims: AuthClaims, agentId: string, input: {
    wallet: Address;
    manifestHash: Hex;
    constraints: AgentMandateConstraints;
  }) {
    const { agent } = await this.assertAdminAgent(claims, agentId);
    this.assertManifestAllowed(input.manifestHash);
    if (!agent.walletAddress || agent.walletAddress !== input.wallet.toLowerCase()) {
      throw new AppError(409, 'AGENT_WALLET_MISMATCH', 'The mandate wallet must match the bound agent wallet');
    }
    const constraints = AgentMandateConstraintsSchema.parse(input.constraints);
    this.assertMandateWindow(constraints);
    const constraintsHash = canonicalHash(constraints);
    return serializeRow({
      constraintsHash,
      typedData: mandateTypedData(this.market(), {
        agentId,
        agentWallet: input.wallet,
        manifestHash: input.manifestHash,
        constraintsHash,
        nonce: BigInt(constraints.nonce),
        startsAt: constraints.startsAt,
        expiresAt: constraints.expiresAt,
      }),
    });
  }

  private assertMandateWindow(constraints: AgentMandateConstraints) {
    const now = Math.floor(Date.now() / 1_000);
    if (constraints.startsAt < now - 300 || constraints.startsAt > now + 300) {
      throw new AppError(400, 'INVALID_MANDATE_WINDOW', 'Mandate start must be within five minutes of the current time');
    }
    if (constraints.expiresAt - constraints.startsAt > 30 * 24 * 60 * 60) {
      throw new AppError(400, 'MANDATE_TOO_LONG', 'Agent mandates are limited to 30 days');
    }
  }

  async createMandate(claims: AuthClaims, agentId: string, input: {
    wallet: Address;
    manifestHash: Hex;
    constraints: AgentMandateConstraints;
    signature: Hex;
  }) {
    const { agent, institution } = await this.assertAdminAgent(claims, agentId);
    this.assertManifestAllowed(input.manifestHash);
    if (!agent.walletAddress || agent.walletAddress !== input.wallet.toLowerCase()) {
      throw new AppError(409, 'AGENT_WALLET_MISMATCH', 'The mandate wallet must match the bound agent wallet');
    }
    const constraints = AgentMandateConstraintsSchema.parse(input.constraints);
    this.assertMandateWindow(constraints);
    const constraintsHash = canonicalHash(constraints);
    const signer = await recoverMandateSigner(this.market(), {
      agentId,
      agentWallet: input.wallet,
      manifestHash: input.manifestHash,
      constraintsHash,
      nonce: BigInt(constraints.nonce),
      startsAt: constraints.startsAt,
      expiresAt: constraints.expiresAt,
    }, input.signature);
    if (signer.toLowerCase() !== institution.adminWallet.toLowerCase()) {
      throw new AppError(403, 'INVALID_MANDATE_SIGNATURE', 'The mandate must be signed by the institution administrator wallet');
    }
    const mandate = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const [liveAgent] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!liveAgent || liveAgent.status === 'REVOKED' || liveAgent.walletAddress !== input.wallet.toLowerCase()) {
        throw new AppError(409, 'AGENT_AUTHORITY_CHANGED', 'The agent authority changed before the mandate could be recorded');
      }
      const latest = await tx.select().from(agentMandates).where(eq(agentMandates.agentId, agentId))
        .orderBy(desc(agentMandates.version)).limit(1).then((rows) => rows[0]);
      await tx.update(agentMandates).set({ status: 'SUPERSEDED', revokedAt: new Date() })
        .where(and(eq(agentMandates.agentId, agentId), eq(agentMandates.status, 'ACTIVE')));
      const [created] = await tx.insert(agentMandates).values({
        agentId,
        version: (latest?.version ?? 0) + 1,
        wallet: input.wallet.toLowerCase(),
        manifestHash: input.manifestHash.toLowerCase(),
        allowedActions: constraints.allowedActions,
        allowedAssets: constraints.allowedAssets.map((asset) => asset.toLowerCase()),
        constraints,
        nonce: constraints.nonce,
        signature: input.signature,
        startsAt: new Date(constraints.startsAt * 1_000),
        expiresAt: new Date(constraints.expiresAt * 1_000),
      }).returning();
      if (!created) throw new Error('Mandate insert returned no row');
      const supersededIntents = await tx.select().from(agentIntents).where(and(
        eq(agentIntents.agentId, agentId),
        ne(agentIntents.mandateId, created.id),
        inArray(agentIntents.state, ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED']),
      ));
      for (const intent of supersededIntents) {
        await terminateIntentInTransaction(
          tx,
          intent,
          'CANCELLED',
          'MANDATE_SUPERSEDED',
          'The institution replaced the mandate before execution',
          ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED'],
        );
      }
      await tx.insert(agentEvents).values({ agentId, eventType: 'MANDATE_CREATED', payload: { mandateId: created.id, version: created.version } });
      return created;
    });
    const compliance = await this.refreshCompliance(claims, agentId);
    return serializeRow({ mandate, compliance });
  }

  async refreshCompliance(claims: AuthClaims, agentId: string) {
    const { agent } = await this.assertAdminAgent(claims, agentId);
    if (!agent.walletAddress) throw new AppError(409, 'AGENT_WALLET_REQUIRED', 'Bind an agent wallet before checking compliance');
    const mandate = await this.activeMandate(agentId, false);
    if (!mandate) {
      await this.db.transaction(async (tx) => {
        await lockAgentAuthority(tx, agentId);
        const [current] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
        if (current) await tx.update(agents).set({
          status: current.status === 'PAUSED' || current.status === 'REVOKED' ? current.status : 'PENDING_MANDATE',
          cviActive: false,
          updatedAt: new Date(),
        }).where(eq(agents.id, agentId));
      });
      return { active: false, reasons: ['MANDATE_REQUIRED'], checks: [] };
    }
    const checks = await Promise.all((mandate.allowedAssets as string[]).map(async (assetValue) => {
      const asset = assetValue.toLowerCase() as Address;
      const registry = await this.store.getAssetIncludingDisabled(asset);
      const requestId = registry?.cleanverseRequestId
        ?? (asset === this.config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase() ? this.config.AUSDC_CLEANVERSE_REQUEST_ID : undefined);
      return this.compliance.verify(agent.walletAddress as Address, asset, requestId, randomUUID(), this.market());
    }));
    const reasons = [...new Set(checks.flatMap((check) => [
      ...(!check.cviActive ? ['CVI_INACTIVE'] : []),
      ...(!hasEligibleCviProof(check) || check.poolEligible !== true ? ['CVI_INELIGIBLE'] : []),
      ...(!check.assetIssued ? ['CVA_NOT_ISSUED'] : []),
      ...(check.assetPaused ? ['CVA_PAUSED'] : []),
    ]))];
    const active = reasons.length === 0;
    const expirations = checks.flatMap((check) => check.apassExpiresAt ? [new Date(check.apassExpiresAt)] : []);
    const cviExpiresAt = expirations.sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const now = new Date();
      const [[current], [currentMandate]] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, agentId)).limit(1),
        tx.select({ id: agentMandates.id }).from(agentMandates).where(and(
          eq(agentMandates.id, mandate.id),
          eq(agentMandates.agentId, agentId),
          eq(agentMandates.status, 'ACTIVE'),
          sql`${agentMandates.startsAt} <= ${now}`,
          sql`${agentMandates.expiresAt} > ${now}`,
        )).limit(1),
      ]);
      if (!current || !currentMandate) throw new AppError(409, 'AGENT_AUTHORITY_CHANGED', 'The active mandate changed while compliance was being checked');
      const preservedStatus = current.status === 'PAUSED' || current.status === 'REVOKED';
      await tx.update(agents).set({
        cviActive: active,
        cviExpiresAt,
        status: preservedStatus ? current.status : active ? 'ACTIVE' : 'PENDING_CVI',
        updatedAt: new Date(),
      }).where(eq(agents.id, agentId));
      await tx.insert(agentEvents).values({ agentId, eventType: 'COMPLIANCE_REFRESHED', payload: { active, reasons, mandateId: mandate.id } });
    });
    return serializeRow({ active, reasons, checks });
  }

  async enrollUatCvi(claims: AuthClaims, agentId: string) {
    const { agent } = await this.assertAdminAgent(claims, agentId);
    if (!this.config.AGENT_UAT_SYNTHETIC_CVI_ENABLED
      || !new URL(this.config.CLEANVERSE_BASE_URL).hostname.toLowerCase().includes('uat')) {
      throw new AppError(403, 'UAT_CVI_ENROLLMENT_DISABLED', 'Synthetic agent CVI enrollment is disabled outside the approved Cleanverse UAT workflow');
    }
    if (!agent.walletAddress) throw new AppError(409, 'AGENT_WALLET_REQUIRED', 'Bind the agent wallet before enrolling its A-Pass');
    const now = Math.floor(Date.now() / 1_000);
    const customerId = `RWCARAGENT${agent.id.replaceAll('-', '').toUpperCase()}`;
    const idNumber = createHash('sha256').update(`RWCAR-UAT-AGENT-${agent.id}`).digest('hex');
    let generated: Record<string, unknown> | null = null;
    try {
      generated = await this.cleanverse.generateApass({
        customerId,
        expirationTime: now + 365 * 24 * 60 * 60,
        wallet: { chain: 'monad', address: agent.walletAddress },
        identityDataList: [{
          idType: 'ID_CARD',
          fullName: 'RWCAR UAT Institutional Agent',
          idNumber,
          validUntil: new Date((now + 365 * 24 * 60 * 60) * 1_000).toISOString().slice(0, 10),
          issuingCountryISO2: 'SG',
        }],
      });
    } catch (error) {
      // Idempotent recovery: if the A-Pass already exists, querying it is the
      // authoritative success proof. Never retry Cleanverse code 1000 with
      // override because that may mutate an existing A-Pass group.
      try {
        const existing = await this.cleanverse.queryApass('monad', agent.walletAddress);
        if (!existing.active) throw error;
      } catch {
        throw error;
      }
    }
    const data = generated?.data && typeof generated.data === 'object' ? generated.data as Record<string, unknown> : {};
    const walletResult = data.wallet && typeof data.wallet === 'object' ? data.wallet as Record<string, unknown> : {};
    const transactionHash = walletResult.transactionHash ?? walletResult.txHash ?? data.transactionHash ?? data.txHash ?? null;
    await this.db.insert(agentEvents).values({
      agentId,
      eventType: 'UAT_CVI_ENROLLED',
      payload: { customerId, syntheticKyc: true, transactionHash },
    });
    return {
      submitted: generated !== null,
      existing: generated === null,
      customerId,
      syntheticKyc: true,
      transactionHash,
      next: 'Wait for Cleanverse indexing, then refresh compliance after the mandate is signed.',
    };
  }

  async createCredential(claims: AuthClaims, agentId: string, input: {
    label: string;
    scopes: AgentScope[];
    expiresAt?: string | undefined;
  }) {
    await this.assertAdminAgent(claims, agentId);
    const scopes = [...new Set(input.scopes.map((scope) => AgentScopeSchema.parse(scope)))];
    const now = new Date();
    const maxExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + this.config.AGENT_CREDENTIAL_TTL_DAYS * 24 * 60 * 60 * 1_000);
    if (expiresAt <= now || expiresAt > maxExpiry) {
      throw new AppError(400, 'INVALID_CREDENTIAL_EXPIRY', 'Credential expiry must be in the future and no more than 90 days away');
    }
    const credential = generateCredential();
    const secretHash = await hashClientSecret(credential.clientSecret);
    const row = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const currentTime = new Date();
      const [[agent], [mandate]] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, agentId)).limit(1),
        tx.select({ id: agentMandates.id }).from(agentMandates).where(and(
          eq(agentMandates.agentId, agentId),
          eq(agentMandates.status, 'ACTIVE'),
          sql`${agentMandates.startsAt} <= ${currentTime}`,
          sql`${agentMandates.expiresAt} > ${currentTime}`,
        )).limit(1),
      ]);
      if (!agent || agent.status !== 'ACTIVE' || !agent.cviActive
        || (agent.cviExpiresAt && agent.cviExpiresAt <= currentTime) || !mandate) {
        throw new AppError(409, 'AGENT_NOT_ACTIVE', 'The agent needs a bound wallet, active mandate, and live CVI before credentials can be issued');
      }
      const [created] = await tx.insert(agentCredentials).values({
        agentId,
        clientId: credential.clientId,
        secretHash,
        label: input.label,
        scopes,
        expiresAt,
      }).returning();
      if (!created) throw new Error('Credential insert returned no row');
      await tx.insert(agentEvents).values({ agentId, eventType: 'CREDENTIAL_CREATED', payload: { credentialId: created.id, clientId: created.clientId, scopes, expiresAt } });
      return created;
    });
    return { credentialId: row.id, clientId: row.clientId, clientSecret: credential.clientSecret, scopes, expiresAt: row.expiresAt };
  }

  async revokeCredential(claims: AuthClaims, agentId: string, credentialId: string) {
    await this.assertAdminAgent(claims, agentId);
    const [row] = await this.db.update(agentCredentials).set({ status: 'REVOKED', revokedAt: new Date() })
      .where(and(eq(agentCredentials.id, credentialId), eq(agentCredentials.agentId, agentId))).returning();
    if (!row) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credential was not found');
    await this.db.insert(agentEvents).values({ agentId, eventType: 'CREDENTIAL_REVOKED', payload: { credentialId } });
    return { revoked: true };
  }

  async setAgentStatus(claims: AuthClaims, agentId: string, status: 'PAUSED' | 'REVOKED' | 'ACTIVE') {
    await this.assertAdminAgent(claims, agentId);
    const updated = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const [liveAgent] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!liveAgent) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent was not found');
      if (liveAgent.status === 'REVOKED' && status !== 'REVOKED') {
        throw new AppError(409, 'AGENT_REVOKED', 'Revocation is permanent; create a new agent to restore machine access');
      }
      if (status === 'ACTIVE') {
        const now = new Date();
        const [mandate] = await tx.select({ id: agentMandates.id }).from(agentMandates).where(and(
          eq(agentMandates.agentId, agentId),
          eq(agentMandates.status, 'ACTIVE'),
          sql`${agentMandates.startsAt} <= ${now}`,
          sql`${agentMandates.expiresAt} > ${now}`,
        )).limit(1);
        if (!liveAgent.cviActive || (liveAgent.cviExpiresAt && liveAgent.cviExpiresAt <= now) || !mandate) {
          throw new AppError(409, 'AGENT_NOT_ACTIVE', 'Compliance and mandate checks must pass before activation');
        }
      }
      const [row] = await tx.update(agents).set({
        status,
        updatedAt: new Date(),
        ...(status === 'REVOKED' ? { revokedAt: new Date() } : {}),
      }).where(eq(agents.id, agentId)).returning();
      if (!row) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent was not found');
      if (status === 'REVOKED') {
        await tx.update(agentCredentials).set({ status: 'REVOKED', revokedAt: new Date() })
          .where(eq(agentCredentials.agentId, agentId));
      }
      if (status === 'PAUSED' || status === 'REVOKED') {
        const pending = await tx.select().from(agentIntents).where(and(
          eq(agentIntents.agentId, agentId),
          inArray(agentIntents.state, ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED']),
        ));
        for (const intent of pending) {
          await terminateIntentInTransaction(
            tx,
            intent,
            'CANCELLED',
            `AGENT_${status}`,
            `The institution ${status.toLowerCase()} the agent before execution`,
            ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED'],
          );
        }
      }
      await tx.insert(agentEvents).values({ agentId, eventType: `AGENT_${status}`, payload: {} });
      return row;
    });
    return serializeRow(updated);
  }

  async issueToken(clientId: string, clientSecret: string, requestedResource: string, requestedScopes?: string[]) {
    this.assertEnabled();
    if (requestedResource !== this.config.AGENT_AUDIENCE) {
      throw new AppError(400, 'INVALID_TARGET_RESOURCE', 'The requested OAuth resource is not this RWCAR MCP server');
    }
    const [joined] = await this.db.select({ credential: agentCredentials, agent: agents })
      .from(agentCredentials)
      .innerJoin(agents, eq(agentCredentials.agentId, agents.id))
      .where(eq(agentCredentials.clientId, clientId)).limit(1);
    const invalid = () => new AppError(401, 'INVALID_CLIENT', 'Client authentication failed');
    if (!joined) {
      await verifyClientSecret(clientSecret, await this.dummySecretHash);
      throw invalid();
    }
    if (joined.credential.status !== 'ACTIVE' || joined.agent.status !== 'ACTIVE'
      || !joined.agent.walletAddress || !joined.agent.cviActive
      || (joined.agent.cviExpiresAt && joined.agent.cviExpiresAt <= new Date())
      || (joined.credential.expiresAt && joined.credential.expiresAt <= new Date())) throw invalid();
    if (!await verifyClientSecret(clientSecret, joined.credential.secretHash)) throw invalid();
    const parseScope = (scope: string) => {
      const result = AgentScopeSchema.safeParse(scope);
      if (!result.success) throw new AppError(400, 'INVALID_SCOPE', `Unsupported OAuth scope: ${scope}`);
      return result.data;
    };
    const availableScopes = (joined.credential.scopes as string[]).map(parseScope);
    const scopes = requestedScopes?.length ? [...new Set(requestedScopes.map(parseScope))] : availableScopes;
    if (scopes.some((scope) => !availableScopes.includes(scope))) {
      throw new AppError(400, 'INVALID_SCOPE', 'The requested scope exceeds this credential grant');
    }
    if (!await this.activeMandate(joined.agent.id, false)) throw invalid();
    const claims: AgentTokenClaims = {
      agentId: joined.agent.id,
      institutionId: joined.agent.institutionId,
      wallet: joined.agent.walletAddress as Address,
      scopes,
      credentialId: joined.credential.id,
    };
    const accessToken = await this.jwt!.sign(claims);
    await this.db.update(agentCredentials).set({ lastUsedAt: new Date() }).where(eq(agentCredentials.id, joined.credential.id));
    await this.db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, joined.agent.id));
    return { access_token: accessToken, token_type: 'Bearer', expires_in: this.config.AGENT_TOKEN_TTL_SECONDS, scope: scopes.join(' ') };
  }

  async authenticateBearer(header: string | undefined) {
    this.assertEnabled();
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'AGENT_AUTH_REQUIRED', 'An agent bearer token is required');
    const claims = await this.jwt!.verify(header.slice(7));
    const [live] = await this.db.select({ agent: agents, credential: agentCredentials })
      .from(agents)
      .innerJoin(agentCredentials, eq(agentCredentials.agentId, agents.id))
      .where(and(eq(agents.id, claims.agentId), eq(agentCredentials.id, claims.credentialId))).limit(1);
    const now = new Date();
    const credentialScopes = Array.isArray(live?.credential.scopes) ? live.credential.scopes : [];
    if (!live || live.agent.status !== 'ACTIVE' || !live.agent.cviActive || live.credential.status !== 'ACTIVE'
      || (live.agent.cviExpiresAt && live.agent.cviExpiresAt <= now)
      || (live.credential.expiresAt && live.credential.expiresAt <= now)
      || live.agent.institutionId !== claims.institutionId
      || live.agent.walletAddress?.toLowerCase() !== claims.wallet.toLowerCase()
      || live.agent.signerId !== this.config.PRIVY_AGENT_SIGNER_ID
      || live.agent.policyId !== this.config.PRIVY_AGENT_POLICY_ID
      || claims.scopes.some((scope) => !credentialScopes.includes(scope))) {
      throw new AppError(401, 'AGENT_ACCESS_REVOKED', 'The agent or its credential is no longer active');
    }
    if (!await this.activeMandate(claims.agentId, false)) {
      throw new AppError(401, 'AGENT_ACCESS_REVOKED', 'The agent mandate is no longer active');
    }
    return claims;
  }

  requireScope(claims: AgentTokenClaims, scope: AgentScope) {
    if (!claims.scopes.includes(scope)) throw new AppError(403, 'INSUFFICIENT_SCOPE', `The ${scope} scope is required`);
  }

  private async activeMandate(agentId: string, required: boolean): Promise<MandateRow | undefined> {
    const now = new Date();
    const [mandate] = await this.db.select().from(agentMandates).where(and(
      eq(agentMandates.agentId, agentId),
      eq(agentMandates.status, 'ACTIVE'),
      sql`${agentMandates.startsAt} <= ${now}`,
      sql`${agentMandates.expiresAt} > ${now}`,
    )).orderBy(desc(agentMandates.version)).limit(1);
    if (!mandate && required) throw new AppError(403, 'MANDATE_REQUIRED', 'No active agent mandate exists');
    return mandate;
  }

  private async intentMandate(intent: IntentRow, required: boolean): Promise<MandateRow | undefined> {
    const now = new Date();
    const [mandate] = await this.db.select().from(agentMandates).where(and(
      eq(agentMandates.id, intent.mandateId),
      eq(agentMandates.agentId, intent.agentId),
      eq(agentMandates.status, 'ACTIVE'),
      eq(agentMandates.manifestHash, intent.manifestHash),
      sql`${agentMandates.startsAt} <= ${now}`,
      sql`${agentMandates.expiresAt} > ${now}`,
    )).limit(1);
    if (!mandate && required) throw new AppError(403, 'INTENT_MANDATE_INACTIVE', 'The exact mandate that authorized this intent is no longer active');
    return mandate;
  }

  private async terminateIntent(
    intent: IntentRow,
    state: Extract<AgentIntentState, 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'FAILED_WITH_ALLOWANCE'>,
    code: string,
    message: string,
    fromStates: AgentIntentState[] = [...ACTIVE_INTENT_STATES],
  ) {
    return this.db.transaction((tx) => terminateIntentInTransaction(tx, intent, state, code, message, fromStates));
  }

  private async expirePreparedIntents(agentId: string) {
    const expired = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.agentId, agentId),
      inArray(agentIntents.state, ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED']),
      lt(agentIntents.intentExpiresAt, new Date()),
    ));
    for (const intent of expired) {
      await this.terminateIntent(intent, 'EXPIRED', 'INTENT_EXPIRED', 'The prepared intent expired before it was queued', ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED']);
    }
  }

  async protocolInfo(claims: AgentTokenClaims) {
    this.requireScope(claims, 'protocol:read');
    const [assets, status, mandate] = await Promise.all([
      this.store.listAssets(),
      this.store.systemStatus(),
      this.activeMandate(claims.agentId, true),
    ]);
    const constraints = AgentMandateConstraintsSchema.parse(mandate!.constraints);
    return serializeRow({
      protocol: 'RWCAR',
      version: 'v2',
      chain: { id: 10_143, name: 'Monad Testnet' },
      contracts: {
        market: this.config.REPO_MARKET_V2_ADDRESS,
        vault: this.config.COLLATERAL_VAULT_V2_ADDRESS,
        escrow: this.config.SETTLEMENT_ESCROW_V2_ADDRESS,
        auction: this.config.DUTCH_AUCTION_V2_ADDRESS,
        margin: this.config.MARGIN_ENGINE_V2_ADDRESS,
        validator: this.config.COMPLIANCE_VALIDATOR_ADDRESS,
      },
      settlementToken: this.config.V2_SETTLEMENT_TOKEN_ADDRESS,
      assets,
      status,
      delegation: {
        executionMode: constraints.executionMode,
        perIntentHumanApproval: constraints.executionMode === 'SUPERVISED',
        allowedActions: constraints.allowedActions,
        allowedAssets: constraints.allowedAssets,
        selfRecipientAlwaysAllowed: true,
        maxPerTransaction: constraints.maxPerTransaction,
        maxDailyNotional: constraints.maxDailyNotional,
        expiresAt: mandate!.expiresAt,
      },
      safety: {
        arbitraryTransactions: false,
        preflightRequired: true,
        durableIntents: true,
        valuationAuthority: 'SERVER_MANAGED_SIGNED_ORACLE',
        roleMatrix: {
          REPAY_POSITION: ['SELLER'],
          START_AUCTION: ['ANY_MANDATE_AUTHORIZED_KEEPER_AFTER_DEADLINE'],
          BUY_AUCTION: ['ANY_CVI_ELIGIBLE_NON_SELLER'],
          CLAIM_COLLATERAL: ['LENDER'],
          OPEN_MARGIN_ACCOUNT: ['COLLATERAL_OWNER'],
          FUND_MARGIN_ACCOUNT: ['PERMITTED_LENDER_OR_PUBLIC_NON_SELLER'],
        },
      },
    });
  }

  async eligibility(claims: AgentTokenClaims, assetValue: Address) {
    this.requireScope(claims, 'protocol:read');
    const asset = await this.store.getAssetIncludingDisabled(assetValue);
    const requestId = asset?.cleanverseRequestId
      ?? (assetValue.toLowerCase() === this.config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase() ? this.config.AUSDC_CLEANVERSE_REQUEST_ID : undefined);
    const check = await this.compliance.verify(claims.wallet, assetValue, requestId, randomUUID(), this.market());
    return {
      eligible: check.cviActive && hasEligibleCviProof(check) && check.assetIssued && !check.assetPaused && check.poolEligible === true,
      check,
    };
  }

  async listVerifiedAssets(claims: AgentTokenClaims) {
    this.requireScope(claims, 'protocol:read');
    return serializeRow({ assets: await this.store.listAssets() });
  }

  async listOffers(claims: AgentTokenClaims) {
    this.requireScope(claims, 'protocol:read');
    const block = await this.chain.blockNumber();
    const timestamp = await this.chain.blockTimestamp(block);
    return serializeRow({ offers: await this.store.listV2OpenOffers(this.market(), new Date(Number(timestamp) * 1_000)), asOf: { block, timestamp } });
  }

  async offerQuote(claims: AgentTokenClaims, offerId: string, principalAmount: string) {
    this.requireScope(claims, 'protocol:read');
    const offer = await this.store.getV2Offer(offerId, this.market());
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'Offer was not found');
    return calculateFillEconomics({
      totalCollateral: BigInt(offer.totalCollateral),
      targetPrincipal: BigInt(offer.targetPrincipal),
      remainingCollateral: BigInt(offer.remainingCollateral),
      remainingPrincipal: BigInt(offer.remainingPrincipal),
      cumulativeFee: BigInt(offer.cumulativeFee),
      fillPrincipal: BigInt(principalAmount),
    });
  }

  async portfolio(claims: AgentTokenClaims) {
    this.requireScope(claims, 'protocol:read');
    const [block, positions, sellerOffers, offerHistory, balances, claimsRows, activity] = await Promise.all([
      this.chain.blockNumber(),
      this.store.listV2Positions(claims.wallet, this.market()),
      this.store.listV2SellerOffers(claims.wallet, this.market()),
      this.store.listV2SellerOfferHistory(claims.wallet, this.market()),
      this.store.listVaultBalances(claims.wallet),
      this.store.listSettlementClaims(claims.wallet),
      this.store.listV2Activity(claims.wallet, 20),
    ]);
    const chainTimestamp = await this.chain.blockTimestamp(block);
    const assetAddresses = [...new Set(positions.map((position) => position.assetAddress.toLowerCase()))] as Address[];
    const [valuations, automation] = await Promise.all([
      this.store.listLatestOracleValuations(assetAddresses),
      this.store.listAutomationJobsForResources(
        'startAuction',
        'position',
        positions.map((position) => position.positionId),
        this.market(),
      ),
    ]);
    const enrichedPositions = positions.map((position) => {
      const valuation = valuations.find((candidate) => candidate.assetAddress === position.assetAddress);
      const observedAt = valuation ? BigInt(Math.floor(valuation.observedAt.getTime() / 1_000)) : 0n;
      const validFrom = valuation ? BigInt(Math.floor(valuation.validFrom.getTime() / 1_000)) : 0n;
      const validUntil = valuation ? BigInt(Math.floor(valuation.validUntil.getTime() / 1_000)) : 0n;
      const oracleFresh = Boolean(valuation)
        && chainTimestamp >= validFrom
        && chainTimestamp <= validUntil
        && chainTimestamp <= observedAt + BigInt(position.maxOracleAgeSeconds);
      const lifecycle = deriveRepoPositionLifecycle(position, claims.wallet, chainTimestamp, oracleFresh);
      const job = automation.find((candidate) => candidate.resourceId === position.positionId);
      return {
        ...position,
        ...lifecycle,
        oracle: valuation ? {
          valuationId: valuation.valuationId,
          digest: valuation.digest,
          priceE18: valuation.priceE18,
          observedAt: valuation.observedAt,
          validUntil: valuation.validUntil,
          fresh: oracleFresh,
          source: 'SIGNED_VALUATION_ORACLE',
          agentSuppliedValuationRequired: false,
        } : {
          valuationId: null,
          digest: null,
          priceE18: null,
          observedAt: null,
          validUntil: null,
          fresh: false,
          source: 'SIGNED_VALUATION_ORACLE',
          agentSuppliedValuationRequired: false,
        },
        defaultAutomation: job ? {
          executionMode: 'DIRECT_PERMISSIONLESS_ONCHAIN',
          humanApprovalRequired: false,
          status: job.status,
          attempts: job.attempts,
          nextAttemptAt: job.nextAttemptAt,
          txHash: job.txHash,
          lastError: job.lastError,
        } : null,
      };
    });
    const enrichedClaims = claimsRows.map((claim) => {
      const claimable = claim.status === 'PENDING' && BigInt(claim.remaining) > 0n;
      return {
        ...claim,
        claimable,
        prepareClaimInput: claimable ? {
          claimId: claim.claimId,
          escrowAddress: claim.escrowAddress,
          amount: claim.remaining,
          recipient: claims.wallet,
        } : null,
        nextActions: claimable ? [{
          action: 'PREPARE_CLAIM',
          description: 'Generate a fresh idempotency key and pass it with prepareClaimInput to prepare_claim.',
        }] : [],
      };
    });
    return serializeRow({
      wallet: claims.wallet,
      positions: enrichedPositions,
      sellerOffers,
      offerHistory,
      vaultBalances: balances,
      settlementClaims: enrichedClaims,
      activity,
      asOf: { block, timestamp: chainTimestamp },
    });
  }

  async marginAccounts(claims: AgentTokenClaims) {
    this.requireScope(claims, 'protocol:read');
    const engine = this.config.MARGIN_ENGINE_V2_ADDRESS as Address | undefined;
    if (!engine) return { accounts: [], fundableAccounts: [], featureReady: false };
    const metadata = await this.chain.marginMetadata(engine);
    const block = await this.chain.blockNumber();
    const [timestamp, accounts, fundableAccounts, walletBalance, marginVaultAvailable, repoConfig] = await Promise.all([
      this.chain.blockTimestamp(block),
      this.store.listMarginAccounts(claims.wallet, engine),
      this.store.listFundableMarginAccounts(engine, 20),
      this.chain.balanceOf(metadata.asset, claims.wallet),
      this.chain.vaultAvailable(metadata.vault, claims.wallet),
      this.chain.marketAssetConfig(this.market(), metadata.asset),
    ]);
    const repoVaultAvailable = repoConfig.vault === '0x0000000000000000000000000000000000000000'
      ? 0n
      : await this.chain.vaultAvailable(repoConfig.vault, claims.wallet).catch(() => 0n);
    const [liveAccounts, liveFundableAccounts] = await Promise.all([
      enrichMarginRiskRows(this.chain, engine, accounts, metadata),
      enrichMarginRiskRows(this.chain, engine, fundableAccounts, metadata),
    ]);
    return serializeRow({
      accounts: liveAccounts,
      fundableAccounts: liveFundableAccounts,
      featureReady: this.config.V2_MARGIN_ENABLED,
      collateralSources: {
        asset: metadata.asset,
        wallet: walletBalance,
        marginVaultAvailable,
        repoVault: repoConfig.vault,
        repoVaultAvailable,
        supportedForDeposit: ['AUTO', 'WALLET', 'REPO_VAULT'],
      },
      workflow: [
        { step: 1, action: 'DEPOSIT', description: 'Move collateral into the margin vault; AUTO can sweep Repo Vault AVAILABLE in one approved intent.' },
        { step: 2, action: 'OPEN_ACCOUNT', description: 'Reserve margin-vault AVAILABLE collateral into a shared netting set.' },
        { step: 3, action: 'FUND_ACCOUNT', description: 'An eligible non-seller lender funds the published mandate.' },
        { step: 4, action: 'REPAY_OR_MANAGE_MARGIN', description: 'Seller repays exposures or participants follow the explicit margin-call/liquidation state.' },
      ],
      asOf: { block, timestamp },
    });
  }

  async auctions(claims: AgentTokenClaims, includeClosed = false) {
    this.requireScope(claims, 'protocol:read');
    return serializeRow({ auctions: await this.store.listAuctions(this.config.DUTCH_AUCTION_V2_ADDRESS as Address | undefined, includeClosed) });
  }

  async intentStatus(claims: AgentTokenClaims, intentId: string) {
    this.requireScope(claims, 'protocol:read');
    return this.intentForAgent(claims.agentId, intentId);
  }

  async eventFeed(claims: AgentTokenClaims, cursor?: string, limit = 100) {
    this.requireScope(claims, 'protocol:read');
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const [cursorRow] = cursor
      ? await this.db.select().from(agentEvents).where(and(
        eq(agentEvents.id, cursor),
        eq(agentEvents.agentId, claims.agentId),
      )).limit(1)
      : [];
    if (cursor && !cursorRow) throw new AppError(404, 'EVENT_CURSOR_NOT_FOUND', 'The event cursor does not belong to this agent or is no longer available');
    const rows = await this.db.select().from(agentEvents).where(and(
      eq(agentEvents.agentId, claims.agentId),
      cursorRow ? or(
        gt(agentEvents.occurredAt, cursorRow.occurredAt),
        and(eq(agentEvents.occurredAt, cursorRow.occurredAt), gt(agentEvents.id, cursorRow.id)),
      ) : undefined,
    )).orderBy(asc(agentEvents.occurredAt), asc(agentEvents.id)).limit(boundedLimit);
    return serializeRow({
      events: rows,
      cursor: rows.at(-1)?.id ?? cursor ?? null,
      hasMore: rows.length === boundedLimit,
    });
  }

  private async intentForAgent(agentId: string, intentId: string) {
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.id, intentId), eq(agentIntents.agentId, agentId))).limit(1);
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Intent was not found');
    const steps = await this.db.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, intent.id)).orderBy(asc(agentIntentSteps.stepIndex));
    return publicIntent(intent, steps);
  }

  async listAdminIntents(claims: AuthClaims, agentId: string) {
    await this.assertAdminAgent(claims, agentId);
    await this.expirePreparedIntents(agentId);
    const rows = await this.db.select().from(agentIntents).where(eq(agentIntents.agentId, agentId)).orderBy(desc(agentIntents.createdAt)).limit(100);
    return Promise.all(rows.map(async (row) => publicIntent(row, await this.db.select().from(agentIntentSteps)
      .where(eq(agentIntentSteps.intentId, row.id)).orderBy(asc(agentIntentSteps.stepIndex)))));
  }

  private async replayIntent(claims: AgentTokenClaims, action: AgentAction, input: IntentInput) {
    const [existing] = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.agentId, claims.agentId),
      eq(agentIntents.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!existing) return undefined;
    if (existing.action !== action || canonicalJson(existing.input) !== canonicalJson(input)) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with different intent semantics');
    }
    const steps = await this.db.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, existing.id)).orderBy(asc(agentIntentSteps.stepIndex));
    return publicIntent(existing, steps);
  }

  async prepareVault(claims: AgentTokenClaims, input: IntentInput & { action: 'DEPOSIT' | 'WITHDRAW'; asset: Address; amount: string; recipient?: Address }) {
    const action: AgentAction = input.action === 'DEPOSIT' ? 'VAULT_DEPOSIT' : 'VAULT_WITHDRAW';
    this.requireScope(claims, scopeFor(action));
    const replay = await this.replayIntent(claims, action, input);
    if (replay) return replay;
    const preflight = input.action === 'DEPOSIT'
      ? await this.preflight.deposit({ actor: claims.wallet, asset: input.asset, amount: input.amount })
      : await this.preflight.withdraw({ actor: claims.wallet, asset: input.asset, amount: input.amount, ...(input.recipient ? { recipient: input.recipient } : {}) });
    return this.prepareIntent(claims, action, input, preflight, input.asset);
  }

  async prepareCreateOffer(claims: AgentTokenClaims, input: IntentInput) {
    this.requireScope(claims, 'offers:write');
    const replay = await this.replayIntent(claims, 'CREATE_OFFER', input);
    if (replay) return replay;
    const body = { ...input, seller: claims.wallet } as unknown as Parameters<V2PreflightService['createOffer']>[0];
    const preflight = await this.preflight.createOffer(body);
    const permittedBuyer = typeof input.permittedBuyer === 'string' && !/^0x0{40}$/i.test(input.permittedBuyer)
      ? input.permittedBuyer as Address
      : undefined;
    return this.prepareIntent(claims, 'CREATE_OFFER', input, preflight, body.asset as Address, permittedBuyer);
  }

  async prepareOfferAction(claims: AgentTokenClaims, input: IntentInput & { action: 'FILL' | 'CANCEL' | 'FINALIZE_EXPIRY'; offerId: string; principalAmount?: string }) {
    const semantic: AgentAction = input.action === 'FILL' ? 'FILL_OFFER' : input.action === 'CANCEL' ? 'CANCEL_OFFER' : 'FINALIZE_OFFER_EXPIRY';
    this.requireScope(claims, 'offers:write');
    const replay = await this.replayIntent(claims, semantic, input);
    if (replay) return replay;
    const offer = await this.store.getV2Offer(input.offerId, this.market());
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', 'Offer was not found');
    const preflight = input.action === 'FILL'
      ? await this.preflight.fill({ actor: claims.wallet, offerId: input.offerId, principalAmount: input.principalAmount ?? '0' })
      : await this.preflight.offerLifecycle({ actor: claims.wallet, offerId: input.offerId }, input.action === 'CANCEL' ? 'cancelOffer' : 'finalizeOfferExpiry');
    return this.prepareIntent(claims, semantic, input, preflight, offer.assetAddress as Address, offer.seller as Address);
  }

  async preparePositionAction(claims: AgentTokenClaims, input: IntentInput & {
    action: 'REPAY' | 'START_AUCTION' | 'CLAIM_COLLATERAL' | 'CLAIM_ORACLE_FALLBACK';
    positionId: string;
    maxPayoff?: string;
    valuationId?: string;
    recipient?: Address;
  }) {
    const semanticMap = {
      REPAY: 'REPAY_POSITION',
      START_AUCTION: 'START_AUCTION',
      CLAIM_COLLATERAL: 'CLAIM_COLLATERAL',
      CLAIM_ORACLE_FALLBACK: 'CLAIM_ORACLE_FALLBACK',
    } as const;
    const semantic = semanticMap[input.action];
    this.requireScope(claims, 'positions:write');
    const replay = await this.replayIntent(claims, semantic, input);
    if (replay) return replay;
    const position = await this.store.getV2Position(input.positionId, this.market());
    if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position was not found');
    const preflight = input.action === 'REPAY'
      ? await this.preflight.repay({ actor: claims.wallet, positionId: input.positionId, ...(input.maxPayoff ? { maxPayoff: input.maxPayoff } : {}) })
      : await this.preflight.positionLifecycle({
        actor: claims.wallet,
        positionId: input.positionId,
        ...(input.valuationId ? { valuationId: input.valuationId } : {}),
        ...(input.recipient ? { recipient: input.recipient } : {}),
      }, input.action === 'START_AUCTION' ? 'startAuction' : input.action === 'CLAIM_COLLATERAL' ? 'claimDefaultCollateral' : 'claimCollateralOnOracleFailure');
    const counterparty = position.seller === claims.wallet.toLowerCase() ? position.buyer : position.seller;
    return this.prepareIntent(claims, semantic, input, preflight, position.assetAddress as Address, counterparty as Address);
  }

  async prepareAuctionAction(claims: AgentTokenClaims, input: IntentInput & { action: 'BUY' | 'FINALIZE_FAILED'; auctionId: string; maxPrice?: string }) {
    const semantic: AgentAction = input.action === 'BUY' ? 'BUY_AUCTION' : 'FINALIZE_FAILED_AUCTION';
    this.requireScope(claims, 'auctions:write');
    const replay = await this.replayIntent(claims, semantic, input);
    if (replay) return replay;
    const auction = await this.store.getAuction(input.auctionId, this.config.DUTCH_AUCTION_V2_ADDRESS as Address | undefined);
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction was not found');
    const preflight = input.action === 'BUY'
      ? await this.preflight.buyAuction({ actor: claims.wallet, auctionId: input.auctionId, ...(input.maxPrice ? { maxPrice: input.maxPrice } : {}) })
      : await this.preflight.finalizeFailedAuction({ actor: claims.wallet, auctionId: input.auctionId });
    return this.prepareIntent(claims, semantic, input, preflight, auction.assetAddress as Address, auction.seller as Address);
  }

  private async replayClaimIntent(claims: AgentTokenClaims, input: IntentInput & {
    claimId: string;
    escrowAddress?: Address;
    amount?: string;
    recipient?: Address;
  }) {
    const [existing] = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.agentId, claims.agentId),
      eq(agentIntents.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!existing) return undefined;
    const saved = existing.input as IntentInput;
    const sameAddress = (requested: unknown, recorded: unknown) => typeof requested !== 'string'
      || (typeof recorded === 'string' && requested.toLowerCase() === recorded.toLowerCase());
    const compatible = existing.action === 'CLAIM_SETTLEMENT'
      && String(saved.claimId) === input.claimId
      && (input.amount === undefined || String(saved.amount) === input.amount)
      && sameAddress(input.escrowAddress, saved.escrowAddress)
      && sameAddress(input.recipient ?? claims.wallet, saved.recipient);
    if (!compatible) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with different claim semantics');
    }
    const steps = await this.db.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, existing.id)).orderBy(asc(agentIntentSteps.stepIndex));
    return publicIntent(existing, steps);
  }

  async prepareClaim(claims: AgentTokenClaims, input: IntentInput & {
    claimId: string;
    escrowAddress?: Address;
    amount?: string;
    recipient?: Address;
  }) {
    this.requireScope(claims, 'claims:write');
    const replay = await this.replayClaimIntent(claims, input);
    if (replay) return replay;
    const candidates = (await this.store.listSettlementClaims(claims.wallet)).filter((claim) =>
      claim.claimId === input.claimId
      && (!input.escrowAddress || claim.escrowAddress === input.escrowAddress.toLowerCase()));
    if (candidates.length === 0) throw new AppError(404, 'CLAIM_NOT_FOUND', 'No indexed settlement claim for this wallet matches the requested claim identifier');
    if (candidates.length > 1) {
      throw new AppError(409, 'CLAIM_ESCROW_AMBIGUOUS', 'The claim identifier exists in more than one RWCAR escrow; provide escrowAddress', {
        candidates: candidates.map((claim) => ({ claimId: claim.claimId, escrowAddress: claim.escrowAddress, remaining: claim.remaining })),
      });
    }
    const claim = candidates[0]!;
    const normalizedInput: IntentInput & { escrowAddress: Address; claimId: string; amount: string; recipient: Address } = {
      ...input,
      escrowAddress: claim.escrowAddress as Address,
      amount: input.amount ?? claim.remaining,
      recipient: input.recipient ?? claims.wallet,
    };
    const preflight = await this.preflight.claimSettlement({
      actor: claims.wallet,
      escrowAddress: normalizedInput.escrowAddress,
      claimId: normalizedInput.claimId,
      amount: normalizedInput.amount,
      recipient: normalizedInput.recipient,
    });
    return this.prepareIntent(claims, 'CLAIM_SETTLEMENT', normalizedInput, preflight, claim.tokenAddress as Address);
  }

  async prepareMargin(claims: AgentTokenClaims, input: IntentInput) {
    this.requireScope(claims, 'margin:write');
    const replay = await this.replayIntent(claims, 'MARGIN_ACTION', input);
    if (replay) return replay;
    const body = { ...input, actor: claims.wallet } as unknown as Parameters<V2PreflightService['marginAction']>[0];
    const preflight = await this.preflight.marginAction(body);
    let asset = typeof input.asset === 'string' ? input.asset as Address : undefined;
    if (!asset && typeof input.accountId === 'string') {
      asset = (await this.store.getMarginAccount(input.accountId, this.config.MARGIN_ENGINE_V2_ADDRESS as Address | undefined))?.assetAddress as Address | undefined;
    }
    if (!asset && this.config.MARGIN_ENGINE_V2_ADDRESS) {
      asset = (await this.chain.marginMetadata(this.config.MARGIN_ENGINE_V2_ADDRESS as Address)).asset;
    }
    if (!asset) throw new AppError(409, 'ASSET_CONTEXT_REQUIRED', 'The margin action asset could not be resolved');
    const permittedLender = typeof input.permittedLender === 'string' && !/^0x0{40}$/i.test(input.permittedLender)
      ? input.permittedLender as Address
      : undefined;
    return this.prepareIntent(claims, 'MARGIN_ACTION', input, preflight, asset, permittedLender);
  }

  private evaluatePolicy(
    mandate: MandateRow,
    action: AgentAction,
    input: IntentInput,
    preflight: PreflightResultV2,
    asset: Address,
    counterparty?: Address,
  ) {
    const constraints = AgentMandateConstraintsSchema.parse(mandate.constraints);
    const reasons: string[] = [];
    if (!constraints.allowedActions.includes(action)) reasons.push('ACTION_NOT_ALLOWED');
    if (!constraints.allowedAssets.map((value) => value.toLowerCase()).includes(asset.toLowerCase())) reasons.push('ASSET_NOT_ALLOWED');
    const notional = notionalFrom(action, preflight, input);
    if (notional > BigInt(constraints.maxPerTransaction)) reasons.push('MAX_TRANSACTION_EXCEEDED');
    const rate = typeof input.annualRateBps === 'number'
      ? input.annualRateBps
      : typeof input.maxAnnualRateBps === 'number' ? input.maxAnnualRateBps : undefined;
    if (rate !== undefined && (rate < constraints.minAnnualRateBps || rate > constraints.maxAnnualRateBps)) reasons.push('RATE_OUTSIDE_MANDATE');
    const duration = typeof input.durationSeconds === 'number' ? input.durationSeconds : undefined;
    if (duration !== undefined && (duration < constraints.minDurationSeconds || duration > constraints.maxDurationSeconds)) reasons.push('DURATION_OUTSIDE_MANDATE');
    if (counterparty && constraints.allowedCounterparties.length > 0
      && !constraints.allowedCounterparties.map((value) => value.toLowerCase()).includes(counterparty.toLowerCase())) reasons.push('COUNTERPARTY_NOT_ALLOWED');
    const recipient = typeof input.recipient === 'string' ? input.recipient.toLowerCase() : undefined;
    const selfRecipient = mandate.wallet.toLowerCase();
    if (recipient && recipient !== selfRecipient
      && !constraints.allowedRecipients.map((value) => value.toLowerCase()).includes(recipient)) {
      reasons.push('RECIPIENT_NOT_ALLOWED');
    }
    if (!isExecutablePreflight(preflight)) reasons.push(...preflight.blockingReasons);
    if (reasons.length > 0) return { decision: 'DENIED' as const, reason: [...new Set(reasons)].join(','), notional, constraints };
    const approval = resolveMandateApproval(constraints, action, notional);
    return {
      ...approval,
      notional,
      constraints,
    };
  }

  private async assertTrustedExecutionPlan(
    action: AgentAction,
    input: IntentInput,
    preflight: PreflightResultV2,
    wallet: Address,
  ) {
    const market = this.market();
    const settlementEscrows = new Set<string>();
    if (this.config.SETTLEMENT_ESCROW_V2_ADDRESS) settlementEscrows.add(this.config.SETTLEMENT_ESCROW_V2_ADDRESS.toLowerCase());
    if (action === 'CLAIM_SETTLEMENT' && this.config.MARGIN_ENGINE_V2_ADDRESS) {
      const marginMetadata = await this.chain.marginMetadata(this.config.MARGIN_ENGINE_V2_ADDRESS as Address).catch(() => null);
      if (marginMetadata?.settlementEscrow) settlementEscrows.add(marginMetadata.settlementEscrow.toLowerCase());
    }
    const margin = this.config.MARGIN_ENGINE_V2_ADDRESS?.toLowerCase();
    const settlement = this.config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase();
    const approvalTokens = new Set([
      settlement,
      ...preflight.compliance.map((entry) => entry.asset.toLowerCase()),
      ...preflight.transferGraph.map((entry) => entry.edge.token.toLowerCase()),
    ]);
    const approvalSpenders = new Set([
      market.toLowerCase(),
      this.config.COLLATERAL_VAULT_V2_ADDRESS?.toLowerCase(),
      margin,
      ...preflight.transferGraph
        .filter((entry) => entry.edge.from.toLowerCase() === wallet.toLowerCase())
        .map((entry) => entry.edge.to.toLowerCase()),
    ].filter((value): value is string => Boolean(value)));
    let marginProtocolSteps = 0;
    let repoVaultSweepSteps = 0;
    for (const approval of preflight.requiredApprovals) {
      if (!approvalTokens.has(approval.token.toLowerCase())
        || !approvalSpenders.has(approval.spender.toLowerCase())
        || BigInt(approval.amount) <= 0n) {
        throw new AppError(409, 'UNTRUSTED_EXECUTION_PLAN', 'Preflight requested an approval outside the reviewed asset and spender graph');
      }
    }
    for (const transaction of preflight.transactions) {
      if (BigInt(transaction.value) !== 0n) {
        throw new AppError(409, 'UNTRUSTED_EXECUTION_PLAN', 'RWCAR agent transactions cannot transfer native currency');
      }
      let functionName: string;
      try {
        if (action === 'CLAIM_SETTLEMENT') {
          if (!settlementEscrows.has(transaction.to.toLowerCase())) throw new Error('destination');
          functionName = decodeFunctionData({ abi: settlementEscrowV2Abi, data: transaction.data as Hex }).functionName;
          if (functionName !== 'claim') throw new Error('selector');
        } else if (action === 'MARGIN_ACTION') {
          if (margin && transaction.to.toLowerCase() === margin) {
            functionName = decodeFunctionData({ abi: marginEngineV2Abi, data: transaction.data as Hex }).functionName;
            if (functionName !== MARGIN_FUNCTION_BY_ACTION[String(input.action)] || ++marginProtocolSteps > 1) throw new Error('selector');
          } else if (
            transaction.to.toLowerCase() === market.toLowerCase()
            && ['DEPOSIT', 'DEPOSIT_COLLATERAL'].includes(String(input.action))
          ) {
            const decoded = decodeFunctionData({ abi: repoMarketV2Abi, data: transaction.data as Hex });
            functionName = decoded.functionName;
            if (functionName !== 'withdrawCollateral' || ++repoVaultSweepSteps > 1) throw new Error('selector');
            const [asset, amount, recipient] = decoded.args as readonly [Address, bigint, Address];
            const provenSweep = preflight.transferGraph.some((entry) =>
              entry.edge.token.toLowerCase() === asset.toLowerCase()
              && entry.edge.to.toLowerCase() === wallet.toLowerCase()
              && entry.edge.amount === amount.toString()
              && entry.edge.purpose === 'COLLATERAL_RELEASE');
            if (!provenSweep || recipient.toLowerCase() !== wallet.toLowerCase()) throw new Error('sweep');
          } else {
            throw new Error('destination');
          }
        } else {
          if (transaction.to.toLowerCase() !== market.toLowerCase()) throw new Error('destination');
          functionName = decodeFunctionData({ abi: repoMarketV2Abi, data: transaction.data as Hex }).functionName;
          if (!MARKET_FUNCTIONS[action].has(functionName)) throw new Error('selector');
        }
      } catch {
        throw new AppError(409, 'UNTRUSTED_EXECUTION_PLAN', 'Preflight produced a destination or selector outside the reviewed semantic action');
      }
    }
    if (action === 'MARGIN_ACTION' && marginProtocolSteps !== 1) {
      throw new AppError(409, 'UNTRUSTED_EXECUTION_PLAN', 'A margin intent must contain exactly one reviewed MarginEngine action');
    }
  }

  private async prepareIntent(
    claims: AgentTokenClaims,
    action: AgentAction,
    input: IntentInput,
    preflight: PreflightResultV2,
    asset: Address,
    counterparty?: Address,
  ) {
    await this.expirePreparedIntents(claims.agentId);
    const mandate = await this.activeMandate(claims.agentId, true);
    if (!mandate) throw new AppError(403, 'MANDATE_REQUIRED', 'No active mandate exists');
    const replay = await this.replayIntent(claims, action, input);
    if (replay) return replay;

    const policy = this.evaluatePolicy(mandate, action, input, preflight, asset, counterparty);
    if (policy.decision !== 'DENIED') await this.assertTrustedExecutionPlan(action, input, preflight, claims.wallet);
    const steps = policy.decision === 'DENIED' ? [] : [
      ...preflight.requiredApprovals.map((approval) => ({
        kind: 'APPROVAL',
        destination: approval.token.toLowerCase(),
        calldata: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender as Address, BigInt(approval.amount)] }),
        nativeValue: '0',
        description: `Approve ${approval.amount} units for ${approval.spender}`,
      })),
      ...preflight.transactions.map((transaction) => ({
        kind: 'PROTOCOL',
        destination: transaction.to.toLowerCase(),
        calldata: transaction.data,
        nativeValue: transaction.value,
        description: transaction.description,
      })),
    ];
    if (policy.decision !== 'DENIED' && steps.length === 0) {
      throw new AppError(409, 'EMPTY_EXECUTION_PLAN', 'Eligible preflight returned no transaction steps');
    }
    const intentExpiresAt = new Date(Date.now() + this.config.AGENT_INTENT_TTL_SECONDS * 1_000);

    const result = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, claims.agentId);
      const [raced] = await tx.select().from(agentIntents).where(and(
        eq(agentIntents.agentId, claims.agentId),
        eq(agentIntents.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (raced) {
        if (raced.action !== action || canonicalJson(raced.input) !== canonicalJson(input)) {
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with different intent semantics');
        }
        return { intent: raced, decision: raced.policyDecision };
      }
      const now = new Date();
      const [[liveAgent], [liveMandate]] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, claims.agentId)).limit(1),
        tx.select().from(agentMandates).where(and(
          eq(agentMandates.id, mandate.id),
          eq(agentMandates.agentId, claims.agentId),
          eq(agentMandates.status, 'ACTIVE'),
          eq(agentMandates.manifestHash, mandate.manifestHash),
          sql`${agentMandates.startsAt} <= ${now}`,
          sql`${agentMandates.expiresAt} > ${now}`,
        )).limit(1),
      ]);
      if (!liveAgent || liveAgent.status !== 'ACTIVE' || !liveAgent.cviActive
        || (liveAgent.cviExpiresAt && liveAgent.cviExpiresAt <= now)) {
        throw new AppError(409, 'AGENT_ACCESS_REVOKED', 'Agent authorization changed during intent preparation');
      }
      if (!liveMandate) throw new AppError(409, 'INTENT_MANDATE_INACTIVE', 'The signed mandate changed during intent preparation');
      const bucketStart = startOfUtcDay();
      await tx.insert(agentUsageBuckets).values({
        agentId: claims.agentId,
        mandateId: mandate.id,
        bucketStart,
      }).onConflictDoNothing();
      const bucket = await tx.select().from(agentUsageBuckets).where(and(
        eq(agentUsageBuckets.agentId, claims.agentId),
        eq(agentUsageBuckets.mandateId, mandate.id),
        eq(agentUsageBuckets.bucketStart, bucketStart),
      )).limit(1).then((rows) => rows[0]);
      if (!bucket) throw new Error('Usage bucket insert returned no row');
      let decision = policy.decision;
      let reason = policy.reason;
      if (decision !== 'DENIED'
        && BigInt(bucket.reservedNotional) + BigInt(bucket.completedNotional) + policy.notional > BigInt(policy.constraints.maxDailyNotional)) {
        decision = 'DENIED';
        reason = 'MAX_DAILY_NOTIONAL_EXCEEDED';
      }
      const state = decision === 'DENIED' ? 'DENIED' : decision === 'HUMAN_REQUIRED' ? 'APPROVAL_REQUIRED' : 'PREPARED';
      const reservedNotional = decision === 'DENIED' ? '0' : policy.notional.toString();
      const intentHash = canonicalHash({
        version: 1,
        agentId: claims.agentId,
        wallet: claims.wallet.toLowerCase(),
        mandateId: mandate.id,
        mandateVersion: mandate.version,
        manifestHash: mandate.manifestHash,
        idempotencyKey: input.idempotencyKey,
        action,
        input,
        asset: asset.toLowerCase(),
        policyDecision: decision,
        approvalReason: reason,
        reservedNotional,
        preflightHash: canonicalHash(preflight),
        steps: decision === 'DENIED' ? [] : steps,
        expiresAt: intentExpiresAt.toISOString(),
      });
      const [intent] = await tx.insert(agentIntents).values({
        agentId: claims.agentId,
        mandateId: mandate.id,
        idempotencyKey: input.idempotencyKey,
        action,
        input,
        intentHash,
        state,
        policyDecision: decision,
        approvalRequired: decision === 'HUMAN_REQUIRED',
        approvalReason: reason,
        reservedNotional,
        preflight,
        correlationId: preflight.correlationId,
        quoteExpiresAt: new Date(preflight.quote.expiresAt),
        intentExpiresAt,
        manifestHash: mandate.manifestHash,
      }).returning();
      if (!intent) throw new Error('Intent insert returned no row');
      if (decision !== 'DENIED') {
        await tx.update(agentUsageBuckets).set({
          reservedNotional: (BigInt(bucket.reservedNotional) + policy.notional).toString(),
          updatedAt: new Date(),
        }).where(and(
          eq(agentUsageBuckets.agentId, claims.agentId),
          eq(agentUsageBuckets.mandateId, mandate.id),
          eq(agentUsageBuckets.bucketStart, bucketStart),
        ));
        if (steps.length > 0) await tx.insert(agentIntentSteps).values(steps.map((step, index) => ({
          intentId: intent.id,
          stepIndex: index,
          ...step,
        })));
      }
      await tx.insert(agentEvents).values({
        agentId: claims.agentId,
        intentId: intent.id,
        eventType: `INTENT_${state}`,
        payload: { action, intentHash, reason, correlationId: preflight.correlationId },
      });
      return { intent, decision };
    });
    const savedSteps = result.decision === 'DENIED' ? [] : await this.db.select().from(agentIntentSteps)
      .where(eq(agentIntentSteps.intentId, result.intent.id)).orderBy(asc(agentIntentSteps.stepIndex));
    return publicIntent(result.intent, savedSteps);
  }

  async approveIntent(claims: AuthClaims, agentId: string, intentId: string, input: {
    decision: 'APPROVE' | 'REJECT';
    expiresAt: number;
    signature: Hex;
  }) {
    const { institution } = await this.assertAdminAgent(claims, agentId);
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.id, intentId), eq(agentIntents.agentId, agentId))).limit(1);
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Intent was not found');
    if (intent.state !== 'APPROVAL_REQUIRED') throw new AppError(409, 'INTENT_NOT_APPROVABLE', 'The intent is not waiting for approval');
    const now = Math.floor(Date.now() / 1_000);
    if (input.expiresAt <= now || input.expiresAt > now + 300 || intent.intentExpiresAt <= new Date()) {
      throw new AppError(400, 'APPROVAL_EXPIRED', 'Approval must be live and bounded to five minutes');
    }
    const recovered = await recoverTypedDataAddress({
      ...intentApprovalTypedData(this.market(), {
        intentId,
        intentHash: intent.intentHash as Hex,
        decision: input.decision,
        expiresAt: input.expiresAt,
      }),
      signature: input.signature,
    });
    if (recovered.toLowerCase() !== institution.adminWallet.toLowerCase()) {
      throw new AppError(403, 'INVALID_APPROVAL_SIGNATURE', 'Intent approval must be signed by the institution administrator');
    }
    await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, agentId);
      const [current] = await tx.select().from(agentIntents).where(and(
        eq(agentIntents.id, intentId),
        eq(agentIntents.agentId, agentId),
      )).limit(1);
      if (!current || current.state !== 'APPROVAL_REQUIRED' || current.intentExpiresAt <= new Date()) {
        throw new AppError(409, 'INTENT_NOT_APPROVABLE', 'The intent authority changed before approval was recorded');
      }
      await tx.insert(agentApprovals).values({
        intentId,
        approverWallet: recovered.toLowerCase(),
        decision: input.decision,
        intentHash: intent.intentHash,
        signature: input.signature,
        expiresAt: new Date(input.expiresAt * 1_000),
      });
      const [updated] = await tx.update(agentIntents).set({
        state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        updatedAt: new Date(),
      }).where(and(eq(agentIntents.id, intentId), eq(agentIntents.state, 'APPROVAL_REQUIRED'))).returning();
      if (!updated) throw new AppError(409, 'INTENT_STATE_RACE', 'The intent state changed while approval was being recorded');
      if (input.decision === 'REJECT') await moveUsageReservation(tx, intent, false);
      await tx.insert(agentEvents).values({ agentId, intentId, eventType: `INTENT_${input.decision}D`, payload: { approver: recovered.toLowerCase() } });
    });
    return this.intentForAdmin(claims, agentId, intentId);
  }

  async approvalChallenge(claims: AuthClaims, agentId: string, intentId: string, decision: 'APPROVE' | 'REJECT') {
    await this.assertAdminAgent(claims, agentId);
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.id, intentId), eq(agentIntents.agentId, agentId))).limit(1);
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Intent was not found');
    if (intent.state !== 'APPROVAL_REQUIRED' || intent.intentExpiresAt <= new Date()) {
      throw new AppError(409, 'INTENT_NOT_APPROVABLE', 'The intent is not live and waiting for approval');
    }
    const expiresAt = Math.min(Math.floor(Date.now() / 1_000) + 300, Math.floor(intent.intentExpiresAt.getTime() / 1_000));
    return serializeRow(intentApprovalTypedData(this.market(), { intentId, intentHash: intent.intentHash as Hex, decision, expiresAt }));
  }

  private async intentForAdmin(claims: AuthClaims, agentId: string, intentId: string) {
    await this.assertAdminAgent(claims, agentId);
    const [intent] = await this.db.select().from(agentIntents).where(and(eq(agentIntents.id, intentId), eq(agentIntents.agentId, agentId))).limit(1);
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Intent was not found');
    const steps = await this.db.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, intent.id)).orderBy(asc(agentIntentSteps.stepIndex));
    return publicIntent(intent, steps);
  }

  async executeIntent(claims: AgentTokenClaims, intentId: string, expectedHash: Hex) {
    this.requireScope(claims, 'intents:execute');
    const result = await this.db.transaction(async (tx) => {
      await lockAgentAuthority(tx, claims.agentId);
      const [intent] = await tx.select().from(agentIntents).where(and(
        eq(agentIntents.id, intentId),
        eq(agentIntents.agentId, claims.agentId),
      )).limit(1);
      if (!intent) return { error: new AppError(404, 'INTENT_NOT_FOUND', 'Intent was not found') };
      if (intent.intentHash.toLowerCase() !== expectedHash.toLowerCase()) {
        return { error: new AppError(409, 'INTENT_HASH_MISMATCH', 'The supplied intent hash does not match the prepared intent') };
      }
      if (intent.intentExpiresAt <= new Date()) {
        await terminateIntentInTransaction(tx, intent, 'EXPIRED', 'INTENT_EXPIRED', 'The intent expired before it was queued', ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED']);
        return { error: new AppError(409, 'INTENT_EXPIRED', 'The intent has expired and must be prepared again') };
      }
      const allowed = intent.approvalRequired ? intent.state === 'APPROVED' : intent.state === 'PREPARED';
      if (!allowed) return { error: new AppError(409, 'INTENT_NOT_EXECUTABLE', `Intent state ${intent.state} cannot be queued`) };
      const now = new Date();
      const [[agent], [mandate]] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, claims.agentId)).limit(1),
        tx.select().from(agentMandates).where(and(
          eq(agentMandates.id, intent.mandateId),
          eq(agentMandates.agentId, claims.agentId),
          eq(agentMandates.status, 'ACTIVE'),
          eq(agentMandates.manifestHash, intent.manifestHash),
          sql`${agentMandates.startsAt} <= ${now}`,
          sql`${agentMandates.expiresAt} > ${now}`,
        )).limit(1),
      ]);
      if (!agent || agent.status !== 'ACTIVE' || !agent.cviActive
        || (agent.cviExpiresAt && agent.cviExpiresAt <= now)) {
        await terminateIntentInTransaction(tx, intent, 'CANCELLED', 'AGENT_ACCESS_REVOKED', 'Agent authorization changed before execution', ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED']);
        return { error: new AppError(409, 'AGENT_ACCESS_REVOKED', 'Agent authorization changed before execution') };
      }
      if (!mandate) {
        await terminateIntentInTransaction(tx, intent, 'CANCELLED', 'INTENT_MANDATE_INACTIVE', 'The exact mandate that authorized this intent is no longer active', ['PREPARED', 'APPROVAL_REQUIRED', 'APPROVED']);
        return { error: new AppError(409, 'INTENT_MANDATE_INACTIVE', 'The exact mandate that authorized this intent is no longer active') };
      }
      if (intent.approvalRequired) {
        const [approval] = await tx.select().from(agentApprovals).where(and(
          eq(agentApprovals.intentId, intent.id),
          eq(agentApprovals.decision, 'APPROVE'),
          eq(agentApprovals.intentHash, intent.intentHash),
          sql`${agentApprovals.expiresAt} > ${now}`,
        )).limit(1);
        if (!approval) return { error: new AppError(409, 'APPROVAL_REQUIRED', 'A live approval bound to this intent hash is required') };
      }
      const [queued] = await tx.update(agentIntents).set({ state: 'QUEUED', updatedAt: new Date() })
        .where(and(eq(agentIntents.id, intent.id), eq(agentIntents.state, intent.state))).returning();
      if (!queued) return { error: new AppError(409, 'INTENT_STATE_RACE', 'The intent state changed while it was being queued') };
      await tx.insert(agentEvents).values({ agentId: claims.agentId, intentId, eventType: 'INTENT_QUEUED', payload: {} });
      return { queued };
    });
    if ('error' in result && result.error) throw result.error;
    return this.intentForAgent(claims.agentId, intentId);
  }

  async leaseIntent(workerId: string) {
    this.assertEnabled();
    return this.db.transaction(async (tx) => {
      const staleBefore = new Date(Date.now() - this.config.AGENT_EXECUTOR_LEASE_TIMEOUT_SECONDS * 1_000);
      const [intent] = await tx.select().from(agentIntents).where(or(
        eq(agentIntents.state, 'QUEUED'),
        and(
          inArray(agentIntents.state, ['SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING']),
          lt(agentIntents.lockedAt, staleBefore),
        ),
      ))
        .orderBy(asc(agentIntents.createdAt)).limit(1).for('update', { skipLocked: true });
      if (!intent) return null;
      const steps = await tx.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, intent.id)).orderBy(asc(agentIntentSteps.stepIndex));
      const failLease = async (code: string, message: string) => {
        const allowanceConfirmed = steps.some((step) => step.kind === 'APPROVAL' && step.status === 'CONFIRMED');
        const state = allowanceConfirmed ? 'FAILED_WITH_ALLOWANCE' : 'FAILED';
        const [failed] = await tx.update(agentIntents).set({ state, errorCode: code, errorMessage: message, updatedAt: new Date() })
          .where(and(eq(agentIntents.id, intent.id), inArray(agentIntents.state, ['QUEUED', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING']))).returning();
        if (failed) {
          await moveUsageReservation(tx, intent, false);
          await tx.insert(agentEvents).values({ agentId: intent.agentId, intentId: intent.id, eventType: `INTENT_${state}`, payload: { code, message } });
        }
        return null;
      };
      const [agent] = await tx.select().from(agents).where(eq(agents.id, intent.agentId)).limit(1);
      if (!agent?.walletAddress) {
        return failLease('AGENT_SIGNER_UNAVAILABLE', 'Agent wallet configuration is unavailable');
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-wallet:${agent.walletAddress}`}))`);
      const [otherLease] = await tx.select({ id: agentIntents.id }).from(agentIntents).where(and(
        eq(agentIntents.agentId, intent.agentId),
        ne(agentIntents.id, intent.id),
        inArray(agentIntents.state, ['SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING']),
        gte(agentIntents.lockedAt, staleBefore),
      )).limit(1);
      if (otherLease) return null;
      if (steps.length === 0) return failLease('EMPTY_EXECUTION_PLAN', 'The queued intent contains no transaction steps');
      const nextStep = steps.find((step) => step.status !== 'CONFIRMED' && step.status !== 'SKIPPED');
      if (nextStep?.status === 'SUBMITTED' && !nextStep.txHash) {
        return failLease('STEP_TRANSACTION_MISSING', 'A submitted transaction step has no immutable transaction hash');
      }
      if (nextStep?.status === 'FAILED') {
        return failLease('INVALID_STEP_STATE', 'A failed transaction step remained attached to an executable intent');
      }
      const reconciliationOnly = !nextStep || nextStep.status === 'SUBMITTED';
      const signerReady = Boolean(agent.privyWalletId && agent.signerId === this.config.PRIVY_AGENT_SIGNER_ID
        && agent.policyId === this.config.PRIVY_AGENT_POLICY_ID);
      if ((!signerReady || agent.status !== 'ACTIVE' || !agent.cviActive) && !reconciliationOnly) {
        const ambiguous = nextStep?.status === 'SIGNING';
        const code = ambiguous
          ? 'AMBIGUOUS_SIGNING_OUTCOME'
          : agent.status !== 'ACTIVE' || !agent.cviActive ? 'AGENT_ACCESS_REVOKED' : 'AGENT_SIGNER_UNAVAILABLE';
        const message = ambiguous
          ? 'Signing began before authority changed; inspect Privy and Monad before any retry'
          : 'Agent signer, policy, or live authorization is unavailable';
        return failLease(code, message);
      }
      const allConfirmed = steps.length > 0 && steps.every((step) => step.status === 'CONFIRMED');
      const leasedState = allConfirmed ? (intent.state === 'INDEXING' ? 'INDEXING' : 'CONFIRMED') : 'SIGNING';
      const [leased] = await tx.update(agentIntents).set({ state: leasedState, lockedBy: workerId, lockedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentIntents.id, intent.id)).returning();
      if (!leased) return null;
      return serializeRow({
        intent: leased,
        agent: {
          walletAddress: agent.walletAddress,
          // These fallbacks are used only to reconcile an already-submitted
          // transaction or finalized steps. No signing path can reach them.
          privyWalletId: agent.privyWalletId ?? 'reconciliation-only',
          signerId: agent.signerId ?? this.config.PRIVY_AGENT_SIGNER_ID!,
          policyId: agent.policyId ?? this.config.PRIVY_AGENT_POLICY_ID!,
        },
        steps,
      });
    });
  }

  async refreshIntent(intentId: string, workerId: string) {
    const [intent] = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.id, intentId),
      eq(agentIntents.state, 'SIGNING'),
      eq(agentIntents.lockedBy, workerId),
    )).limit(1);
    if (!intent) throw new AppError(409, 'INTENT_LEASE_LOST', 'The executor no longer owns this intent');
    if (intent.intentExpiresAt <= new Date()) {
      await this.failIntent(intent, 'INTENT_EXPIRED', 'The intent expired before signing');
      throw new AppError(409, 'INTENT_EXPIRED', 'The intent expired before signing');
    }
    const [agent] = await this.db.select().from(agents).where(eq(agents.id, intent.agentId)).limit(1);
    if (!agent?.walletAddress || agent.status !== 'ACTIVE' || !agent.cviActive
      || agent.signerId !== this.config.PRIVY_AGENT_SIGNER_ID
      || agent.policyId !== this.config.PRIVY_AGENT_POLICY_ID) {
      await this.failIntent(intent, 'AGENT_ACCESS_REVOKED', 'Agent access was revoked before signing');
      throw new AppError(409, 'AGENT_ACCESS_REVOKED', 'Agent access was revoked before signing');
    }
    if (!await this.intentMandate(intent, false)) {
      await this.failIntent(intent, 'INTENT_MANDATE_INACTIVE', 'The exact signed mandate is no longer active');
      throw new AppError(409, 'INTENT_MANDATE_INACTIVE', 'The exact mandate that authorized this intent is no longer active');
    }
    const saved = await this.db.select().from(agentIntentSteps).where(eq(agentIntentSteps.intentId, intent.id)).orderBy(asc(agentIntentSteps.stepIndex));
    const refreshInput = { ...(intent.input as IntentInput) };
    const repoSweepAlreadyConfirmed = intent.action === 'MARGIN_ACTION'
      && ['DEPOSIT', 'DEPOSIT_COLLATERAL'].includes(String(refreshInput.action))
      && saved.some((step) => step.kind === 'PROTOCOL'
        && step.status === 'CONFIRMED'
        && step.destination.toLowerCase() === this.market().toLowerCase());
    if (repoSweepAlreadyConfirmed) refreshInput.collateralSource = 'WALLET';
    let preflight: PreflightResultV2;
    try {
      preflight = await this.runPreflight(intent.action as AgentAction, refreshInput, agent.walletAddress as Address);
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) {
        await this.failIntent(intent, error.code, `Fresh preflight failed: ${error.message}`);
      }
      throw error;
    }
    if (!isExecutablePreflight(preflight)) {
      const code = preflight.blockingReasons[0] ?? 'PREFLIGHT_BLOCKED';
      await this.failIntent(intent, code, `Fresh preflight blocked execution: ${preflight.blockingReasons.join(', ')}`);
      throw new AppError(409, code, 'Fresh preflight blocked execution', { blockingReasons: preflight.blockingReasons });
    }
    try {
      await this.assertTrustedExecutionPlan(intent.action as AgentAction, intent.input as IntentInput, preflight, agent.walletAddress as Address);
    } catch (error) {
      if (error instanceof AppError) await this.failIntent(intent, error.code, error.message);
      throw error;
    }
    // A composed intent may intentionally change live state between its own
    // steps (for example repo-vault sweep -> margin deposit). Re-preflight must
    // match the still-unexecuted suffix exactly, not require already-confirmed
    // protocol steps to remain necessary forever.
    const same = preflightMatchesRemainingProtocolSteps(saved, preflight.transactions);
    if (!same) {
      await this.failIntent(intent, 'INTENT_SEMANTICS_CHANGED', 'Fresh preflight produced different calldata');
      throw new AppError(409, 'INTENT_SEMANTICS_CHANGED', 'Fresh preflight produced different calldata; prepare a new intent');
    }
    await this.db.update(agentIntents).set({ preflight, correlationId: preflight.correlationId, quoteExpiresAt: new Date(preflight.quote.expiresAt), lockedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentIntents.id, intent.id));
    return { eligible: true, correlationId: preflight.correlationId, quote: preflight.quote };
  }

  private async runPreflight(action: AgentAction, input: IntentInput, wallet: Address) {
    if (action === 'VAULT_DEPOSIT') return this.preflight.deposit({ actor: wallet, asset: input.asset as Address, amount: input.amount as string });
    if (action === 'VAULT_WITHDRAW') return this.preflight.withdraw({ actor: wallet, asset: input.asset as Address, amount: input.amount as string, ...(input.recipient ? { recipient: input.recipient as Address } : {}) });
    if (action === 'CREATE_OFFER') return this.preflight.createOffer({ ...input, seller: wallet } as unknown as Parameters<V2PreflightService['createOffer']>[0]);
    if (action === 'FILL_OFFER') return this.preflight.fill({ actor: wallet, offerId: input.offerId as string, principalAmount: input.principalAmount as string });
    if (action === 'CANCEL_OFFER' || action === 'FINALIZE_OFFER_EXPIRY') return this.preflight.offerLifecycle({ actor: wallet, offerId: input.offerId as string }, action === 'CANCEL_OFFER' ? 'cancelOffer' : 'finalizeOfferExpiry');
    if (action === 'REPAY_POSITION') return this.preflight.repay({ actor: wallet, positionId: input.positionId as string, ...(input.maxPayoff ? { maxPayoff: input.maxPayoff as string } : {}) });
    if (['START_AUCTION', 'CLAIM_COLLATERAL', 'CLAIM_ORACLE_FALLBACK'].includes(action)) return this.preflight.positionLifecycle({
      actor: wallet,
      positionId: input.positionId as string,
      ...(input.valuationId ? { valuationId: input.valuationId as string } : {}),
      ...(input.recipient ? { recipient: input.recipient as Address } : {}),
    }, action === 'START_AUCTION' ? 'startAuction' : action === 'CLAIM_COLLATERAL' ? 'claimDefaultCollateral' : 'claimCollateralOnOracleFailure');
    if (action === 'BUY_AUCTION') return this.preflight.buyAuction({ actor: wallet, auctionId: input.auctionId as string, ...(input.maxPrice ? { maxPrice: input.maxPrice as string } : {}) });
    if (action === 'FINALIZE_FAILED_AUCTION') return this.preflight.finalizeFailedAuction({ actor: wallet, auctionId: input.auctionId as string });
    if (action === 'CLAIM_SETTLEMENT') return this.preflight.claimSettlement({
      actor: wallet,
      escrowAddress: input.escrowAddress as Address,
      claimId: input.claimId as string,
      amount: input.amount as string,
      ...(input.recipient ? { recipient: input.recipient as Address } : {}),
    });
    return this.preflight.marginAction({ ...input, actor: wallet } as unknown as Parameters<V2PreflightService['marginAction']>[0]);
  }

  async reportStep(workerId: string, intentId: string, stepIndex: number, input: {
    status: 'SIGNING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
    txHash?: string | undefined;
    privyActionId?: string | undefined;
    errorMessage?: string | undefined;
  }) {
    const [intent] = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.id, intentId),
      eq(agentIntents.lockedBy, workerId),
      inArray(agentIntents.state, ['SIGNING', 'SUBMITTED']),
    )).limit(1);
    if (!intent) throw new AppError(409, 'INTENT_LEASE_LOST', 'The executor no longer owns this intent');
    const [currentStep] = await this.db.select().from(agentIntentSteps).where(and(
      eq(agentIntentSteps.intentId, intentId),
      eq(agentIntentSteps.stepIndex, stepIndex),
    )).limit(1);
    if (!currentStep) throw new AppError(404, 'INTENT_STEP_NOT_FOUND', 'Intent step was not found');
    if (currentStep.txHash && input.txHash && currentStep.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new AppError(409, 'STEP_TRANSACTION_MISMATCH', 'A transaction step cannot be rebound to a different hash');
    }
    if (currentStep.privyActionId && input.privyActionId && currentStep.privyActionId !== input.privyActionId) {
      throw new AppError(409, 'STEP_ACTION_MISMATCH', 'A transaction step cannot be rebound to a different Privy action');
    }
    if (currentStep.status === 'CONFIRMED' && input.status === 'CONFIRMED') return { accepted: true, idempotent: true };
    const transitionAllowed = input.status === 'SIGNING'
      ? ['PENDING', 'SIGNING'].includes(currentStep.status)
      : input.status === 'SUBMITTED'
        ? ['PENDING', 'SIGNING', 'SUBMITTED'].includes(currentStep.status)
        : input.status === 'CONFIRMED'
          ? currentStep.status === 'SUBMITTED'
          : ['PENDING', 'SIGNING', 'SUBMITTED'].includes(currentStep.status);
    if (!transitionAllowed) throw new AppError(409, 'INVALID_STEP_TRANSITION', `Step ${currentStep.status} cannot transition to ${input.status}`);
    const [step] = await this.db.update(agentIntentSteps).set({
      status: input.status,
      txHash: input.txHash?.toLowerCase(),
      privyActionId: input.privyActionId,
      errorMessage: input.errorMessage,
      ...(input.status === 'SUBMITTED' ? { submittedAt: new Date() } : {}),
      ...(input.status === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(agentIntentSteps.intentId, intentId),
      eq(agentIntentSteps.stepIndex, stepIndex),
      eq(agentIntentSteps.status, currentStep.status),
    )).returning();
    if (!step) throw new AppError(404, 'INTENT_STEP_NOT_FOUND', 'Intent step was not found');
    if (input.status === 'FAILED') {
      await this.failIntent(intent, step.kind === 'APPROVAL' ? 'APPROVAL_TRANSACTION_FAILED' : 'PROTOCOL_TRANSACTION_FAILED', input.errorMessage ?? 'Transaction failed');
    } else if (input.status === 'SIGNING') {
      await this.db.update(agentIntents).set({ state: 'SIGNING', lockedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentIntents.id, intentId));
    } else if (input.status === 'SUBMITTED') {
      await this.db.update(agentIntents).set({ state: 'SUBMITTED', txHash: input.txHash?.toLowerCase(), privyActionId: input.privyActionId, submittedAt: new Date(), lockedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentIntents.id, intentId));
    } else {
      const remaining = await this.db.select().from(agentIntentSteps).where(and(eq(agentIntentSteps.intentId, intentId), sql`${agentIntentSteps.status} <> 'CONFIRMED'`));
      if (remaining.length === 0) {
        await this.db.update(agentIntents).set({ state: 'CONFIRMED', txHash: input.txHash?.toLowerCase(), confirmedAt: new Date(), lockedAt: new Date(), updatedAt: new Date() })
          .where(eq(agentIntents.id, intentId));
      } else {
        await this.db.update(agentIntents).set({ state: 'SIGNING', lockedAt: new Date(), updatedAt: new Date() }).where(eq(agentIntents.id, intentId));
      }
    }
    return { accepted: true };
  }

  async completeIntent(workerId: string, intentId: string) {
    const [intent] = await this.db.select().from(agentIntents).where(and(
      eq(agentIntents.id, intentId),
      eq(agentIntents.lockedBy, workerId),
      inArray(agentIntents.state, ['CONFIRMED', 'INDEXING']),
    )).limit(1);
    if (!intent) throw new AppError(409, 'INTENT_LEASE_LOST', 'The executor no longer owns this intent');
    const incomplete = await this.db.select({ id: agentIntentSteps.id }).from(agentIntentSteps).where(and(
      eq(agentIntentSteps.intentId, intentId),
      sql`${agentIntentSteps.status} <> 'CONFIRMED'`,
    )).limit(1);
    if (incomplete.length > 0 || !intent.txHash) throw new AppError(409, 'INTENT_NOT_CONFIRMED', 'Every transaction step must be confirmed before index reconciliation');
    const indexStatus = intent.txHash ? await this.store.transactionIndexStatus(intent.txHash).catch(() => null) : null;
    if (!indexStatus?.finalized) {
      await this.db.update(agentIntents).set({ state: 'INDEXING', lockedAt: new Date(), updatedAt: new Date() }).where(eq(agentIntents.id, intentId));
      return { complete: false, state: 'INDEXING', indexStatus: serializeRow(indexStatus) };
    }
    await this.db.transaction(async (tx) => {
      const [completed] = await tx.update(agentIntents).set({ state: 'COMPLETED', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentIntents.id, intentId), inArray(agentIntents.state, ['CONFIRMED', 'INDEXING']))).returning();
      if (!completed) throw new AppError(409, 'INTENT_STATE_RACE', 'The intent state changed during index reconciliation');
      await moveUsageReservation(tx, intent, true);
      await tx.insert(agentEvents).values({ agentId: intent.agentId, intentId, eventType: 'INTENT_COMPLETED', payload: { txHash: intent.txHash } });
    });
    return { complete: true, state: 'COMPLETED', indexStatus: serializeRow(indexStatus) };
  }

  private async failIntent(intent: IntentRow, code: string, message: string) {
    const [confirmedApproval] = await this.db.select({ id: agentIntentSteps.id }).from(agentIntentSteps).where(and(
      eq(agentIntentSteps.intentId, intent.id),
      eq(agentIntentSteps.kind, 'APPROVAL'),
      eq(agentIntentSteps.status, 'CONFIRMED'),
    )).limit(1);
    await this.terminateIntent(intent, confirmedApproval ? 'FAILED_WITH_ALLOWANCE' : 'FAILED', code, message);
  }
}

export type AgentClaims = AgentTokenClaims;
export const activeIntentStates = ACTIVE_INTENT_STATES;
