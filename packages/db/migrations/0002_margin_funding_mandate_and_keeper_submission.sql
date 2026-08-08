ALTER TYPE "automation_job_status" ADD VALUE IF NOT EXISTS 'SUBMITTED' AFTER 'RUNNING';

ALTER TABLE "margin_accounts"
  ADD COLUMN IF NOT EXISTS "permitted_lender" text,
  ADD COLUMN IF NOT EXISTS "funding_target" numeric(78,0) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "minimum_funding" numeric(78,0) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "funding_duration_seconds" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "funding_expiry" timestamptz,
  ADD COLUMN IF NOT EXISTS "max_annual_rate_bps" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "funding_closed" boolean DEFAULT false NOT NULL;

ALTER TABLE "automation_jobs"
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz;

CREATE INDEX IF NOT EXISTS "margin_accounts_fundable_idx"
  ON "margin_accounts" ("margin_engine_address", "funding_closed", "funding_expiry");
