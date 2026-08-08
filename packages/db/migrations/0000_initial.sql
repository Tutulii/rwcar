CREATE TYPE "repo_status" AS ENUM ('OPEN', 'ACTIVE', 'REPAID', 'CANCELLED', 'EXPIRED', 'DEFAULTED');

CREATE TABLE "assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" integer NOT NULL,
  "address" text NOT NULL,
  "name" text NOT NULL,
  "symbol" text NOT NULL,
  "decimals" integer NOT NULL,
  "cleanverse_request_id" text NOT NULL,
  "cleanverse_status" text NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "evidence_hash" text,
  "valuation_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "assets_chain_address_uidx" ON "assets" ("chain_id", "address");
CREATE INDEX "assets_enabled_idx" ON "assets" ("enabled");

CREATE TABLE "repos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id" integer NOT NULL,
  "market_address" text NOT NULL,
  "repo_id" numeric(78,0) NOT NULL,
  "seller" text NOT NULL,
  "buyer" text,
  "permitted_buyer" text,
  "asset_address" text NOT NULL,
  "collateral_amount" numeric(78,0) NOT NULL,
  "principal_amount" numeric(78,0) NOT NULL,
  "opening_fee" numeric(78,0),
  "repurchase_amount" numeric(78,0),
  "annual_rate_bps" integer NOT NULL,
  "duration_seconds" integer NOT NULL,
  "offer_expiry" timestamptz NOT NULL,
  "opened_at" timestamptz,
  "maturity_at" timestamptz,
  "grace_ends_at" timestamptz,
  "closed_at" timestamptz,
  "valuation_hash" text NOT NULL,
  "status" "repo_status" NOT NULL,
  "create_tx_hash" text NOT NULL,
  "last_tx_hash" text NOT NULL,
  "last_block_number" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "repos_chain_market_repo_uidx" ON "repos" ("chain_id", "market_address", "repo_id");
CREATE INDEX "repos_status_idx" ON "repos" ("status");
CREATE INDEX "repos_seller_idx" ON "repos" ("seller");
CREATE INDEX "repos_buyer_idx" ON "repos" ("buyer");
CREATE INDEX "repos_asset_idx" ON "repos" ("asset_address");

CREATE TABLE "chain_events" (
  "chain_id" integer NOT NULL,
  "tx_hash" text NOT NULL,
  "log_index" integer NOT NULL,
  "block_number" bigint NOT NULL,
  "block_hash" text NOT NULL,
  "contract_address" text NOT NULL,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "observed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chain_events_pk" PRIMARY KEY ("chain_id", "tx_hash", "log_index")
);
CREATE INDEX "chain_events_block_idx" ON "chain_events" ("chain_id", "block_number");

CREATE TABLE "indexer_checkpoints" (
  "chain_id" integer NOT NULL,
  "consumer" text NOT NULL,
  "block_number" bigint NOT NULL,
  "block_hash" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "indexer_checkpoints_pk" PRIMARY KEY ("chain_id", "consumer")
);

CREATE TABLE "compliance_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "correlation_id" uuid NOT NULL,
  "wallet" text NOT NULL,
  "asset_address" text NOT NULL,
  "cvi_active" boolean NOT NULL,
  "tier" integer,
  "verification_code" integer,
  "asset_issued" boolean NOT NULL,
  "asset_paused" boolean NOT NULL,
  "pool_eligible" boolean,
  "raw_result" jsonb,
  "checked_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "compliance_wallet_asset_idx" ON "compliance_checks" ("wallet", "asset_address");
CREATE INDEX "compliance_correlation_idx" ON "compliance_checks" ("correlation_id");

CREATE TABLE "valuation_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "asset_address" text NOT NULL,
  "value_minor" numeric(78,0) NOT NULL,
  "currency" text NOT NULL,
  "source" text NOT NULL,
  "evidence_hash" text NOT NULL,
  "signer" text NOT NULL,
  "signature" text NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "valuation_asset_idx" ON "valuation_snapshots" ("asset_address");

CREATE TABLE "document_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "asset_address" text NOT NULL,
  "object_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "encrypted_data_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "uploaded_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "documents_object_key_uidx" ON "document_records" ("object_key");

CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "correlation_id" uuid NOT NULL,
  "actor" text,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text,
  "outcome" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "audit_correlation_idx" ON "audit_logs" ("correlation_id");
CREATE INDEX "audit_actor_idx" ON "audit_logs" ("actor");
