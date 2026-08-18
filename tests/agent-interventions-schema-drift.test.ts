/**
 * Bug: GET /api/anti-overengineering/metrics devolvia 500 com
 * "no such column: dias_economizados".
 *
 * A suíte existente (`agent-intervention.test.ts`) mocka o `dbHelper`, então
 * passava verde com o banco quebrado — nenhum teste exercitava SQL real. Aqui
 * usamos SQLite de verdade, com o DDL EXATO que o Drizzle cria em produção
 * (sem a coluna), que é a condição que produzia o erro.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';

/**
 * DDL real da tabela em produção, copiado de `sqlite_master`. Repare que
 * `dias_economizados` NÃO está aqui: o Drizzle gera a tabela a partir de
 * `shared/schema.ts`, que não declara a coluna.
 */
const DRIZZLE_DDL = `
CREATE TABLE agent_interventions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  demand_id integer NOT NULL,
  pontos_overengineering text NOT NULL,
  escopo_reduzido text NOT NULL,
  roi_estimado text NOT NULL,
  esforco_original_dias real,
  esforco_reduzido_dias real,
  override_applied integer DEFAULT false NOT NULL,
  override_by text,
  override_justification text,
  modelo text,
  criado_em integer NOT NULL
)`;

/** Mesma expressão de `DIAS_ECONOMIZADOS_EXPR` em agent-intervention-service.ts. */
const EXPR = `
  CASE
    WHEN esforco_original_dias IS NOT NULL AND esforco_reduzido_dias IS NOT NULL
    THEN esforco_original_dias - esforco_reduzido_dias
    ELSE NULL
  END`;

let db: Database.Database;

beforeEach(() => {
  db?.close();
  db = new Database(':memory:');
  db.exec(DRIZZLE_DDL);

  const insert = db.prepare(`
    INSERT INTO agent_interventions
      (demand_id, pontos_overengineering, escopo_reduzido, roi_estimado,
       esforco_original_dias, esforco_reduzido_dias, override_applied, criado_em)
    VALUES (?, '[]', 'escopo', '3:1', ?, ?, ?, ?)
  `);
  insert.run(1, 10, 4, 0, 1700000000); // 6 dias economizados
  insert.run(1, 5, 2, 1, 1700000100); // 3 dias, com override
  insert.run(2, null, null, 0, 1700000200); // sem estimativas → null
});

afterAll(() => db?.close());

describe('schema drift: dias_economizados não existe no banco', () => {
  it('reproduz o bug — a consulta antiga falha contra o schema real', () => {
    expect(() => db.prepare('SELECT id, dias_economizados FROM agent_interventions').all()).toThrow(
      /no such column: dias_economizados/,
    );
  });

  it('a consulta corrigida roda e calcula o valor derivado', () => {
    const rows = db
      .prepare(
        `SELECT id, ${EXPR} AS dias_economizados, override_applied, criado_em
         FROM agent_interventions ORDER BY criado_em ASC`,
      )
      .all() as Array<{ dias_economizados: number | null }>;

    expect(rows).toHaveLength(3);
    expect(rows[0].dias_economizados).toBe(6);
    expect(rows[1].dias_economizados).toBe(3);
  });

  it('devolve null (não zero) quando falta alguma estimativa', () => {
    const row = db
      .prepare(`SELECT ${EXPR} AS dias_economizados FROM agent_interventions WHERE demand_id = 2`)
      .get() as { dias_economizados: number | null };

    // Distinção que importa: "não foi medido" (null) não é "economizou zero".
    expect(row.dias_economizados).toBeNull();
  });

  it('SELECT * também traz o valor derivado', () => {
    const rows = db
      .prepare(
        `SELECT *, ${EXPR} AS dias_economizados FROM agent_interventions WHERE demand_id = 1`,
      )
      .all() as Array<{ dias_economizados: number | null; roi_estimado: string }>;

    expect(rows).toHaveLength(2);
    // Antes da correção, SELECT * não trazia a coluna e o `?? null` do mapRow
    // devolvia diasEconomizados: null em silêncio, sem erro nenhum.
    expect(rows.map((r) => r.dias_economizados).sort()).toEqual([3, 6]);
    expect(rows[0].roi_estimado).toBe('3:1');
  });

  it('agrega corretamente para o dashboard de métricas', () => {
    const { total } = db.prepare(`SELECT SUM(${EXPR}) AS total FROM agent_interventions`).get() as {
      total: number | null;
    };

    expect(total).toBe(9);
  });

  it('banco vazio devolve agregado nulo sem quebrar', () => {
    db.exec('DELETE FROM agent_interventions');

    const rows = db
      .prepare(`SELECT id, ${EXPR} AS dias_economizados FROM agent_interventions`)
      .all();

    expect(rows).toEqual([]);
  });
});

describe('a correção não depende da coluna existir', () => {
  it('funciona igual quando o banco TEM a coluna gerada', () => {
    // Bancos criados pela migration 0017 (ou pelo ensureTable antigo) têm a
    // coluna como GENERATED STORED. A expressão precisa continuar válida lá —
    // o alias apenas sombreia a coluna, com o mesmo resultado.
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE agent_interventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        esforco_original_dias REAL,
        esforco_reduzido_dias REAL,
        dias_economizados REAL GENERATED ALWAYS AS (
          CASE WHEN esforco_original_dias IS NOT NULL AND esforco_reduzido_dias IS NOT NULL
          THEN esforco_original_dias - esforco_reduzido_dias ELSE NULL END
        ) STORED
      )`);
    legacy
      .prepare(
        'INSERT INTO agent_interventions (esforco_original_dias, esforco_reduzido_dias) VALUES (?, ?)',
      )
      .run(10, 4);

    const row = legacy
      .prepare(`SELECT ${EXPR} AS dias_economizados FROM agent_interventions`)
      .get() as { dias_economizados: number };

    expect(row.dias_economizados).toBe(6);
    legacy.close();
  });

  it('SQLite recusa adicionar a coluna gerada via ALTER TABLE', () => {
    // Justifica não seguir o ALTER TABLE sugerido: além de o db:push desfazer,
    // o SQLite nem aceita adicionar coluna STORED depois da criação.
    expect(() =>
      db.exec(`
        ALTER TABLE agent_interventions ADD COLUMN dias_economizados REAL
        GENERATED ALWAYS AS (esforco_original_dias - esforco_reduzido_dias) STORED`),
    ).toThrow();
  });
});
