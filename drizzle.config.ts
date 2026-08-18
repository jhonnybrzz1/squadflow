import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL, ensure the database is provisioned');
}

const DATABASE_URL = process.env.DATABASE_URL;
const isPostgres =
  DATABASE_URL.startsWith('postgresql://') || DATABASE_URL.startsWith('postgres://');

export default defineConfig({
  // Use dialect-specific schema: schema-pg.ts for Postgres, schema.ts for SQLite
  out: isPostgres ? './migrations-pg' : './migrations',
  schema: isPostgres ? './shared/schema-pg.ts' : './shared/schema.ts',
  dialect: isPostgres ? 'postgresql' : 'sqlite',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
