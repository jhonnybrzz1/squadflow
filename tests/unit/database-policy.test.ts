import { describe, expect, it } from 'vitest';

import { resolveDatabasePolicy } from '@shared/database-policy';

const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv;

describe('Política única de banco/storage (spec 016 B1 / M-08)', () => {
  describe('SC-001: matriz válida inicializa coerente', () => {
    it('perfil local SQLite default (dev, sem URL)', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'development' }));
      expect(policy).toMatchObject({ dialect: 'sqlite', databaseUrl: 'sqlite.db', storage: 'db' });
    });

    it('URL PostgreSQL sem override → postgres', () => {
      const policy = resolveDatabasePolicy(
        env({ DATABASE_URL: 'postgresql://u:p@localhost/db', NODE_ENV: 'development' }),
      );
      expect(policy.dialect).toBe('postgres');
      expect(policy.sqliteAllowed).toBe(false);
    });

    it('DATABASE_DIALECT=postgres com URL PG', () => {
      const policy = resolveDatabasePolicy(
        env({ DATABASE_DIALECT: 'postgres', DATABASE_URL: 'postgres://u:p@h/db' }),
      );
      expect(policy.dialect).toBe('postgres');
    });

    it('teste: memória implícita permitida', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'test' }));
      expect(policy.storage).toBe('memory');
    });

    // CRÍTICO-01: fixtures de teste vazaram para o sqlite.db real porque o
    // fallback sob Vitest apontava para o arquivo de produção local.
    it('teste: fallback SQLite é isolado, nunca o sqlite.db real', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'test', STORAGE: 'db' }));
      expect(policy.databaseUrl).not.toBe('sqlite.db');
      expect(policy.databaseUrl).toMatch(/aichatflow-vitest-\d+\.db$/);
    });

    // O .env do projeto traz DATABASE_URL=sqlite.db e o dotenv/config do
    // servidor o carrega dentro do processo de teste — o caminho explícito
    // também precisa ser isolado, não só o fallback.
    it('teste: DATABASE_URL=sqlite.db explícito também é isolado', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'test', DATABASE_URL: 'sqlite.db' }));
      expect(policy.databaseUrl).toMatch(/aichatflow-vitest-\d+\.db$/);
    });

    it('teste: caminho de fixture próprio passa intacto', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'test', DATABASE_URL: 'fixture.db' }));
      expect(policy.databaseUrl).toBe('fixture.db');
    });

    it('teste: ALLOW_REAL_DB_IN_TESTS=true é o único opt-in para o banco real', () => {
      const policy = resolveDatabasePolicy(
        env({ NODE_ENV: 'test', DATABASE_URL: 'sqlite.db', ALLOW_REAL_DB_IN_TESTS: 'true' }),
      );
      expect(policy.databaseUrl).toBe('sqlite.db');
    });

    it('fora de teste o banco real segue intocado pelo isolamento', () => {
      const policy = resolveDatabasePolicy(
        env({ NODE_ENV: 'development', DATABASE_URL: 'sqlite.db' }),
      );
      expect(policy.databaseUrl).toBe('sqlite.db');
    });

    it('STORAGE=memory explícito fora de teste é aceito', () => {
      const policy = resolveDatabasePolicy(env({ NODE_ENV: 'development', STORAGE: 'memory' }));
      expect(policy.storage).toBe('memory');
    });
  });

  describe('SC-002: contradições falham ANTES de queries', () => {
    it('URL PostgreSQL + override sqlite → erro claro (US1-AS2)', () => {
      expect(() =>
        resolveDatabasePolicy(
          env({ DATABASE_DIALECT: 'sqlite', DATABASE_URL: 'postgres://u:p@h/db' }),
        ),
      ).toThrow(/contraditória/i);
    });

    it('DIALECT=postgres sem URL PG → erro', () => {
      expect(() => resolveDatabasePolicy(env({ DATABASE_DIALECT: 'postgres' }))).toThrow(
        /requires DATABASE_URL/,
      );
    });

    it('DIALECT desconhecido → erro', () => {
      expect(() => resolveDatabasePolicy(env({ DATABASE_DIALECT: 'mysql' }))).toThrow(/inválido/);
    });

    it('STORAGE desconhecido → erro', () => {
      expect(() => resolveDatabasePolicy(env({ NODE_ENV: 'development', STORAGE: 'ram' }))).toThrow(
        /STORAGE inválido/,
      );
    });

    it('produção sem URL PG e sem opt-in SQLite → erro', () => {
      expect(() => resolveDatabasePolicy(env({ NODE_ENV: 'production' }))).toThrow(
        /Postgres is required/,
      );
    });
  });

  it('FR-003: fora de teste, storage default é durável (db), nunca memória implícita', () => {
    const policy = resolveDatabasePolicy(env({ NODE_ENV: 'development' }));
    expect(policy.storage).toBe('db');
  });
});
