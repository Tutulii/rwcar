CREATE TYPE "v2_offer_status" AS ENUM ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "v2_position_status" AS ENUM ('ACTIVE', 'REPAID', 'AUCTION', 'LIQUIDATED', 'AUCTION_FAILED', 'COLLATERAL_CLAIMED');
CREATE TYPE "vault_bucket" AS ENUM ('AVAILABLE', 'OFFER_RESERVED', 'POSITION_LOCKED', 'AUCTION_LOCKED', 'MARGIN_LOCKED');
CREATE TYPE "auction_status" AS ENUM ('OPEN', 'SETTLED', 'EXPIRED', 'COLLATERAL_CLAIMED', 'CANCELLED');
CREATE TYPE "claim_status" AS ENUM ('PENDING', 'CLAIMED', 'CANCELLED');
CREATE TYPE "margin_account_status" AS ENUM ('HEALTHY', 'MARGIN_CALL', 'LIQUIDATING', 'LIQUIDATED', 'AUCTION_FAILED', 'CLOSED');
CREATE TYPE "automation_job_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY', 'DEAD', 'CANCELLED');

CREATE TABLE "protocol_deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" integer NOT NULL,
  "protocol_version" text NOT NULL,
  "module" text NOT NULL,
  "address" text NOT NULL,
  "deployment_block" bigint NOT NULL,
  "abi_hash" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "protocol_deployments_chain_address_uidx" ON "protocol_deployments" ("chain_id", "address");
CREATE INDEX "protocol_deployments_module_idx" ON "protocol_deployments" ("chain_id", "protocol_version", "module");

ALTER TABLE "chain_events" ADD COLUMN "deployment_id" uuid;
ALTER TABLE "chain_events" ADD COLUMN "module" text DEFAULT 'REPO_MARKET' NOT NULL;
ALTER TABLE "chain_events" ADD COLUMN "protocol_version" text DEFAULT 'v1' NOT NULL;
ALTER TABLE "chain_events" ADD COLUMN "block_timestamp" timestamptz;
ALTER TABLE "chain_events" ADD COLUMN "finalized" boolean DEFAULT true NOT NULL;
ALTER TABLE "chain_events" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;
CREATE INDEX "chain_events_deployment_block_idx" ON "chain_events" ("deployment_id", "block_number");

CREATE TABLE "v2_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" integer NOT NULL, "market_address" text NOT NULL, "offer_id" numeric(78,0) NOT NULL,
  "seller" text NOT NULL, "permitted_buyer" text, "asset_address" text NOT NULL, "settlement_token" text NOT NULL,
  "total_collateral" numeric(78,0) NOT NULL, "remaining_collateral" numeric(78,0) NOT NULL,
  "target_principal" numeric(78,0) NOT NULL, "remaining_principal" numeric(78,0) NOT NULL,
  "minimum_fill" numeric(78,0) NOT NULL, "cumulative_fee" numeric(78,0) DEFAULT 0 NOT NULL,
  "annual_rate_bps" integer NOT NULL, "default_rate_bps" integer NOT NULL, "duration_seconds" integer NOT NULL,
  "offer_expiry" timestamptz NOT NULL, "grace_period_seconds" integer NOT NULL,
  "early_repurchase_enabled" boolean DEFAULT false NOT NULL, "minimum_hold_seconds" integer DEFAULT 0 NOT NULL,
  "break_fee_bps" integer DEFAULT 0 NOT NULL, "valuation_id" numeric(78,0), "valuation_hash" text,
  "status" "v2_offer_status" NOT NULL, "create_tx_hash" text NOT NULL, "last_tx_hash" text NOT NULL,
  "last_block_number" bigint NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL, "closed_at" timestamptz
);
CREATE UNIQUE INDEX "v2_offers_chain_market_offer_uidx" ON "v2_offers" ("chain_id", "market_address", "offer_id");
CREATE INDEX "v2_offers_market_status_expiry_idx" ON "v2_offers" ("chain_id", "market_address", "status", "offer_expiry");
CREATE INDEX "v2_offers_seller_idx" ON "v2_offers" ("seller");
CREATE INDEX "v2_offers_asset_idx" ON "v2_offers" ("asset_address");

