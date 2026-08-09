import { z } from 'zod';
import {
  AddressSchema,
  BlockingReasonSchema,
  UintStringSchema,
} from './schemas.js';
import {
  AuctionActionV2Schema,
  CreateOfferV2Schema,
  FillOfferV2Schema,
  MarginActionV2Schema,
  OfferActionV2Schema,
  PositionLifecycleActionV2Schema,
  RepayPositionV2Schema,
} from './v2.js';

export const AgentStatusSchema = z.enum([
  'PENDING_WALLET',
  'PENDING_CVI',
  'PENDING_MANDATE',
  'ACTIVE',
  'PAUSED',
  'REVOKED',
]);

export const AgentCredentialStatusSchema = z.enum(['ACTIVE', 'ROTATING', 'REVOKED', 'EXPIRED']);

export const AgentIntentStateSchema = z.enum([
  'PREPARED',
  'APPROVAL_REQUIRED',
  'APPROVED',
  'QUEUED',
  'SIGNING',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXING',
  'COMPLETED',
  'DENIED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'REVERTED',
  'FAILED',
  'FAILED_WITH_ALLOWANCE',
]);

export const AgentPolicyDecisionSchema = z.enum(['AUTO_APPROVED', 'HUMAN_REQUIRED', 'DENIED']);

export const AgentExecutionModeSchema = z.enum(['AUTONOMOUS', 'SUPERVISED']);

export const AgentActionSchema = z.enum([
  'VAULT_DEPOSIT',
  'VAULT_WITHDRAW',
  'CREATE_OFFER',
  'FILL_OFFER',
  'CANCEL_OFFER',
  'FINALIZE_OFFER_EXPIRY',
  'REPAY_POSITION',
  'START_AUCTION',
  'CLAIM_COLLATERAL',
  'CLAIM_ORACLE_FALLBACK',
  'BUY_AUCTION',
  'FINALIZE_FAILED_AUCTION',
  'CLAIM_SETTLEMENT',
  'MARGIN_ACTION',
]);

export const AgentScopeSchema = z.enum([
  'protocol:read',
  'vault:write',
  'offers:write',
  'positions:write',
  'auctions:write',
  'claims:write',
  'margin:write',
  'intents:execute',
]);

export const AllAgentScopes = AgentScopeSchema.options;

export const CreateAgentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  adminWallet: AddressSchema,
});

export const BindAgentWalletSchema = z.object({
  walletAddress: AddressSchema,
  privyWalletId: z.string().trim().min(3).max(200),
  signerId: z.string().trim().min(3).max(200),
  policyId: z.string().trim().min(3).max(200),
  signedAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});

export const AgentMandateConstraintsSchema = z.object({
  // Existing mandates predate executionMode. Parsing them as SUPERVISED
  // preserves their signed authority exactly; autonomy always requires a new
  // administrator signature over an explicit AUTONOMOUS constraint.
  executionMode: AgentExecutionModeSchema.default('SUPERVISED'),
  allowedActions: z.array(AgentActionSchema).min(1),
  allowedAssets: z.array(AddressSchema).min(1),
  maxPerTransaction: UintStringSchema.refine((value) => BigInt(value) > 0n, 'Must be greater than zero'),
  maxDailyNotional: UintStringSchema.refine((value) => BigInt(value) > 0n, 'Must be greater than zero'),
  autoExecuteUpTo: UintStringSchema,
  minAnnualRateBps: z.number().int().min(0).max(100_000),
  maxAnnualRateBps: z.number().int().min(0).max(100_000),
  minDurationSeconds: z.number().int().positive(),
  maxDurationSeconds: z.number().int().positive(),
  allowedCounterparties: z.array(AddressSchema).max(100).default([]),
  allowedRecipients: z.array(AddressSchema).max(20).default([]),
  startsAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  nonce: UintStringSchema,
}).superRefine((value, context) => {
  if (value.maxAnnualRateBps < value.minAnnualRateBps) {
    context.addIssue({ code: 'custom', path: ['maxAnnualRateBps'], message: 'Must be at least minAnnualRateBps' });
  }
  if (value.maxDurationSeconds < value.minDurationSeconds) {
    context.addIssue({ code: 'custom', path: ['maxDurationSeconds'], message: 'Must be at least minDurationSeconds' });
  }
  if (value.expiresAt <= value.startsAt) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Must be after startsAt' });
  }
  if (BigInt(value.autoExecuteUpTo) > BigInt(value.maxPerTransaction)) {
    context.addIssue({ code: 'custom', path: ['autoExecuteUpTo'], message: 'Cannot exceed maxPerTransaction' });
  }
});

export const CreateAgentMandateSchema = z.object({
  wallet: AddressSchema,
  manifestHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  constraints: AgentMandateConstraintsSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});

export const CreateAgentCredentialSchema = z.object({
  label: z.string().trim().min(2).max(80),
  scopes: z.array(AgentScopeSchema).min(1),
  expiresAt: z.string().datetime().optional(),
});

export const AgentIdempotencySchema = z.object({
  idempotencyKey: z.string().uuid(),
});

