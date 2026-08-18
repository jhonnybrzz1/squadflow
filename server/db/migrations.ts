import Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  [key: string]: unknown;
}

interface IndexInfo {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
  [key: string]: unknown;
}

interface IndexColumnInfo {
  seqno: number;
  cid: number;
  name: string;
  [key: string]: unknown;
}

/**
 * Spec 10146 — remove a coluna `mode` da tabela `demands` no SQLite de forma
 * idempotente e segura, SEM usar `CREATE TABLE ... AS SELECT`.
 *
 * Lê o schema real via `PRAGMA table_info` e `PRAGMA index_list`/`index_info`,
 * recria `demands_new` com DDL explícito (tipos, PK, defaults), copia os dados,
 * dropa a tabela antiga (e seus índices), recria os índices necessários na
 * nova tabela e depois renomeia. Preserva o nome "demands" para que as foreign
 * keys filhas continuem válidas.
 */
export function dropDemandModeColumnIfExists(sqliteDb: SqliteDatabase): void {
  const tables = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demands'")
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;

  const columns = sqliteDb.pragma("table_info('demands')") as ColumnInfo[];
  const hasMode = columns.some((col) => col.name === 'mode');
  if (!hasMode) return;

  const keptColumns = columns.filter((col) => col.name !== 'mode');
  if (keptColumns.length === 0) return;

  // Captura metadados dos índices ANTES de dropar a tabela original.
  const indexList = sqliteDb.pragma("index_list('demands')") as IndexInfo[];
  const indexDefinitions: Array<{ name: string; unique: boolean; columns: string[] }> = [];
  for (const idx of indexList) {
    if (idx.name.startsWith('sqlite_autoindex_')) continue;
    const indexColumns = sqliteDb.pragma(`index_info('${idx.name}')`) as IndexColumnInfo[];
    if (indexColumns.some((ic) => ic.name === 'mode')) continue;
    const columnsList = indexColumns.filter((ic) => ic.name != null).map((ic) => ic.name);
    if (columnsList.length === 0) continue;
    indexDefinitions.push({ name: idx.name, unique: Boolean(idx.unique), columns: columnsList });
  }

  // Constrói DDL da nova tabela a partir dos metadados reais.
  const columnDefs: string[] = [];
  const primaryKeys: string[] = [];
  for (const col of keptColumns) {
    const parts: string[] = [`${col.name} ${col.type ?? 'TEXT'}`];
    if (col.notnull) parts.push('NOT NULL');
    if (col.dflt_value != null) {
      const isQuotedString = /^'.*'$/s.test(col.dflt_value);
      const isNumeric = /^-?\d+(\.\d+)?$/.test(col.dflt_value);
      const defaultExpr = isQuotedString || isNumeric ? col.dflt_value : `(${col.dflt_value})`;
      parts.push(`DEFAULT ${defaultExpr}`);
    }
    if (col.pk) {
      primaryKeys.push(col.name);
    }
    columnDefs.push(parts.join(' '));
  }

  const pkClause = primaryKeys.length > 0 ? `, PRIMARY KEY (${primaryKeys.join(', ')})` : '';
  const createSql = `CREATE TABLE demands_new (${columnDefs.join(', ')}${pkClause})`;

  const columnNames = keptColumns.map((col) => col.name).join(', ');
  const insertSql = `INSERT INTO demands_new (${columnNames}) SELECT ${columnNames} FROM demands`;

  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  try {
    sqliteDb.exec(createSql);
    sqliteDb.exec(insertSql);

    // Dropa a tabela original (e seus índices) antes de recriar índices na nova.
    sqliteDb.exec('DROP TABLE demands');

    // Recria os índices preservados.
    for (const idx of indexDefinitions) {
      const unique = idx.unique ? 'UNIQUE ' : '';
      const columnsList = idx.columns.join(', ');
      sqliteDb.exec(
        `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON demands_new (${columnsList})`,
      );
    }

    sqliteDb.exec('ALTER TABLE demands_new RENAME TO demands');
  } finally {
    sqliteDb.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Demanda 10196 — adiciona colunas `origin` (text) e `origin_metadata` (json text)
 * à tabela `demands` no SQLite de forma idempotente, sem recriar a tabela.
 */
export function addDemandOriginColumnsIfMissing(sqliteDb: SqliteDatabase): void {
  const tables = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demands'")
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;

  const columns = sqliteDb.pragma("table_info('demands')") as ColumnInfo[];
  const hasOrigin = columns.some((col) => col.name === 'origin');
  const hasOriginMetadata = columns.some((col) => col.name === 'origin_metadata');

  if (!hasOrigin) {
    sqliteDb.exec('ALTER TABLE demands ADD COLUMN origin text');
  }
  if (!hasOriginMetadata) {
    sqliteDb.exec("ALTER TABLE demands ADD COLUMN origin_metadata text DEFAULT '{}'");
  }
}

/**
 * Auditoria 2026-08-04 (A08) — `prompt_version_metrics.model` no SQLite.
 *
 * O serviço lê e escreve essa coluna (`prompt-version.ts`) e o DDL de runtime a
 * cria, mas ela não existia em nenhum dos dois schemas Drizzle. Ao declará-la, o
 * `SchemaHealthCheck` passou a acusar `column_missing` a cada boot — o drift era
 * real e estava apenas invisível.
 *
 * O `ALTER` já existe dentro de `ensureTable()`, mas aquele caminho é preguiçoso:
 * só roda quando alguém usa versionamento de prompt. Aqui roda no boot, junto das
 * demais reconciliações, para o health check não acusar drift permanente.
 */
export function addPromptVersionMetricsModelIfMissing(sqliteDb: SqliteDatabase): void {
  const tables = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_version_metrics'")
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;

  const columns = sqliteDb.pragma("table_info('prompt_version_metrics')") as ColumnInfo[];
  if (columns.some((col) => col.name === 'model')) return;

  sqliteDb.exec('ALTER TABLE prompt_version_metrics ADD COLUMN model text');
}
