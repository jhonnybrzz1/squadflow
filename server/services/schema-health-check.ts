/**
 * Schema Health Check Service
 *
 * Validates that schema.ts (SQLite) and schema-pg.ts (Postgres) are synchronized.
 * Prevents schema drift by blocking server startup if divergences are detected.
 *
 * PRD Reference: Section 5.1 Fase 1 - "Adicionar health check de schema no startup"
 */

import * as schemaSqlite from '@shared/schema';
import * as schemaPg from '@shared/schema-pg';
import { logger } from '../utils/logger';

interface SchemaField {
  name: string;
  type: string;
  columnType?: string;
  nullable: boolean;
  hasDefault: boolean;
}

interface SchemaDivergence {
  table: string;
  field: string;
  issue: string;
  sqliteValue?: string;
  postgresValue?: string;
}

interface DrizzleColumn {
  dataType?: string;
  columnType?: string;
  notNull?: boolean;
  hasDefault?: boolean;
  default?: unknown;
}

interface DrizzleTable {
  columns?: Record<string, DrizzleColumn>;
  _?: {
    columns?: Record<string, DrizzleColumn>;
  };
}

/**
 * Extract field definitions from a Drizzle table schema
 */
function drizzleColumns(table: DrizzleTable): Record<string, DrizzleColumn> {
  if (!table || typeof table !== 'object') return {};
  // Spec 016 B3 (H-12): as colunas reais vivem no Symbol drizzle:Columns —
  // os acessos por propriedade (`columns`/`_`) retornavam vazio, fazendo o
  // check antigo comparar mapas vazios e aprovar qualquer coisa.
  for (const sym of Object.getOwnPropertySymbols(table as object)) {
    if (sym.description === 'drizzle:Columns') {
      const value = (table as unknown as Record<symbol, unknown>)[sym];
      if (value && typeof value === 'object') {
        return value as Record<string, DrizzleColumn>;
      }
    }
  }
  return table.columns || table._?.columns || {};
}

function extractTableFields(table: DrizzleTable): Map<string, SchemaField> {
  const fields = new Map<string, SchemaField>();

  if (!table || typeof table !== 'object') {
    return fields;
  }

  // Access the table's column definitions
  const columns = drizzleColumns(table);

  for (const [fieldName, column] of Object.entries(columns)) {
    if (column && typeof column === 'object') {
      const col = column as DrizzleColumn;
      fields.set(fieldName, {
        name: fieldName,
        type: col.dataType || col.columnType || 'unknown',
        columnType: col.columnType,
        nullable: !col.notNull,
        hasDefault: col.hasDefault || col.default !== undefined,
      });
    }
  }

  return fields;
}

/**
 * Compare two table schemas and return divergences
 */
