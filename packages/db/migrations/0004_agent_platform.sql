CREATE TYPE "agent_status" AS ENUM ('PENDING_WALLET', 'PENDING_CVI', 'PENDING_MANDATE', 'ACTIVE', 'PAUSED', 'REVOKED');
CREATE TYPE "agent_credential_status" AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED', 'EXPIRED');
CREATE TYPE "agent_mandate_status" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'SUPERSEDED');
CREATE TYPE "agent_intent_state" AS ENUM ('PREPARED', 'APPROVAL_REQUIRED', 'APPROVED', 'QUEUED', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'INDEXING', 'COMPLETED', 'DENIED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'REVERTED', 'FAILED', 'FAILED_WITH_ALLOWANCE');
CREATE TYPE "agent_policy_decision" AS ENUM ('AUTO_APPROVED', 'HUMAN_REQUIRED', 'DENIED');
CREATE TYPE "agent_step_status" AS ENUM ('PENDING', 'SIGNING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

CREATE TABLE "institutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text NOT NULL,
  "admin_privy_user_id" text NOT NULL, "admin_wallet" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "institutions_admin_privy_user_uidx" ON "institutions" ("admin_privy_user_id");
CREATE UNIQUE INDEX "institutions_admin_wallet_uidx" ON "institutions" ("admin_wallet");

CREATE TABLE "institution_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE CASCADE,
  "privy_user_id" text NOT NULL, "wallet" text NOT NULL, "role" text DEFAULT 'ADMIN' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "institution_members_user_uidx" ON "institution_members" ("institution_id", "privy_user_id");
CREATE INDEX "institution_members_wallet_idx" ON "institution_members" ("wallet");

CREATE TABLE "agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "status" "agent_status" DEFAULT 'PENDING_WALLET' NOT NULL,
  "wallet_address" text, "privy_wallet_id" text, "signer_id" text, "policy_id" text,
  "cvi_active" boolean DEFAULT false NOT NULL, "cvi_expires_at" timestamptz, "last_seen_at" timestamptz,
  "created_by" text NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL, "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "agents_wallet_uidx" ON "agents" ("wallet_address");
CREATE UNIQUE INDEX "agents_privy_wallet_uidx" ON "agents" ("privy_wallet_id");
CREATE INDEX "agents_institution_status_idx" ON "agents" ("institution_id", "status");

CREATE TABLE "agent_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL, "secret_hash" text NOT NULL, "label" text NOT NULL, "scopes" jsonb NOT NULL,
  "status" "agent_credential_status" DEFAULT 'ACTIVE' NOT NULL, "expires_at" timestamptz,
  "last_used_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL, "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "agent_credentials_client_uidx" ON "agent_credentials" ("client_id");
CREATE INDEX "agent_credentials_agent_status_idx" ON "agent_credentials" ("agent_id", "status");

CREATE TABLE "agent_mandates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "version" integer NOT NULL, "wallet" text NOT NULL, "manifest_hash" text NOT NULL,
  "allowed_actions" jsonb NOT NULL, "allowed_assets" jsonb NOT NULL, "constraints" jsonb NOT NULL,
  "nonce" numeric(78,0) NOT NULL, "signature" text NOT NULL,
  "status" "agent_mandate_status" DEFAULT 'ACTIVE' NOT NULL, "starts_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "agent_mandates_agent_version_uidx" ON "agent_mandates" ("agent_id", "version");
CREATE UNIQUE INDEX "agent_mandates_agent_nonce_uidx" ON "agent_mandates" ("agent_id", "nonce");
CREATE INDEX "agent_mandates_agent_status_idx" ON "agent_mandates" ("agent_id", "status", "expires_at");

CREATE TABLE "agent_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "mandate_id" uuid NOT NULL REFERENCES "agent_mandates"("id"), "idempotency_key" uuid NOT NULL,
  "action" text NOT NULL, "input" jsonb NOT NULL, "intent_hash" text NOT NULL,
  "state" "agent_intent_state" NOT NULL, "policy_decision" "agent_policy_decision" NOT NULL,
  "approval_required" boolean NOT NULL, "approval_reason" text, "reserved_notional" numeric(78,0) DEFAULT 0 NOT NULL,
  "preflight" jsonb, "correlation_id" uuid, "quote_expires_at" timestamptz, "intent_expires_at" timestamptz NOT NULL,
  "manifest_hash" text NOT NULL, "privy_action_id" text, "tx_hash" text, "error_code" text, "error_message" text,
  "locked_by" text, "locked_at" timestamptz, "submitted_at" timestamptz, "confirmed_at" timestamptz,
  "completed_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "agent_intents_idempotency_uidx" ON "agent_intents" ("agent_id", "idempotency_key");
CREATE UNIQUE INDEX "agent_intents_hash_uidx" ON "agent_intents" ("agent_id", "intent_hash");
CREATE INDEX "agent_intents_queue_idx" ON "agent_intents" ("state", "created_at");
CREATE INDEX "agent_intents_agent_created_idx" ON "agent_intents" ("agent_id", "created_at");
CREATE INDEX "agent_intents_tx_idx" ON "agent_intents" ("tx_hash");

CREATE TABLE "agent_intent_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "intent_id" uuid NOT NULL REFERENCES "agent_intents"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL, "kind" text NOT NULL, "destination" text NOT NULL, "calldata" text NOT NULL,
  "native_value" numeric(78,0) DEFAULT 0 NOT NULL, "description" text NOT NULL,
  "status" "agent_step_status" DEFAULT 'PENDING' NOT NULL, "privy_action_id" text, "tx_hash" text,
  "error_message" text, "submitted_at" timestamptz, "confirmed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "agent_intent_steps_order_uidx" ON "agent_intent_steps" ("intent_id", "step_index");
CREATE INDEX "agent_intent_steps_tx_idx" ON "agent_intent_steps" ("tx_hash");

CREATE TABLE "agent_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "intent_id" uuid NOT NULL REFERENCES "agent_intents"("id") ON DELETE CASCADE,
  "approver_wallet" text NOT NULL, "decision" text NOT NULL, "intent_hash" text NOT NULL,
  "signature" text NOT NULL, "expires_at" timestamptz NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "agent_approvals_intent_wallet_uidx" ON "agent_approvals" ("intent_id", "approver_wallet");

CREATE TABLE "agent_usage_buckets" (
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "mandate_id" uuid NOT NULL REFERENCES "agent_mandates"("id") ON DELETE CASCADE,
  "bucket_start" timestamptz NOT NULL, "reserved_notional" numeric(78,0) DEFAULT 0 NOT NULL,
  "completed_notional" numeric(78,0) DEFAULT 0 NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("agent_id", "mandate_id", "bucket_start")
);

CREATE TABLE "agent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "intent_id" uuid REFERENCES "agent_intents"("id") ON DELETE CASCADE, "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL, "occurred_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "agent_events_agent_time_idx" ON "agent_events" ("agent_id", "occurred_at");
CREATE INDEX "agent_events_intent_time_idx" ON "agent_events" ("intent_id", "occurred_at");

CREATE TABLE "agent_webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE CASCADE,
  "url" text NOT NULL, "secret_hash" text NOT NULL, "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "agent_webhook_endpoints_institution_idx" ON "agent_webhook_endpoints" ("institution_id", "enabled");

CREATE TABLE "agent_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "endpoint_id" uuid NOT NULL REFERENCES "agent_webhook_endpoints"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "agent_events"("id") ON DELETE CASCADE, "status" text DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "last_error" text, "delivered_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "agent_webhook_delivery_event_endpoint_uidx" ON "agent_webhook_deliveries" ("endpoint_id", "event_id");
CREATE INDEX "agent_webhook_delivery_due_idx" ON "agent_webhook_deliveries" ("status", "next_attempt_at");
