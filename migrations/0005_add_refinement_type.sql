-- Add refinement_type column to demands table
ALTER TABLE demands ADD COLUMN refinement_type TEXT DEFAULT NULL;