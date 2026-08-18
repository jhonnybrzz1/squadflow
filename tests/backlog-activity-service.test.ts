/**
 * Demanda 10096 — backlog de atividades: criação idempotente + máquina de estados.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  backlogActivityService,
  __setBacklogDbForTests,
  isValidTransition,
} from '../server/services/backlog-activity-service';

// A08: o serviço passou a usar Drizzle tipado, então o seam recebe a própria
// instância — os testes seguem contra SQLite real, agora sem SQL cru no meio.
function makeDb(sqlite: Database.Database) {
  return drizzle(sqlite) as unknown as Parameters<typeof __setBacklogDbForTests>[0];
}

afterEach(() => __setBacklogDbForTests(null));

describe('isValidTransition — máquina de estados fechada', () => {
  it('permite avançar um degrau por vez', () => {
    expect(isValidTransition('em_desenvolvimento', 'aguardando_revisao')).toBe(true);
    expect(isValidTransition('aguardando_revisao', 'pronto')).toBe(true);
    expect(isValidTransition('pronto', 'em_producao')).toBe(true);
  });
  it('rejeita pular a revisão (dev -> produção)', () => {
    expect(isValidTransition('em_desenvolvimento', 'em_producao')).toBe(false);
  });
  it('reprovar volta pro desenvolvimento', () => {
    expect(isValidTransition('aguardando_revisao', 'em_desenvolvimento')).toBe(true);
  });
  it('em_producao é terminal (rollback é outro fluxo)', () => {
    expect(isValidTransition('em_producao', 'pronto')).toBe(false);
  });
});

describe('BacklogActivityService', () => {
  it('cria a atividade e é idempotente por demanda', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({
      demandId: 42,
      title: 'X',
      hasPrd: true,
      hasTasks: true,
    });
    // Reemitir o evento não duplica.
    await backlogActivityService.createFromHandoff({ demandId: 42, title: 'X-again' });

    const list = await backlogActivityService.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('em_desenvolvimento');
    expect(list[0].hasPrd).toBe(true);
    expect(list[0].title).toBe('X'); // primeira venceu, não sobrescreveu
  });

  it('transição válida atualiza o status', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));
    await backlogActivityService.createFromHandoff({ demandId: 1, title: 'A' });
    const [a] = await backlogActivityService.list();

    const r = await backlogActivityService.transition(a.id, 'aguardando_revisao');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.activity.status).toBe('aguardando_revisao');
  });

  it('transição inválida é rejeitada, não "consertada"', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));
    await backlogActivityService.createFromHandoff({ demandId: 1, title: 'A' });
    const [a] = await backlogActivityService.list();

    const r = await backlogActivityService.transition(a.id, 'em_producao');
    expect(r.ok).toBe(false);
    // Status permaneceu inalterado.
    const [after] = await backlogActivityService.list();
    expect(after.status).toBe('em_desenvolvimento');
  });

  it('transição em atividade inexistente devolve not_found', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));
    const r = await backlogActivityService.transition('nao-existe', 'pronto');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});

/**
 * Auditoria 2026-08-01 (A08): `created_at` é TEXT com default `datetime('now')`,
 * mas a afinidade TEXT do SQLite converte número em string ao gravar — o banco
 * real acumulou 124 linhas em ISO e 5 em epoch-string. Como `ORDER BY
 * created_at` compara lexicograficamente, '1784896608' < '2026-…', e as linhas
 * em epoch afundavam para o fim da listagem independentemente da data.
 */
describe('normalização de datas epoch-string (A08)', () => {
  it('ensureSchema converte epoch para ISO e restaura a ordem cronológica', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    // Cria o schema antes de semear, sem depender da ordem interna do serviço.
    await backlogActivityService.createFromHandoff({ demandId: 1, title: 'recente' });

    // Semeia uma linha "antiga" no formato quebrado: 2026-07-24, mas em epoch.
    sqlite
      .prepare(
        `INSERT INTO backlog_activities (id, demand_id, title, created_at, updated_at)
         VALUES ('legado', 99, 'antiga', '1784896608', '1784896608')`,
      )
      .run();

    // Antes da normalização a linha antiga ganharia a ordenação DESC por ser
    // lexicograficamente maior? Não — é MENOR, então some para o fim.
    __setBacklogDbForTests(makeDb(sqlite));
    backlogActivityService.resetSchemaCacheForTests();
    await backlogActivityService.list(); // dispara ensureSchema -> normaliza

    const row = sqlite
      .prepare(`SELECT created_at FROM backlog_activities WHERE id = 'legado'`)
      .get() as { created_at: string };

    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(row.created_at.startsWith('2026-07-24')).toBe(true);

    // E a ordenação passa a refletir a cronologia real: a antiga fica por último.
    const list = await backlogActivityService.list();
    expect(list.at(-1)?.title).toBe('antiga');
  });

  it('é idempotente: rodar de novo não altera linhas já em ISO', async () => {
    const sqlite = new Database(':memory:');
    __setBacklogDbForTests(makeDb(sqlite));

    await backlogActivityService.createFromHandoff({ demandId: 7, title: 'A' });
    const antes = await backlogActivityService.findByDemandId(7);

    backlogActivityService.resetSchemaCacheForTests();
    await backlogActivityService.list();
    const depois = await backlogActivityService.findByDemandId(7);

    expect(depois?.createdAt).toBe(antes?.createdAt);
  });
});