function compareTableSchemas(
  tableName: string,
  sqliteTable: DrizzleTable,
  pgTable: DrizzleTable,
): SchemaDivergence[] {
  const divergences: SchemaDivergence[] = [];

  const sqliteFields = extractTableFields(sqliteTable);
  const pgFields = extractTableFields(pgTable);

  // Check for fields in SQLite but not in Postgres
  for (const [fieldName, sqliteField] of sqliteFields) {
    if (!pgFields.has(fieldName)) {
      divergences.push({
        table: tableName,
        field: fieldName,
        issue: 'Field exists in schema.ts but missing in schema-pg.ts',
        sqliteValue: `${sqliteField.type} (nullable: ${sqliteField.nullable})`,
      });
    }
  }

  // Check for fields in Postgres but not in SQLite
  for (const [fieldName, pgField] of pgFields) {
    if (!sqliteFields.has(fieldName)) {
      divergences.push({
        table: tableName,
        field: fieldName,
        issue: 'Field exists in schema-pg.ts but missing in schema.ts',
        postgresValue: `${pgField.type} (nullable: ${pgField.nullable})`,
      });
    }
  }

  // Check for type mismatches in common fields
  for (const [fieldName, sqliteField] of sqliteFields) {
    const pgField = pgFields.get(fieldName);
    if (pgField) {
      // Type mapping: SQLite integer/text/real vs Postgres serial/text/doublePrecision
      const sqliteType = sqliteField.type.toLowerCase();
      const pgType = pgField.type.toLowerCase();
      const sqliteColumnType = (sqliteField.columnType || '').toLowerCase();
      const pgColumnType = (pgField.columnType || '').toLowerCase();

      // Allow known compatible type mappings
      const isCompatible =
        (sqliteType === 'integer' &&
          (pgType === 'serial' || pgType === 'integer' || pgType === 'bigint')) ||
        (sqliteType === 'text' && pgType === 'text') ||
        (sqliteType === 'real' && (pgType === 'doubleprecision' || pgType === 'real')) ||
        (sqliteType === 'blob' && pgType === 'bytea') ||
        (sqliteType.includes('json') && pgType.includes('json')) ||
        // SQLite stores timestamps as ISO text; Postgres uses native timestamp types.
        (sqliteType === 'string' &&
          pgType === 'date' &&
          sqliteColumnType.includes('text') &&
          pgColumnType.includes('timestamp')) ||
        // SQLite serializes embeddings as text; Postgres uses pgvector/array.
        (sqliteType === 'string' &&
          pgType === 'array' &&
          sqliteColumnType.includes('text') &&
          pgColumnType.includes('vector')) ||
        // SQLite text with JSON mode stores JSON strings; Postgres text stores raw JSON.
        (sqliteType === 'json' &&
          pgType === 'string' &&
          sqliteColumnType.includes('text') &&
          pgColumnType.includes('text'));

      if (!isCompatible && sqliteType !== pgType) {
        divergences.push({
          table: tableName,
          field: fieldName,
          issue: 'Type mismatch between schemas',
          sqliteValue: sqliteField.type,
          postgresValue: pgField.type,
        });
      }
    }
  }

  return divergences;
}

/**
 * Validate that all tables in schema.ts have corresponding tables in schema-pg.ts
 */
