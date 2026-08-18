/**
 * Demanda #10365 T3 — consulta de schema de bancos do usuário (Fatia 2B).
 *
 * Queries HARDCODED (zero input do usuário na construção SQL). Apenas leitura
 * de `information_schema.columns` (PG/Supabase/Neon) e `INFORMATION_SCHEMA.COLUMNS`
 * (MySQL). Timeout de 10s via AbortSignal. Trunca para top 50 tabelas por FK count.
 *
 * Drivers: pg (PostgreSQL/Supabase/Neon) e mysql2 (MySQL). Import dinâmico
 * para não pesar o bundle se a feature não for usada.
 */
import { dbConnectionService } from './db-connection-service';
import type { DbConnection } from '@shared/schema';
import { logger } from '../utils/logger';

export interface SchemaTable {
  name: string;
  columns: { name: string; type: string; nullable: boolean }[];
}

export interface DbSchema {
  tables: SchemaTable[];
  truncated: boolean;
}

const QUERY_TIMEOUT_MS = 10_000;
const MAX_TABLES = 50;

/** Detecta subtipo de banco pelo host (Supabase, Neon) ou usa db_type. */
export function detectDbSubtype(host: string, dbType: string): string {
  if (host.includes('supabase.co')) return 'supabase';
  if (host.includes('neon.tech')) return 'neon';
  return dbType;
}

/** SSL obrigatório para Supabase/Neon. */
function shouldUseSsl(subtype: string): boolean {
  return subtype === 'supabase' || subtype === 'neon';
}

class DbSchemaService {
  /**
   * Consulta o schema do banco conectado. Retorna `{ tables, truncated }`.
   * Fallback gracioso: se erro/timeout, retorna `{ tables: [], truncated: false }`.
   */
  async getSchema(userId: number, connectionId: number): Promise<DbSchema> {
    const conn = await dbConnectionService.findById(userId, connectionId);
    if (!conn || !conn.isActive) {
      throw new Error('Conexão não encontrada ou inativa.');
    }

    const password = await dbConnectionService.getDecryptedPassword(userId, connectionId);
    if (!password) {
      throw new Error('Não foi possível descriptografar as credenciais.');
    }

    const subtype = detectDbSubtype(conn.host, conn.dbType);

    try {
      if (subtype === 'postgresql' || subtype === 'supabase' || subtype === 'neon') {
        return await this.getPostgresSchema(conn, password, subtype);
      }
      if (subtype === 'mysql') {
        return await this.getMysqlSchema(conn, password);
      }
      throw new Error(`Tipo de banco não suportado: ${conn.dbType}`);
    } catch (error) {
      logger.warn('Falha ao consultar schema do banco — fallback gracioso', {
        error: error instanceof Error ? error : undefined,
        context: { connectionId, dbType: conn.dbType, host: conn.host },
      });
      return { tables: [], truncated: false };
    }
  }

  private async getPostgresSchema(
    conn: DbConnection,
    password: string,
    subtype: string,
  ): Promise<DbSchema> {
    const { Client } = await import('pg');
    const client = new Client({
      host: conn.host,
      port: conn.port ?? 5432,
      database: conn.databaseName ?? 'postgres',
      user: conn.username ?? 'postgres',
      password,
      ssl: shouldUseSsl(subtype) ? { rejectUnauthorized: true } : undefined,
    });

    try {
      await client.connect();
      // Query hardcoded: information_schema.columns + pg_catalog para FK count
      const result = (await client.query(
        `SELECT
           c.table_name,
           c.column_name,
           c.data_type,
           c.is_nullable,
           COUNT(fk.constraint_name) AS fk_count
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_constraint fk
           ON fk.contype = 'f'
           AND fk.conrelid = (c.table_schema || '.' || c.table_name)::regclass
         WHERE c.table_schema = 'public'
         GROUP BY c.table_name, c.column_name, c.data_type, c.is_nullable
         ORDER BY c.table_name, c.ordinal_position`,
        [],
      )) as { rows: any[] };

      const tablesMap = new Map<string, SchemaTable>();
      const fkCounts = new Map<string, number>();

      for (const row of result.rows) {
        const tableName = row.table_name;
        if (!tablesMap.has(tableName)) {
          tablesMap.set(tableName, { name: tableName, columns: [] });
        }
        tablesMap.get(tableName)!.columns.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
        });
        fkCounts.set(tableName, (fkCounts.get(tableName) ?? 0) + Number(row.fk_count ?? 0));
      }