CREATE TABLE "v2_positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" integer NOT NULL, "market_address" text NOT NULL, "position_id" numeric(78,0) NOT NULL,
  "offer_id" numeric(78,0) NOT NULL, "auction_id" numeric(78,0), "seller" text NOT NULL, "buyer" text NOT NULL,
  "asset_address" text NOT NULL, "settlement_token" text NOT NULL, "principal" numeric(78,0) NOT NULL,
  "collateral" numeric(78,0) NOT NULL, "opening_fee" numeric(78,0) DEFAULT 0 NOT NULL,
  "annual_rate_bps" integer NOT NULL, "default_rate_bps" integer NOT NULL,
  "liquidation_fee_bps" integer NOT NULL, "auction_start_bps" integer NOT NULL, "auction_floor_bps" integer NOT NULL,
  "auction_duration_seconds" integer NOT NULL, "max_oracle_age_seconds" integer NOT NULL,
  "stale_oracle_fallback_delay_seconds" integer NOT NULL, "opening_valuation_digest" text NOT NULL, "accepted_at" timestamptz NOT NULL,
  "maturity_at" timestamptz NOT NULL, "repayment_deadline" timestamptz NOT NULL,
  "debt_frozen_at" timestamptz, "frozen_debt" numeric(78,0), "default_valuation_digest" text, "payoff_amount" numeric(78,0),
  "status" "v2_position_status" NOT NULL, "last_tx_hash" text NOT NULL, "last_block_number" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "closed_at" timestamptz
);
CREATE UNIQUE INDEX "v2_positions_chain_market_position_uidx" ON "v2_positions" ("chain_id", "market_address", "position_id");
CREATE INDEX "v2_positions_offer_idx" ON "v2_positions" ("chain_id", "market_address", "offer_id");
CREATE INDEX "v2_positions_status_deadline_idx" ON "v2_positions" ("status", "repayment_deadline");
CREATE INDEX "v2_positions_seller_idx" ON "v2_positions" ("seller");
CREATE INDEX "v2_positions_buyer_idx" ON "v2_positions" ("buyer");

CREATE TABLE "vault_balances" (
  "chain_id" integer NOT NULL, "vault_address" text NOT NULL, "account" text NOT NULL,
  "asset_address" text NOT NULL, "bucket" "vault_bucket" NOT NULL, "amount" numeric(78,0) DEFAULT 0 NOT NULL,
  "last_block_number" bigint NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "vault_balances_pk" PRIMARY KEY ("chain_id", "vault_address", "account", "asset_address", "bucket")
);
CREATE INDEX "vault_balances_account_idx" ON "vault_balances" ("account", "asset_address");

CREATE TABLE "vault_ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "vault_address" text NOT NULL, "account" text NOT NULL, "asset_address" text NOT NULL,
  "bucket" "vault_bucket" NOT NULL, "delta" numeric(78,0) NOT NULL, "balance_after" numeric(78,0) NOT NULL,
  "reference_type" text NOT NULL, "reference_id" numeric(78,0), "reason" text NOT NULL,
  "tx_hash" text NOT NULL, "log_index" integer NOT NULL, "block_number" bigint NOT NULL, "occurred_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "vault_ledger_event_uidx" ON "vault_ledger_entries" ("chain_id", "tx_hash", "log_index", "bucket");
CREATE INDEX "vault_ledger_account_idx" ON "vault_ledger_entries" ("account", "asset_address", "block_number");
CREATE INDEX "vault_ledger_reference_idx" ON "vault_ledger_entries" ("reference_type", "reference_id");

CREATE TABLE "oracle_valuations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "oracle_address" text NOT NULL, "valuation_id" numeric(78,0) NOT NULL, "asset_address" text NOT NULL,
  "value_minor" numeric(78,0) NOT NULL, "price_e18" numeric(78,0) NOT NULL, "currency" text NOT NULL,
  "settlement_token" text NOT NULL, "nonce" numeric(78,0) NOT NULL,
  "valid_from" timestamptz NOT NULL, "observed_at" timestamptz NOT NULL, "valid_until" timestamptz NOT NULL, "evidence_hash" text NOT NULL,
  "digest" text NOT NULL, "signatures" jsonb DEFAULT '[]'::jsonb NOT NULL, "invalidated" boolean DEFAULT false NOT NULL,
  "tx_hash" text NOT NULL, "block_number" bigint NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "oracle_valuations_chain_oracle_id_uidx" ON "oracle_valuations" ("chain_id", "oracle_address", "valuation_id");
