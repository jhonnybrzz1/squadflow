/**
 * Política ÚNICA de banco/storage (spec 016 B1 / auditoria M-08).
 *
 * Toda decisão de URL, dialeto, schema ativo e storage deriva daqui —
 * `server/services/storage-policy.ts`, `shared/schema-unified.ts` e
 * `server/storage.ts` consomem esta fonte. Combinações contraditórias
 * falham ANTES de qualquer query (FR-002); storage em memória exige
 * opt-in explícito fora de testes (FR-003).
 */

export type DatabaseDialect = 'postgres' | 'sqlite';
export type StorageKind = 'db' | 'memory';

export interface DatabasePolicy {
  databaseUrl: string;
  dialect: DatabaseDialect;
  sqliteAllowed: boolean;
  storage: StorageKind;
}

function isPostgresUrl(value: string): boolean {
  return value.startsWith('postgresql://') || value.startsWith('postgres://');
}

function isSqliteAllowedByEnvironment(env: NodeJS.ProcessEnv): boolean {
  if (env.ALLOW_SQLITE_IN_PRODUCTION === 'true') return true;
  return env.NODE_ENV !== 'production';
}

/**
 * Rodando sob teste? Exportado porque a mesma pergunta governa o isolamento de
 * QUALQUER recurso real do projeto — o banco aqui, e a persistência dos feature
 * flags em `server/services/feature-flags.ts`. Duas cópias da regra divergem.
 */
export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.VITEST !== undefined;
}

/** Banco SQLite local de trabalho — o arquivo "de produção" do dev. */
const DEFAULT_SQLITE_URL = 'sqlite.db';

/** `sqlite.db`, `./sqlite.db` ou qualquer caminho terminando em `/sqlite.db`. */
function isRealProjectDatabase(url: string): boolean {
  return url === DEFAULT_SQLITE_URL || /(^|\/)sqlite\.db$/.test(url);
}

/**
 * CRÍTICO-01: sob Vitest o banco resolvia para `sqlite.db` — o banco REAL do
 * desenvolvedor — tanto pelo fallback quanto pelo `DATABASE_URL=sqlite.db` do
 * `.env`, que o `dotenv/config` do servidor carrega dentro do processo de teste.
 * Qualquer serviço que caísse no `dbHelper` global durante um teste (runner não
 * injetado, ou restaurado para o global num `afterEach`) gravava nele: foi assim
 * que fixtures entraram em `code_agent_job_queue` e 231 linhas de teste em
 * `dead_letters`.
 *
 * Sob teste, o arquivo real é sempre trocado por um banco isolado por processo.
 * Qualquer outro caminho (`:memory:`, fixtures próprias) passa intacto. Um teste
 * que precise mesmo do banco real deve declarar `ALLOW_REAL_DB_IN_TESTS=true` —
 * opt-in explícito e auditável, nunca o default.
 */
function applyTestIsolation(url: string, env: NodeJS.ProcessEnv): string {
  if (!isTestEnvironment(env)) return url;
  if (env.ALLOW_REAL_DB_IN_TESTS === 'true') return url;
  if (!isRealProjectDatabase(url)) return url;
  // Sem `node:os`/`node:path` de propósito: este módulo também é alcançado pelo
  // bundle do cliente via shared/schema-unified.ts.
  const tmp = (env.TMPDIR || '/tmp').replace(/\/+$/, '');
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  return `${tmp}/aichatflow-vitest-${pid}.db`;
}

function resolveSqliteUrl(env: NodeJS.ProcessEnv, explicitUrl: string): string {
  return applyTestIsolation(explicitUrl || DEFAULT_SQLITE_URL, env);
}

function resolveStorageKind(env: NodeJS.ProcessEnv): StorageKind {
  const requested = env.STORAGE?.toLowerCase();
  if (requested === 'db') return 'db';
  if (requested === 'memory') return 'memory';
  if (requested !== undefined && requested !== '') {
    throw new Error(`STORAGE inválido: '${env.STORAGE}'. Use 'db' ou 'memory'.`);
  }
  // FR-003: memória implícita só em testes; fora deles o default é durável.
  return isTestEnvironment(env) ? 'memory' : 'db';
}

export function resolveDatabasePolicy(env: NodeJS.ProcessEnv = process.env): DatabasePolicy {
  const requestedDialect = env.DATABASE_DIALECT?.toLowerCase();
  const databaseUrl = env.DATABASE_URL || '';
  const storage = resolveStorageKind(env);

  if (
    requestedDialect !== undefined &&
    requestedDialect !== 'postgres' &&
    requestedDialect !== 'sqlite'
  ) {
    throw new Error(
      `DATABASE_DIALECT inválido: '${env.DATABASE_DIALECT}'. Use 'postgres' ou 'sqlite'.`,
    );
  }

  if (requestedDialect === 'postgres') {
    if (!isPostgresUrl(databaseUrl)) {
      throw new Error('DATABASE_DIALECT=postgres requires DATABASE_URL=postgres://...');
    }
    return { databaseUrl, dialect: 'postgres', sqliteAllowed: false, storage };
  }

  if (requestedDialect === 'sqlite') {
    // FR-002: URL PostgreSQL + override SQLite é contraditório — falha cedo.
    if (isPostgresUrl(databaseUrl)) {
      throw new Error(
        'Configuração contraditória: DATABASE_DIALECT=sqlite com DATABASE_URL PostgreSQL. Remova o override ou troque a URL.',
      );
    }
    const sqliteAllowed = isSqliteAllowedByEnvironment(env);
    if (!sqliteAllowed) {
      throw new Error('SQLite is disabled in production. Set DATABASE_URL for Postgres.');
    }
    return {
      databaseUrl: resolveSqliteUrl(env, databaseUrl),
      dialect: 'sqlite',
      sqliteAllowed,
      storage,
    };
  }

  if (isPostgresUrl(databaseUrl)) {
    return { databaseUrl, dialect: 'postgres', sqliteAllowed: false, storage };
  }

  const sqliteAllowed = isSqliteAllowedByEnvironment(env);
  if (!sqliteAllowed) {
    throw new Error(
      'Postgres is required in production. Set DATABASE_URL=postgres://... or explicitly opt in with ALLOW_SQLITE_IN_PRODUCTION=true.',
    );
  }

  return {
    databaseUrl: resolveSqliteUrl(env, databaseUrl),
    dialect: 'sqlite',
    sqliteAllowed,
    storage,
  };
}