export const AgentVaultActionSchema = AgentIdempotencySchema.extend({
  action: z.enum(['DEPOSIT', 'WITHDRAW']),
  asset: AddressSchema,
  amount: UintStringSchema,
  recipient: AddressSchema.optional(),
});

export const AgentCreateOfferSchema = AgentIdempotencySchema.extend(CreateOfferV2Schema.omit({ seller: true }).shape);

export const AgentOfferActionSchema = AgentIdempotencySchema.extend({
  action: z.enum(['FILL', 'CANCEL', 'FINALIZE_EXPIRY']),
  offerId: UintStringSchema,
  principalAmount: UintStringSchema.optional(),
});

export const AgentPositionActionSchema = AgentIdempotencySchema.extend({
  action: z.enum(['REPAY', 'START_AUCTION', 'CLAIM_COLLATERAL', 'CLAIM_ORACLE_FALLBACK']),
  positionId: UintStringSchema,
  maxPayoff: UintStringSchema.optional(),
  valuationId: UintStringSchema.optional().describe('Deprecated compatibility field. Omit it; RWCAR resolves the current authorized signed valuation.'),
  recipient: AddressSchema.optional(),
});

export const AgentAuctionActionSchema = AgentIdempotencySchema.extend({
  action: z.enum(['BUY', 'FINALIZE_FAILED']),
  auctionId: UintStringSchema,
  maxPrice: UintStringSchema.optional(),
});

export const AgentClaimSchema = AgentIdempotencySchema.extend({
  claimId: UintStringSchema,
  escrowAddress: AddressSchema.optional().describe('Optional when claimId uniquely identifies one indexed claim for the agent wallet.'),
  amount: UintStringSchema.optional().describe('Defaults to the full indexed claimable balance.'),
  recipient: AddressSchema.optional().describe('Defaults to the bound agent wallet.'),
});

export const AgentMarginActionSchema = AgentIdempotencySchema.extend(MarginActionV2Schema.omit({ actor: true }).shape);

export const ExecuteAgentIntentSchema = z.object({
  intentId: z.string().uuid(),
  expectedIntentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export const AgentIntentApprovalSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});

export const AgentEligibilityQuerySchema = z.object({
  asset: AddressSchema,
});

export const AgentIntentPreviewSchema = z.object({
  intentId: z.string().uuid(),
  intentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  state: AgentIntentStateSchema,
  policyDecision: AgentPolicyDecisionSchema,
  approvalRequired: z.boolean(),
  correlationId: z.string().uuid().nullable(),
  blockingReasons: z.array(z.union([BlockingReasonSchema, z.string()])),
  blockingDetails: z.array(z.object({
    code: z.string(),
    message: z.string(),
    recovery: z.string(),
  })),
  resolvedByTransactions: z.array(z.string()),
  nextActions: z.array(z.object({
    action: z.string(),
    description: z.string(),
  }).passthrough()),
  quote: z.record(z.string(), z.unknown()).nullable(),
  projectedState: z.record(z.string(), z.unknown()).nullable(),
  freshness: z.object({
    chainBlock: UintStringSchema.nullable(),
    chainTimestamp: UintStringSchema.nullable(),
    quoteExpiresAt: z.string().datetime().nullable(),
    intentUpdatedAt: z.string().datetime(),
  }),
  approvalHandoff: z.object({
    signerRole: z.literal('INSTITUTION_ADMIN'),
    challengeEndpoint: z.string(),
    submissionEndpoint: z.string(),
    intentId: z.string().uuid(),
    intentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  }).nullable(),
  transactionSummary: z.array(z.object({
    to: AddressSchema,
    selector: z.string().regex(/^0x[a-fA-F0-9]{8}$/),
    value: UintStringSchema,
    description: z.string(),
  })),
  expiresAt: z.string().datetime(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentScope = z.infer<typeof AgentScopeSchema>;
export type AgentIntentState = z.infer<typeof AgentIntentStateSchema>;
export type AgentPolicyDecision = z.infer<typeof AgentPolicyDecisionSchema>;
export type AgentExecutionMode = z.infer<typeof AgentExecutionModeSchema>;
export type AgentMandateConstraints = z.infer<typeof AgentMandateConstraintsSchema>;
export type AgentVaultAction = z.infer<typeof AgentVaultActionSchema>;
export type AgentCreateOffer = z.infer<typeof AgentCreateOfferSchema>;
export type AgentOfferAction = z.infer<typeof AgentOfferActionSchema>;
export type AgentPositionAction = z.infer<typeof AgentPositionActionSchema>;
export type AgentAuctionAction = z.infer<typeof AgentAuctionActionSchema>;
export type AgentClaim = z.infer<typeof AgentClaimSchema>;
export type AgentMarginAction = z.infer<typeof AgentMarginActionSchema>;

// Compile-time compatibility guards: the agent schemas intentionally narrow the
// existing V2 preflight shapes rather than inventing another transaction API.
void FillOfferV2Schema;
void RepayPositionV2Schema;
void AuctionActionV2Schema;
void OfferActionV2Schema;
void PositionLifecycleActionV2Schema;