CREATE UNIQUE INDEX "oracle_valuations_chain_asset_nonce_uidx" ON "oracle_valuations" ("chain_id", "asset_address", "nonce");
CREATE INDEX "oracle_valuations_asset_validity_idx" ON "oracle_valuations" ("asset_address", "valid_until");

CREATE TABLE "risk_configurations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "risk_manager_address" text NOT NULL, "asset_address" text NOT NULL, "config_version" numeric(78,0) NOT NULL,
  "initial_ltv_bps" integer NOT NULL, "maintenance_ltv_bps" integer NOT NULL, "liquidation_ltv_bps" integer NOT NULL,
  "auction_start_bps" integer NOT NULL, "auction_floor_bps" integer NOT NULL, "liquidation_fee_bps" integer NOT NULL,
  "early_min_hold_bps" integer NOT NULL, "early_break_fee_bps" integer NOT NULL, "default_spread_bps" integer NOT NULL,
  "max_default_rate_bps" integer NOT NULL, "oracle_max_age_seconds" integer NOT NULL,
  "auction_duration_seconds" integer NOT NULL, "margin_call_seconds" integer NOT NULL,
  "stale_oracle_fallback_delay_seconds" integer NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL, "tx_hash" text NOT NULL, "block_number" bigint NOT NULL, "activated_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "risk_config_chain_manager_asset_version_uidx" ON "risk_configurations" ("chain_id", "risk_manager_address", "asset_address", "config_version");
CREATE INDEX "risk_config_asset_active_idx" ON "risk_configurations" ("asset_address", "enabled");

CREATE TABLE "auctions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "auction_address" text NOT NULL, "auction_id" numeric(78,0) NOT NULL, "market_address" text NOT NULL,
  "position_id" numeric(78,0), "margin_account_id" numeric(78,0), "seller" text NOT NULL, "lender" text,
  "asset_address" text NOT NULL, "settlement_token" text NOT NULL, "collateral_amount" numeric(78,0) NOT NULL,
  "frozen_debt" numeric(78,0) NOT NULL, "liquidation_fee_bps" integer NOT NULL,
  "valuation_id" numeric(78,0), "valuation_digest" text,
  "start_price" numeric(78,0) NOT NULL, "floor_price" numeric(78,0) NOT NULL,
  "starts_at" timestamptz NOT NULL, "ends_at" timestamptz NOT NULL, "status" "auction_status" NOT NULL,
  "buyer" text, "clearing_price" numeric(78,0), "last_tx_hash" text NOT NULL, "last_block_number" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "closed_at" timestamptz
);
CREATE UNIQUE INDEX "auctions_chain_contract_id_uidx" ON "auctions" ("chain_id", "auction_address", "auction_id");
CREATE INDEX "auctions_status_end_idx" ON "auctions" ("status", "ends_at");
CREATE INDEX "auctions_position_idx" ON "auctions" ("chain_id", "market_address", "position_id");

CREATE TABLE "auction_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "auction_address" text NOT NULL, "auction_id" numeric(78,0) NOT NULL, "buyer" text NOT NULL,
  "gross_proceeds" numeric(78,0) NOT NULL, "lender_proceeds" numeric(78,0) NOT NULL,
  "protocol_cost" numeric(78,0) NOT NULL, "seller_surplus" numeric(78,0) NOT NULL,
  "lender_shortfall" numeric(78,0) NOT NULL, "tx_hash" text NOT NULL, "block_number" bigint NOT NULL, "settled_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "auction_settlements_chain_auction_uidx" ON "auction_settlements" ("chain_id", "auction_address", "auction_id");

