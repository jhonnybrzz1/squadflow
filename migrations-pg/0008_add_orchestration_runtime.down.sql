-- Rollback da Orchestration Runtime Persistence — PostgreSQL.
-- Ordem inversa de criação para respeitar as foreign keys.

DROP INDEX IF EXISTS idx_orchestration_events_run;
DROP INDEX IF EXISTS idx_agent_tool_calls_turn;
DROP INDEX IF EXISTS idx_agent_turns_run;
DROP INDEX IF EXISTS idx_orchestration_runs_demand;

DROP TABLE IF EXISTS orchestration_events;
DROP TABLE IF EXISTS agent_tool_calls;
DROP TABLE IF EXISTS agent_turns;
DROP TABLE IF EXISTS orchestration_runs;
