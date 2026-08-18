-- Keep integer timestamp columns numeric in PostgreSQL.
-- Earlier defaults using NOW() can send ISO timestamps into INTEGER columns.

ALTER TABLE model_routing_stage_runs
  ALTER COLUMN created_at SET DEFAULT EXTRACT(EPOCH FROM NOW())::integer;

ALTER TABLE domain_execution_records
  ALTER COLUMN created_at SET DEFAULT EXTRACT(EPOCH FROM NOW())::integer;
