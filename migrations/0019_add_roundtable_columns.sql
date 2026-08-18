-- Migration: Add roundtable columns to demands table
-- These columns were missing from the initial schema but are defined in shared/schema.ts

-- Add mode column (sequential or roundtable)
ALTER TABLE demands ADD COLUMN mode TEXT DEFAULT 'sequential';

-- Add roundtable_config column (JSON with agentIds, maxRounds, currentRound)
ALTER TABLE demands ADD COLUMN roundtable_config TEXT DEFAULT '{"agentIds":[],"maxRounds":3}';

-- Add roundtable_summary column (JSON with rounds data)
ALTER TABLE demands ADD COLUMN roundtable_summary TEXT;

-- Create index for mode filtering
CREATE INDEX IF NOT EXISTS idx_demands_mode ON demands(mode);