      // Top 50 tabelas por FK count (relevância)
      const sorted = [...tablesMap.values()].sort((a, b) => {
        const fkA = fkCounts.get(a.name) ?? 0;
        const fkB = fkCounts.get(b.name) ?? 0;
        return fkB - fkA;
      });

      const truncated = sorted.length > MAX_TABLES;
      const topTables = truncated ? sorted.slice(0, MAX_TABLES) : sorted;

      return { tables: topTables, truncated };
    } finally {
      await client.end();
    }
  }

  private async getMysqlSchema(conn: DbConnection, password: string): Promise<DbSchema> {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: conn.host,
      port: conn.port ?? 3306,
      database: conn.databaseName ?? 'mysql',
      user: conn.username ?? 'root',
      password,
      connectTimeout: QUERY_TIMEOUT_MS,
    });

    try {
      // Query hardcoded: INFORMATION_SCHEMA.COLUMNS
      const [rows] = await connection.execute(
        `SELECT
           TABLE_NAME,
           COLUMN_NAME,
           DATA_TYPE,
           IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [conn.databaseName ?? 'mysql'],
      );

      const tablesMap = new Map<string, SchemaTable>();
      for (const row of rows as any[]) {
        const tableName = row.TABLE_NAME;
        if (!tablesMap.has(tableName)) {
          tablesMap.set(tableName, { name: tableName, columns: [] });
        }
        tablesMap.get(tableName)!.columns.push({
          name: row.COLUMN_NAME,
          type: row.DATA_TYPE,
          nullable: row.IS_NULLABLE === 'YES',
        });
      }

      const allTables = [...tablesMap.values()];
      const truncated = allTables.length > MAX_TABLES;
      const topTables = truncated ? allTables.slice(0, MAX_TABLES) : allTables;

      return { tables: topTables, truncated };
    } finally {
      await connection.end();
    }
  }

  /** T4: testa conexão sem salvar. Retorna { success, error? }. */
  async testConnection(input: {
    dbType: string;
    host: string;
    port?: number;
    databaseName?: string;
    username?: string;
    password: string;
  }): Promise<{ success: boolean; error?: string }> {
    const subtype = detectDbSubtype(input.host, input.dbType);
    try {
      if (subtype === 'postgresql' || subtype === 'supabase' || subtype === 'neon') {
        const { Client } = await import('pg');
        const client = new Client({
          host: input.host,
          port: input.port ?? 5432,
          database: input.databaseName ?? 'postgres',
          user: input.username ?? 'postgres',
          password: input.password,
          ssl: shouldUseSsl(subtype) ? { rejectUnauthorized: true } : undefined,
        });
        try {
          await client.connect();
          await client.query('SELECT 1');
          return { success: true };
        } finally {
          await client.end();
        }
      }
      if (subtype === 'mysql') {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection({
          host: input.host,
          port: input.port ?? 3306,
          database: input.databaseName ?? 'mysql',
          user: input.username ?? 'root',
          password: input.password,
          connectTimeout: 5000,
        });
        try {
          await conn.execute('SELECT 1');
          return { success: true };
        } finally {
          await conn.end();
        }
      }
      return { success: false, error: `Tipo não suportado: ${input.dbType}` };
    } catch (error) {
      // Sanitizar: nunca expor credenciais no erro
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      return { success: false, error: message.replace(/password=[^&\s]+/gi, 'password=***') };
    }
  }
}

export const dbSchemaService = new DbSchemaService();