export function validateSchemaSync(options: { skipCheck?: boolean } = {}): {
  isValid: boolean;
  divergences: SchemaDivergence[];
  message: string;
} {
  if (options.skipCheck) {
    logger.warn('[SchemaHealthCheck] Schema validation SKIPPED via --skip-schema-check flag');
    return {
      isValid: true,
      divergences: [],
      message: 'Schema validation skipped by flag',
    };
  }

  logger.info('[SchemaHealthCheck] Starting schema synchronization validation...');

  const allDivergences: SchemaDivergence[] = [];

  // Spec 016 B3 (H-12/FR-009): a lista deriva automaticamente das exports do
  // schema — toda tabela gerenciada entra na validação sem manutenção manual
  // (a lista fixa anterior omitia, p.ex., demandExternalDocs).
  const derivedTables = Object.entries(schemaSqlite as Record<string, unknown>)
    .filter(([, value]) => extractTableFields(value as DrizzleTable).size > 0)
    .map(([name]) => name);

  // Lista legada mantida apenas como piso de segurança (união com a derivada).
  const legacyTables = [
    'demands',
    'documentSnapshots',
    'approvalComments',
    'documentLifecycleEvents',
    'operationAttempts',
    'modelRoutingStageRuns',
    'agentDecisionRecords',
    'domainExecutionRecords',
    'progressiveRefinementRecords',
    'repos',
    'repoFiles',
    'files',
    'users',
    'telemetry',
    'humanFeedback',
    'feedbackRefinamento',
    'agentInterventions',
    'retentionPolicies',
    'retentionJobLogs',
    'idempotencyRecords',
    'clientErrors',
    'orchestrationRuns',
    'agentTurns',
    'agentToolCalls',
    'orchestrationEvents',
    'modelAliases',
    'modelCandidates',
    'modelHistory',
  ];

  const tablesToValidate = [...new Set([...legacyTables, ...derivedTables])];

  for (const tableName of tablesToValidate) {
    const sqliteTable = (schemaSqlite as Record<string, DrizzleTable>)[tableName];
    const pgTable = (schemaPg as Record<string, DrizzleTable>)[tableName];

    if (!sqliteTable) {
      logger.warn(`[SchemaHealthCheck] Table '${tableName}' not found in schema.ts`);
      continue;
    }

    if (!pgTable) {
      allDivergences.push({
        table: tableName,
        field: '*',
        issue: 'Table exists in schema.ts but missing in schema-pg.ts',
      });
      continue;
    }

    const tableDivergences = compareTableSchemas(tableName, sqliteTable, pgTable);
    allDivergences.push(...tableDivergences);
  }

  const isValid = allDivergences.length === 0;

  if (isValid) {
    logger.info('[SchemaHealthCheck] ✓ Schema validation passed - schemas are synchronized');
    return {
      isValid: true,
      divergences: [],
      message: 'Schemas are synchronized',
    };
  } else {
    logger.error('[SchemaHealthCheck] ✗ Schema validation FAILED - divergences detected:');
    for (const div of allDivergences) {
      logger.error(`  - Table: ${div.table}, Field: ${div.field}`);
      logger.error(`    Issue: ${div.issue}`);
      if (div.sqliteValue) logger.error(`    SQLite: ${div.sqliteValue}`);
      if (div.postgresValue) logger.error(`    Postgres: ${div.postgresValue}`);
    }

    return {
      isValid: false,
      divergences: allDivergences,
      message: `Found ${allDivergences.length} schema divergence(s). See logs for details.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Spec 016 B3 (H-12/FR-008): verificação da METADATA implantada — o health
// deixa de confiar apenas nas fontes TypeScript e inspeciona o banco real.
// ---------------------------------------------------------------------------

export interface DeployedDrift {
  table: string;
  column: string;
  issue: 'table_missing' | 'column_missing';
}

/** Nome físico (db) de uma tabela Drizzle. */
function physicalTableName(table: DrizzleTable): string | null {
  const symbols = Object.getOwnPropertySymbols(table as object);
  for (const sym of symbols) {
    if (sym.description === 'drizzle:Name') {
      return (table as unknown as Record<symbol, string>)[sym] ?? null;
    }
  }
  return null;
}

/** Nome físico (db) de uma coluna Drizzle. */
function physicalColumnNames(table: DrizzleTable): string[] {
  return Object.values(drizzleColumns(table))
    .map((col) => (col as { name?: string }).name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Compara o schema ativo com a metadata implantada fornecida.
 * Puro/testável: o chamador injeta `deployedColumns` (tabela física → colunas).
 */
export function detectDeployedDrift(
  activeSchema: Record<string, unknown>,
  deployedColumns: Map<string, Set<string>>,
): DeployedDrift[] {
  const drift: DeployedDrift[] = [];
  for (const value of Object.values(activeSchema)) {
    const table = value as DrizzleTable;
    if (extractTableFields(table).size === 0) continue;
    const tableName = physicalTableName(table);
    if (!tableName) continue;

    const deployed = deployedColumns.get(tableName);
    if (!deployed) {
      drift.push({ table: tableName, column: '*', issue: 'table_missing' });
      continue;
    }
    for (const columnName of physicalColumnNames(table)) {
      if (!deployed.has(columnName)) {
        drift.push({ table: tableName, column: columnName, issue: 'column_missing' });
      }
    }
  }
  return drift;
}

/**
 * Resultado da inspeção do banco implantado.
 *
 * Auditoria 2026-08-01 (A07): antes isto era `DeployedDrift[]`, e uma FALHA ao
 * inspecionar o banco devolvia `[]` — indistinguível de "nenhum drift". O
 * readiness lia esse vazio como saúde. Os três estados agora são explícitos.
 */
export type SchemaHealthStatus = 'healthy' | 'drift' | 'unknown';

export interface DeployedSchemaResult {
  status: SchemaHealthStatus;
  drift: DeployedDrift[];
  /** Preenchido apenas quando `status === 'unknown'`. */
  error?: string;
}

/**
 * Perfis em que drift NÃO derruba o boot: o SQLite de desenvolvimento cria
 * tabelas por `ensure*` depois do boot, então drift transitório é esperado.
 * Fora deles, strict é o padrão — era opt-in via env, e ninguém opta.
 */
function isStrictSchemaMode(): boolean {
  const explicit = process.env.SCHEMA_VERIFY_DEPLOYED;
  if (explicit) return explicit === 'strict';

  const env = process.env.NODE_ENV ?? 'development';
  return env !== 'development' && env !== 'test';
}

/** Último resultado conhecido, para o readiness responder sem reinspecionar. */
let lastSchemaResult: DeployedSchemaResult = { status: 'unknown', drift: [] };

export function getLastSchemaHealth(): DeployedSchemaResult {
  return lastSchemaResult;
}

/**
 * Inspeciona o banco IMPLANTADO (SQLite: sqlite_master/PRAGMA; PostgreSQL:
 * information_schema) e reporta tabelas/colunas ausentes vs o schema ativo.
 *
 * Loga erro por drift; lança apenas em strict mode, porque tabelas locais
 * legítimas podem ser criadas por ensure* após o boot. Strict passou a ser o
 * padrão fora de development/test (ver `isStrictSchemaMode`).
 */
export async function verifyDeployedSchema(): Promise<DeployedSchemaResult> {
  const { dbHelper, isPostgres } = await import('../db');
  const { sql } = await import('drizzle-orm');
  const activeSchema = (isPostgres ? schemaPg : schemaSqlite) as Record<string, unknown>;

  const deployed = new Map<string, Set<string>>();
  try {
    if (isPostgres) {
      const rows = (await dbHelper.all(
        sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      )) as Array<{ table_name: string; column_name: string }>;
      for (const row of rows) {
        if (!deployed.has(row.table_name)) deployed.set(row.table_name, new Set());
        deployed.get(row.table_name)!.add(row.column_name);
      }
    } else {
      const tables = (await dbHelper.all(
        sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
      )) as Array<{ name: string }>;
      for (const { name } of tables) {
        const cols = (await dbHelper.all(
          sql`SELECT name FROM pragma_table_info(${name})`,
        )) as Array<{ name: string }>;
        deployed.set(name, new Set(cols.map((c) => c.name)));
      }
    }
  } catch (error) {
    // A07: devolver `[]` aqui equivalia a dizer "schema íntegro" quando na
    // verdade não foi possível olhar. `unknown` não é `healthy`.
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[SchemaHealthCheck] Falha ao inspecionar o banco implantado', {
      error: error instanceof Error ? error : undefined,
    });
    lastSchemaResult = { status: 'unknown', drift: [], error: message };

    if (isStrictSchemaMode()) {
      throw new Error(`Schema health indeterminado: ${message}`);
    }
    return lastSchemaResult;
  }

  const drift = detectDeployedDrift(activeSchema, deployed);
  for (const item of drift) {
    logger.error(
      `[SchemaHealthCheck] Drift implantado: ${item.table}.${item.column} (${item.issue})`,
    );
  }

  lastSchemaResult = {
    status: drift.length > 0 ? 'drift' : 'healthy',
    drift,
  };

  if (drift.length > 0 && isStrictSchemaMode()) {
    throw new Error(`Deployed schema drift detected: ${drift.length} issue(s). See logs.`);
  }
  return lastSchemaResult;
}

/**
 * Perform schema health check on server startup
 * Throws error if validation fails (unless --skip-schema-check flag is set)
 */
export async function assertSchemaHealth(): Promise<void> {
  const skipCheck = process.argv.includes('--skip-schema-check');

  const result = validateSchemaSync({ skipCheck });

  // Spec 016 B3 (FR-008): além das fontes TS, inspecionar o banco implantado.
  if (!skipCheck) {
    await verifyDeployedSchema();
  }

  if (!result.isValid) {
    const errorMessage = `
╔════════════════════════════════════════════════════════════════════════════╗
║                     SCHEMA SYNCHRONIZATION ERROR                           ║
╠════════════════════════════════════════════════════════════════════════════╣
║                                                                            ║
║  Schema drift detected between schema.ts and schema-pg.ts!                 ║
║                                                                            ║
║  Found ${result.divergences.length.toString().padEnd(2)} divergence(s) that must be resolved before starting.      ║
║                                                                            ║
║  Divergences:                                                              ║
${result.divergences
  .map((d) => `║    • ${d.table}.${d.field}: ${d.issue}`.padEnd(77) + '║')
  .join('\n')}
║                                                                            ║
║  To fix:                                                                   ║
║    1. Review the divergences listed above                                  ║
║    2. Update schema-pg.ts to match schema.ts                               ║
║    3. Run: npm run db:generate (if using migrations)                       ║
║    4. Restart the server                                                   ║
║                                                                            ║
║  Emergency bypass (NOT RECOMMENDED):                                       ║
║    node server/index.js --skip-schema-check                                ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
`;

    logger.error(errorMessage);
    throw new Error('Schema validation failed. Server startup blocked.');
  }
}

// Made with Bob
