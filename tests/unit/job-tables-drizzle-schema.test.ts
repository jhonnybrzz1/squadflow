import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import * as sqliteSchema from '../../shared/schema';
import * as pgSchema from '../../shared/schema-pg';

const sqliteMigration = readFileSync('migrations/0038_jobs_durable_tables.sql', 'utf8');
const pgMigration = readFileSync('migrations-pg/0022_jobs_durable_tables.sql', 'utf8');

describe('durable jobs Drizzle schema', () => {
  it('exposes the durable job tables in both SQLite and Postgres schemas', () => {
    expect(sqliteSchema.documentJobs).toBeDefined();
    expect(sqliteSchema.agentJobs).toBeDefined();
    expect(sqliteSchema.codeAgentJobQueue).toBeDefined();

    expect(pgSchema.documentJobs).toBeDefined();
    expect(pgSchema.agentJobs).toBeDefined();
    expect(pgSchema.codeAgentJobQueue).toBeDefined();
  });

  it('keeps the job table columns semantically aligned across dialects', () => {
    const expectedColumns = {
      documentJobs: [
        'jobId',
        'demandId',
        'docType',
        'targetFilepath',
        'status',
        'attempts',
        'error',
        'createdAt',
        'updatedAt',
      ],
      agentJobs: [
        'id',
        'demandId',
        'speckitPath',
        'status',
        'promptSentHash',
        'filesModified',
        'typecheckPassed',
        'apiCostUsd',
        'humanEditsCount',
        'cancelledAt',
        'errorMessage',
        'steps',
        'createdAt',
      ],
      codeAgentJobQueue: [
        'id',
        'demandId',
        'speckitPath',
        'prompt',
        'cwd',
        'status',
        'error',
        'workerPid',
        'createdAt',
        'updatedAt',
      ],
    } as const;

    for (const [tableName, columns] of Object.entries(expectedColumns)) {
      expect(Object.keys(sqliteSchema[tableName as keyof typeof expectedColumns])).toEqual(
        expect.arrayContaining(columns),
      );
      expect(Object.keys(pgSchema[tableName as keyof typeof expectedColumns])).toEqual(
        expect.arrayContaining(columns),
      );
    }
  });

  it('versions durable job tables and indexes in SQLite and Postgres migrations', () => {
    for (const table of ['document_jobs', 'agent_jobs', 'code_agent_job_queue']) {
      expect(sqliteMigration).toContain(`CREATE TABLE IF NOT EXISTS \`${table}\``);
      expect(pgMigration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }

    for (const indexName of [
      'document_jobs_status_idx',
      'document_jobs_demand_idx',
      'agent_jobs_demand_idx',
      'agent_jobs_status_idx',
      'code_agent_job_queue_status_idx',
    ]) {
      expect(sqliteMigration).toContain(`CREATE INDEX IF NOT EXISTS \`${indexName}\``);
      expect(pgMigration).toContain(`CREATE INDEX IF NOT EXISTS "${indexName}"`);
    }

    expect(sqliteMigration).toContain('`worker_pid` integer');
    expect(pgMigration).toContain('"worker_pid" integer');
    expect(sqliteMigration).toContain('ADD COLUMN `run_id` text');
    expect(pgMigration).toContain('ADD COLUMN IF NOT EXISTS "run_id" text');
  });
});
