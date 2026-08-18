#!/usr/bin/env node

import Database from 'better-sqlite3';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[public-db] DATABASE_URL is required');
  process.exit(1);
}

if (/^postgres(?:ql)?:\/\//i.test(databaseUrl) || databaseUrl === ':memory:') {
  console.error('[public-db] validation requires the isolated SQLite database');
  process.exit(1);
}

const requiredTables = ['demands', 'files', 'agent_jobs'];
let database;

try {
  database = new Database(databaseUrl, { readonly: true, fileMustExist: true });
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const tables = new Set(rows.map((row) => row.name));
  const missing = requiredTables.filter((table) => !tables.has(table));

  if (missing.length > 0) {
    console.error(`[public-db] missing required tables: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`[public-db] OK: ${requiredTables.length} required tables found`);
  }
} catch (error) {
  console.error('[public-db] unable to verify the isolated SQLite schema');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database?.close();
}
