ALTER TABLE "automation_jobs"
  ADD COLUMN IF NOT EXISTS "prepared_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "transaction_nonce" numeric(78,0),
  ADD COLUMN IF NOT EXISTS "signed_transaction" text;

COMMENT ON COLUMN "automation_jobs"."signed_transaction" IS
  'Exact signed keeper transaction persisted before broadcast; clear after terminal receipt reconciliation.';
