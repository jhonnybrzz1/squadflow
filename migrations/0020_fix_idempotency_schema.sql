-- 0020_fix_idempotency_schema.sql
-- Add last_succeeded_dialect to idempotency_records to fix schema drift blocking PDF generation
ALTER TABLE idempotency_records ADD COLUMN last_succeeded_dialect TEXT NOT NULL DEFAULT 'unknown';