CREATE TABLE "settlement_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "escrow_address" text NOT NULL, "claim_id" numeric(78,0) NOT NULL, "beneficiary" text NOT NULL,
  "token_address" text NOT NULL, "amount" numeric(78,0) NOT NULL, "remaining" numeric(78,0) NOT NULL, "source_type" text NOT NULL,
  "source_id" numeric(78,0), "claim_reference" text NOT NULL, "status" "claim_status" NOT NULL, "create_tx_hash" text NOT NULL,
  "claim_tx_hash" text, "last_block_number" bigint NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "claimed_at" timestamptz
);
CREATE UNIQUE INDEX "settlement_claims_chain_escrow_id_uidx" ON "settlement_claims" ("chain_id", "escrow_address", "claim_id");
CREATE INDEX "settlement_claims_beneficiary_status_idx" ON "settlement_claims" ("beneficiary", "status");

CREATE TABLE "v2_compliance_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "correlation_id" uuid NOT NULL,
  "chain_id" integer NOT NULL, "action" text NOT NULL, "role" text NOT NULL, "policy_pool" text NOT NULL,
  "token_address" text NOT NULL, "wallet" text NOT NULL, "transfer_from" text NOT NULL, "transfer_to" text NOT NULL,
  "transfer_amount" numeric(78,0) NOT NULL, "resource_type" text NOT NULL, "resource_id" text,
  "decision" text NOT NULL, "verification_code" integer, "cvi_active" boolean NOT NULL,
  "asset_issued" boolean NOT NULL, "asset_paused" boolean NOT NULL, "pool_eligible" boolean,
  "rule_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL, "raw_result" jsonb, "checked_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "v2_compliance_correlation_idx" ON "v2_compliance_decisions" ("correlation_id");
CREATE INDEX "v2_compliance_resource_idx" ON "v2_compliance_decisions" ("resource_type", "resource_id");
CREATE INDEX "v2_compliance_wallet_token_idx" ON "v2_compliance_decisions" ("wallet", "token_address", "checked_at");

CREATE TABLE "margin_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "margin_engine_address" text NOT NULL, "account_id" numeric(78,0) NOT NULL, "owner" text NOT NULL,
  "asset_address" text NOT NULL, "settlement_token" text NOT NULL, "rules_hash" text NOT NULL,
  "collateral_amount" numeric(78,0) DEFAULT 0 NOT NULL, "total_funded" numeric(78,0) DEFAULT 0 NOT NULL,
  "total_debt" numeric(78,0) DEFAULT 0 NOT NULL, "fee_charged" numeric(78,0) DEFAULT 0 NOT NULL,
  "frozen_debt" numeric(78,0) DEFAULT 0 NOT NULL, "liquidation_proceeds" numeric(78,0) DEFAULT 0 NOT NULL,
  "remaining_proceeds" numeric(78,0) DEFAULT 0 NOT NULL, "remaining_collateral" numeric(78,0) DEFAULT 0 NOT NULL,
  "margin_call_deadline" timestamptz, "default_declared_at" timestamptz,
  "max_oracle_age_seconds" integer DEFAULT 0 NOT NULL, "auction_duration_seconds" integer DEFAULT 0 NOT NULL,
  "margin_call_period_seconds" integer DEFAULT 0 NOT NULL, "stale_oracle_fallback_delay_seconds" integer DEFAULT 0 NOT NULL,
  "active_exposure_count" integer DEFAULT 0 NOT NULL, "unclaimed_exposure_count" integer DEFAULT 0 NOT NULL,
  "initial_ltv_bps" integer DEFAULT 0 NOT NULL, "maintenance_ltv_bps" integer DEFAULT 0 NOT NULL,
  "liquidation_ltv_bps" integer DEFAULT 0 NOT NULL, "auction_start_bps" integer DEFAULT 0 NOT NULL,
  "auction_floor_bps" integer DEFAULT 0 NOT NULL, "liquidation_fee_bps" integer DEFAULT 0 NOT NULL,
  "payment_default_declared" boolean DEFAULT false NOT NULL, "in_kind_closeout" boolean DEFAULT false NOT NULL,
  "auction_id" numeric(78,0), "claim_pool_id" numeric(78,0), "closeout_valuation_digest" text,
  "valuation_id" numeric(78,0), "collateral_value" numeric(78,0), "ltv_bps" integer,
  "status" "margin_account_status" NOT NULL, "last_tx_hash" text NOT NULL, "last_block_number" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "closed_at" timestamptz
);
CREATE UNIQUE INDEX "margin_accounts_chain_engine_id_uidx" ON "margin_accounts" ("chain_id", "margin_engine_address", "account_id");
CREATE INDEX "margin_accounts_owner_idx" ON "margin_accounts" ("owner");
CREATE INDEX "margin_accounts_status_idx" ON "margin_accounts" ("status");

