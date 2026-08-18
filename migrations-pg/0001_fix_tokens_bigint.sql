-- Fix tokens_in and tokens_out to use bigint instead of integer
-- This prevents "value out of range for type integer" errors

ALTER TABLE progressive_refinement_records 
  ALTER COLUMN tokens_in TYPE bigint,
  ALTER COLUMN tokens_out TYPE bigint;
