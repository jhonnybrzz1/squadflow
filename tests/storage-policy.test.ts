import { describe, expect, it } from 'vitest';
import { resolveDatabasePolicy } from '../server/services/storage-policy';

describe('storage policy', () => {
  it('requires Postgres in production by default', () => {
    expect(() => resolveDatabasePolicy({ NODE_ENV: 'production', DATABASE_URL: '' })).toThrow(
      /Postgres is required/,
    );
  });

  it('allows sqlite explicitly outside production', () => {
    const policy = resolveDatabasePolicy({ NODE_ENV: 'development', DATABASE_DIALECT: 'sqlite' });
    expect(policy.dialect).toBe('sqlite');
    expect(policy.databaseUrl).toBe('sqlite.db');
  });

  // CRÍTICO-01: em teste o default NÃO pode ser o sqlite.db real do dev.
  it('isolates the sqlite file under test', () => {
    const policy = resolveDatabasePolicy({ NODE_ENV: 'test', DATABASE_DIALECT: 'sqlite' });
    expect(policy.dialect).toBe('sqlite');
    expect(policy.databaseUrl).not.toBe('sqlite.db');
    expect(policy.databaseUrl).toContain('aichatflow-vitest-');
  });

  it('uses Postgres when DATABASE_URL is postgres', () => {
    const policy = resolveDatabasePolicy({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@example/db',
    });
    expect(policy.dialect).toBe('postgres');
  });
});