CREATE TABLE "margin_exposures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "margin_engine_address" text NOT NULL, "exposure_id" numeric(78,0) NOT NULL, "account_id" numeric(78,0) NOT NULL,
  "lender" text NOT NULL, "principal" numeric(78,0) NOT NULL, "accrued_debt" numeric(78,0) NOT NULL,
  "opening_fee" numeric(78,0) DEFAULT 0 NOT NULL, "annual_rate_bps" integer NOT NULL,
  "opened_at" timestamptz NOT NULL, "maturity_at" timestamptz NOT NULL,
  "settlement_claim_id" numeric(78,0), "liquidation_claim_amount" numeric(78,0), "status" text NOT NULL,
  "last_tx_hash" text NOT NULL, "last_block_number" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "margin_exposures_chain_engine_id_uidx" ON "margin_exposures" ("chain_id", "margin_engine_address", "exposure_id");
CREATE INDEX "margin_exposures_account_idx" ON "margin_exposures" ("chain_id", "margin_engine_address", "account_id");
CREATE INDEX "margin_exposures_lender_idx" ON "margin_exposures" ("lender");

CREATE TABLE "margin_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "margin_engine_address" text NOT NULL, "call_id" numeric(78,0) NOT NULL, "account_id" numeric(78,0) NOT NULL,
  "opened_ltv_bps" integer NOT NULL, "cure_deadline" timestamptz NOT NULL, "status" text NOT NULL,
  "opened_tx_hash" text NOT NULL, "resolved_tx_hash" text, "last_block_number" bigint NOT NULL,
  "opened_at" timestamptz NOT NULL, "resolved_at" timestamptz
);
CREATE UNIQUE INDEX "margin_calls_chain_engine_id_uidx" ON "margin_calls" ("chain_id", "margin_engine_address", "call_id");
CREATE INDEX "margin_calls_status_deadline_idx" ON "margin_calls" ("status", "cure_deadline");

CREATE TABLE "margin_liquidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "margin_engine_address" text NOT NULL, "liquidation_id" numeric(78,0) NOT NULL, "account_id" numeric(78,0) NOT NULL,
  "auction_id" numeric(78,0) NOT NULL, "frozen_debt" numeric(78,0) NOT NULL, "collateral_amount" numeric(78,0) NOT NULL,
  "total_proceeds" numeric(78,0), "proceeds_per_debt_ray" numeric(78,0), "status" text NOT NULL,
  "start_tx_hash" text NOT NULL, "settle_tx_hash" text, "last_block_number" bigint NOT NULL,
  "started_at" timestamptz NOT NULL, "settled_at" timestamptz
);
CREATE UNIQUE INDEX "margin_liquidations_chain_engine_id_uidx" ON "margin_liquidations" ("chain_id", "margin_engine_address", "liquidation_id");
CREATE INDEX "margin_liquidations_account_idx" ON "margin_liquidations" ("chain_id", "margin_engine_address", "account_id");

CREATE TABLE "automation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "chain_id" integer NOT NULL,
  "contract_address" text NOT NULL, "action" text NOT NULL, "resource_type" text NOT NULL,
  "resource_id" numeric(78,0) NOT NULL, "scheduled_for" timestamptz NOT NULL,
  "status" "automation_job_status" DEFAULT 'PENDING' NOT NULL, "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 12 NOT NULL, "next_attempt_at" timestamptz NOT NULL,
  "locked_by" text, "locked_at" timestamptz, "tx_hash" text, "last_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL, "completed_at" timestamptz
);
CREATE UNIQUE INDEX "automation_jobs_resource_action_uidx" ON "automation_jobs" ("chain_id", "contract_address", "action", "resource_type", "resource_id");
CREATE INDEX "automation_jobs_due_idx" ON "automation_jobs" ("status", "next_attempt_at");
