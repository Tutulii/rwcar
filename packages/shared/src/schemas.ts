import { z } from 'zod';

export const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');
export const HashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid bytes32 hash');
export const UintStringSchema = z.string().regex(/^\d+$/, 'Expected an unsigned integer string');

export const RepoStatusSchema = z.enum([
  'OPEN',
  'ACTIVE',
  'REPAID',
  'CANCELLED',
  'EXPIRED',
  'DEFAULTED',
]);

export const BlockingReasonSchema = z.enum([
  'WRONG_CHAIN',
  'CVI_MISSING',
  'CVI_INACTIVE',
  'CVI_INELIGIBLE',
  'CVA_NOT_ISSUED',
  'CVA_PAUSED',
  'ASSET_NOT_ALLOWED',
  'OFFER_NOT_OPEN',
  'OFFER_EXPIRED',
  'BUYER_NOT_PERMITTED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_ALLOWANCE',
  'NOT_AT_MATURITY',
  'REPAYMENT_WINDOW_CLOSED',
  'RETURN_BLOCKED',
  'COMPLIANCE_UNAVAILABLE',
  'CONTRACT_NOT_CONFIGURED',
  'VAULT_NOT_AUTHORIZED',
  'INVALID_FILL_AMOUNT',
  'BELOW_MINIMUM_FILL',
  'INVALID_DURATION',
  'INVALID_RATE',
  'INVALID_OFFER_EXPIRY',
  'POSITION_NOT_ACTIVE',
  'EARLY_REPURCHASE_DISABLED',
  'AUCTION_NOT_OPEN',
  'AUCTION_EXPIRED',
  'ORACLE_STALE',
  'ORACLE_STILL_LIVE',
  'ORACLE_FALLBACK_NOT_OPEN',
  'MARGIN_ACCOUNT_RESTRICTED',
  'LTV_LIMIT_EXCEEDED',
  'SLIPPAGE_EXCEEDED',
  'TRANSACTION_WOULD_REVERT',
]);

export const ComplianceResultSchema = z.object({
  wallet: AddressSchema,
  asset: AddressSchema,
  cviActive: z.boolean(),
  tier: z.number().int().min(0).max(99).nullable(),
  subTier: z.number().int().min(0).max(99).nullable(),
  apassStatus: z.number().int().nullable(),
  apassExpiresAt: z.string().datetime().nullable(),
  group: z.string().nullable(),
  subGroup: z.string().nullable(),
  countries: z.array(z.string()),
  verificationCode: z.number().int().nullable(),
  eligibilitySource: z.enum(['CLEANVERSE_API', 'ONCHAIN_POLICY_POOL']).nullable(),
  assetIssued: z.boolean(),
  assetPaused: z.boolean(),
  poolEligible: z.boolean().nullable(),
  checkedAt: z.string().datetime(),
});

export const AssetSchema = z.object({
  chainId: z.number().int(),
  address: AddressSchema,
  name: z.string().min(1).max(128),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(18),
  cleanverseRequestId: z.string().min(1),
  cleanverseStatus: z.literal('ISSUED'),
  paused: z.boolean(),
  enabled: z.boolean(),
  evidenceHash: HashSchema.nullable(),
  valuationHash: HashSchema.nullable(),
});

export const CreatePreflightSchema = z.object({
  seller: AddressSchema,
  asset: AddressSchema,
  permittedBuyer: AddressSchema.nullable().default(null),
  collateralAmount: UintStringSchema,
  principalAmount: UintStringSchema,
  annualRateBps: z.number().int().min(0).max(100_000),
  durationSeconds: z.number().int().positive(),
  offerExpiry: z.number().int().positive(),
  valuationHash: HashSchema,
});

export const RepoActionPreflightSchema = z.object({
  actor: AddressSchema,
  repoId: UintStringSchema,
});

export const PreflightResultSchema = z.object({
  eligible: z.boolean(),
  blockingReasons: z.array(BlockingReasonSchema),
  compliance: z.array(ComplianceResultSchema),
  requiredApprovals: z.array(z.object({
    token: AddressSchema,
    spender: AddressSchema,
    amount: UintStringSchema,
  })),
  economics: z.object({
    principal: UintStringSchema,
    openingFee: UintStringSchema,
    sellerProceeds: UintStringSchema,
    interest: UintStringSchema,
    repurchaseAmount: UintStringSchema,
  }).nullable(),
  correlationId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  correlationId: z.string().uuid(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ComplianceResult = z.infer<typeof ComplianceResultSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type CreatePreflightInput = z.infer<typeof CreatePreflightSchema>;
export type RepoActionPreflightInput = z.infer<typeof RepoActionPreflightSchema>;
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
