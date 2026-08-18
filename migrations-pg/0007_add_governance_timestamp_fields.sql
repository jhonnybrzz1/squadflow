-- Add governance timestamp fields missing from the original schema
ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "approved_by" text;
ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp;
ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "returned_to_draft_at" timestamp;
