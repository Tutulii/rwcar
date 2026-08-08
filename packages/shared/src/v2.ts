import { z } from 'zod';
import { AddressSchema, BlockingReasonSchema, ComplianceResultSchema, UintStringSchema } from './schemas.js';

export const ProtocolModuleSchema = z.enum([
  'REPO_MARKET',
  'COLLATERAL_VAULT',
  'SETTLEMENT_ESCROW',
  'VALUATION_ORACLE',
  'RISK_MANAGER',
  'DUTCH_AUCTION',
  'MARGIN_ENGINE',
]);

export const V2OfferStatusSchema = z.enum(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']);
export const V2PositionStatusSchema = z.enum([
  'ACTIVE', 'REPAID', 'AUCTION', 'LIQUIDATED', 'AUCTION_FAILED', 'COLLATERAL_CLAIMED',
]);
export const VaultBucketSchema = z.enum([
  'AVAILABLE', 'OFFER_RESERVED', 'POSITION_LOCKED', 'AUCTION_LOCKED', 'MARGIN_LOCKED',
]);
export const AuctionStatusSchema = z.enum(['OPEN', 'SETTLED', 'EXPIRED', 'COLLATERAL_CLAIMED', 'CANCELLED']);
export const MarginAccountStatusSchema = z.enum([
  'HEALTHY', 'MARGIN_CALL', 'LIQUIDATING', 'LIQUIDATED', 'AUCTION_FAILED', 'CLOSED',
]);

export const EarlyRepurchaseTermsSchema = z.object({
  enabled: z.boolean(),
  minimumHoldSeconds: z.number().int().nonnegative(),
  breakFeeBps: z.number().int().min(0).max(10_000),
});

export const CreateOfferV2Schema = z.object({
  seller: AddressSchema,
  asset: AddressSchema,
  permittedBuyer: AddressSchema.nullable().default(null),
  totalCollateral: UintStringSchema,
  targetPrincipal: UintStringSchema,
  minimumFill: UintStringSchema,
  annualRateBps: z.number().int().min(0).max(100_000),
  durationSeconds: z.number().int().positive(),
  offerExpiry: z.number().int().positive(),
  earlyRepurchaseEnabled: z.boolean(),
});

export const DepositV2Schema = z.object({
  actor: AddressSchema,
  asset: AddressSchema,
  amount: UintStringSchema,
});

export const WithdrawV2Schema = DepositV2Schema.extend({
  recipient: AddressSchema.optional(),
});

export const FillOfferV2Schema = z.object({
  actor: AddressSchema,
  offerId: UintStringSchema,
  principalAmount: UintStringSchema,
});

export const RepayPositionV2Schema = z.object({
  actor: AddressSchema,
  positionId: UintStringSchema,
  maxPayoff: UintStringSchema.optional(),
});

export const AuctionActionV2Schema = z.object({
  actor: AddressSchema,
  auctionId: UintStringSchema,
  maxPrice: UintStringSchema.optional(),
});

export const SettlementClaimV2Schema = z.object({
  actor: AddressSchema,
  escrowAddress: AddressSchema,
  claimId: UintStringSchema,
  amount: UintStringSchema,
  recipient: AddressSchema.optional(),
});

export const MarginActionV2Schema = z.object({
  actor: AddressSchema,
  action: z.enum([
    'DEPOSIT', 'DEPOSIT_COLLATERAL', 'WITHDRAW', 'WITHDRAW_AVAILABLE',
    'OPEN_ACCOUNT', 'ADD_COLLATERAL', 'WITHDRAW_EXCESS', 'FUND_ACCOUNT', 'CLOSE_FUNDING',
    'REPAY', 'REPAY_EXPOSURE', 'DECLARE_PAYMENT_DEFAULT',
    'OPEN_MARGIN_CALL', 'CURE', 'CURE_MARGIN_CALL', 'LIQUIDATE', 'START_LIQUIDATION',
    'BUY_AUCTION', 'FINALIZE_FAILED_AUCTION', 'START_IN_KIND_ORACLE_FALLBACK',
    'MATERIALIZE_LIQUIDATION_CLAIM', 'CLAIM_FAILED_COLLATERAL', 'CLOSE_ACCOUNT',
  ]),
  accountId: UintStringSchema.optional(),
  exposureId: UintStringSchema.optional(),
  auctionId: UintStringSchema.optional(),
  asset: AddressSchema.optional(),
  amount: UintStringSchema.optional(),
  valuationId: UintStringSchema.optional(),
  recipient: AddressSchema.optional(),
  fundingTarget: UintStringSchema.optional(),
  minimumFunding: UintStringSchema.optional(),
  maxAnnualRateBps: z.number().int().min(0).max(100_000).optional(),
  fundingExpiry: z.number().int().positive().optional(),
  permittedLender: AddressSchema.optional(),
  annualRateBps: z.number().int().min(0).max(100_000).optional(),
  durationSeconds: z.number().int().positive().optional(),
  maxFee: UintStringSchema.optional(),
  maxFaceDebt: UintStringSchema.optional(),
  maxPrice: UintStringSchema.optional(),
  useEscrow: z.boolean().optional(),
});

export const OfferActionV2Schema = z.object({
  actor: AddressSchema,
  offerId: UintStringSchema,
});

export const PositionLifecycleActionV2Schema = z.object({
  actor: AddressSchema,
  positionId: UintStringSchema,
  valuationId: UintStringSchema.optional(),
  recipient: AddressSchema.optional(),
});

export const TransferEdgeSchema = z.object({
  token: AddressSchema,
  from: AddressSchema,
  to: AddressSchema,
  amount: UintStringSchema,
  purpose: z.enum([
    'COLLATERAL_DEPOSIT', 'COLLATERAL_RELEASE', 'PRINCIPAL', 'PROTOCOL_FEE',
    'REPAYMENT', 'AUCTION_PURCHASE', 'AUCTION_DELIVERY', 'ESCROW_CLAIM', 'MARGIN_COLLATERAL',
  ]),
  policyPool: AddressSchema,
});

export const TransferGraphCheckSchema = z.object({
  edge: TransferEdgeSchema,
  fromCompliance: ComplianceResultSchema,
  toCompliance: ComplianceResultSchema,
  eligible: z.boolean(),
  blockingReasons: z.array(BlockingReasonSchema),
});

export const RequiredApprovalV2Schema = z.object({
  token: AddressSchema,
  spender: AddressSchema,
  amount: UintStringSchema,
});

export const WalletTransactionV2Schema = z.object({
  to: AddressSchema,
  data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  value: UintStringSchema.default('0'),
  description: z.string().min(1),
});

export const QuoteV2Schema = z.object({
  kind: z.enum(['DEPOSIT', 'WITHDRAW', 'CREATE_OFFER', 'FILL', 'REPAY', 'AUCTION', 'CLAIM', 'MARGIN']),
  quoteId: z.string().uuid(),
  chainBlock: UintStringSchema,
  chainTimestamp: UintStringSchema,
  expiresAt: z.string().datetime(),
  amounts: z.record(z.string(), UintStringSchema),
  projectedState: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const PreflightResultV2Schema = z.object({
  eligible: z.boolean(),
  blockingReasons: z.array(BlockingReasonSchema),
  compliance: z.array(ComplianceResultSchema),
  transferGraph: z.array(TransferGraphCheckSchema),
  requiredApprovals: z.array(RequiredApprovalV2Schema),
  transactions: z.array(WalletTransactionV2Schema),
  quote: QuoteV2Schema,
  correlationId: z.string().uuid(),
});

export type ProtocolModule = z.infer<typeof ProtocolModuleSchema>;
export type V2OfferStatus = z.infer<typeof V2OfferStatusSchema>;
export type V2PositionStatus = z.infer<typeof V2PositionStatusSchema>;
export type CreateOfferV2Input = z.infer<typeof CreateOfferV2Schema>;
export type DepositV2Input = z.infer<typeof DepositV2Schema>;
export type WithdrawV2Input = z.infer<typeof WithdrawV2Schema>;
export type FillOfferV2Input = z.infer<typeof FillOfferV2Schema>;
export type RepayPositionV2Input = z.infer<typeof RepayPositionV2Schema>;
export type AuctionActionV2Input = z.infer<typeof AuctionActionV2Schema>;
export type SettlementClaimV2Input = z.infer<typeof SettlementClaimV2Schema>;
export type MarginActionV2Input = z.infer<typeof MarginActionV2Schema>;
export type OfferActionV2Input = z.infer<typeof OfferActionV2Schema>;
export type PositionLifecycleActionV2Input = z.infer<typeof PositionLifecycleActionV2Schema>;
export type TransferEdge = z.infer<typeof TransferEdgeSchema>;
export type TransferGraphCheck = z.infer<typeof TransferGraphCheckSchema>;
export type PreflightResultV2 = z.infer<typeof PreflightResultV2Schema>;
