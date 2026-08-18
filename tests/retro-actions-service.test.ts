/**
 * Demanda 10092 — evidência + ciclo de ações da retrospectiva.
 * SQLite real (`:memory:`): não mocka o banco que a feature introduz.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  retroActionsService,
  __setRetroActionsRunnerForTests,
  computeDiffPercent,
  computeSuccessMet,
} from '../server/services/retro-actions-service';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite);
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

const SNAPSHOT = {
  periodStart: '2026-07-01',
  periodEnd: '2026-07-23',
  demands: 10,
  completed: 8,
  failed: 2,
  tokens: 1000,
  cost: 2.5,
};

afterEach(() => __setRetroActionsRunnerForTests(null));

describe('computeDiffPercent — proteção contra baseline inválido', () => {
  it('calcula a variação percentual normal', () => {
    expect(computeDiffPercent(1000, 800)).toBe(-20);
  });
  it('devolve null (não Infinity) quando o baseline é zero', () => {
    expect(computeDiffPercent(0, 800)).toBeNull();
  });
  it('devolve null quando falta baseline ou medição posterior', () => {
    expect(computeDiffPercent(null, 800)).toBeNull();
    expect(computeDiffPercent(1000, null)).toBeNull();
  });
});

describe('computeSuccessMet — nunca gravado, sempre computado', () => {
  it('tokens: queda de 20% atinge o limiar', () => {
    expect(computeSuccessMet('tokens', -20, null)).toBe(true);
    expect(computeSuccessMet('tokens', -19, null)).toBe(false);
  });
  it('custo usa limiar próprio (15%)', () => {
    expect(computeSuccessMet('cost', -15, null)).toBe(true);
  });
  it('sem diff não há veredito', () => {
    expect(computeSuccessMet('tokens', null, null)).toBeNull();
  });
  it('critério livre devolve null (avaliação é humana, não inferida de texto)', () => {
    expect(computeSuccessMet('tokens', -50, 'time reportou menos retrabalho')).toBeNull();
  });
  it('métrica desconhecida não inventa limiar', () => {
    expect(computeSuccessMet('metrica_nova', -90, null)).toBeNull();
  });
});

describe('RetroActionsService', () => {
  it('primeira retro não tem ações — lista vazia, sem erro', async () => {
    const sqlite = new Database(':memory:');
    __setRetroActionsRunnerForTests(makeRunner(sqlite));
    const { id } = await retroActionsService.createRetrospective(SNAPSHOT);
    expect(await retroActionsService.listActions(id)).toEqual([]);
  });

  it('captura metric_before do snapshot, não de input manual', async () => {
    const sqlite = new Database(':memory:');
    __setRetroActionsRunnerForTests(makeRunner(sqlite));
    const { id } = await retroActionsService.createRetrospective(SNAPSHOT);

    const created = await retroActionsService.createAction(id, {
      description: 'reduzir tokens do roundtable',
      metricKey: 'tokens',
      owner: 'tech_lead',
    });
    expect(created?.metricBefore).toBe(1000); // veio do snapshot
    expect(created?.retroId).toBe(id);
    expect(created?.diffPercent).toBeNull();

    const updated = await retroActionsService.setMetricAfter(id, created!.id, 800);
    expect(updated?.diffPercent).toBe(-20);
    expect(updated?.successMet).toBe(true);

    const [action] = await retroActionsService.listActions(id);
    expect(action.diffPercent).toBe(-20);
    expect(action.successMet).toBe(true);
    expect(action.owner).toBe('tech_lead');
  });

  it('métrica ausente no snapshot vira metric_before null e diff null (não 500)', async () => {
    const sqlite = new Database(':memory:');
    __setRetroActionsRunnerForTests(makeRunner(sqlite));
    const { id } = await retroActionsService.createRetrospective(SNAPSHOT);

    const created = await retroActionsService.createAction(id, {
      description: 'melhorar latência',
      metricKey: 'latency', // não existe no snapshot
    });
    expect(created?.metricBefore).toBeNull();

    const updated = await retroActionsService.setMetricAfter(id, created!.id, 50);
    expect(updated?.diffPercent).toBeNull();
    expect(updated?.successMet).toBeNull();

    const [action] = await retroActionsService.listActions(id);
    expect(action.diffPercent).toBeNull();
    expect(action.successMet).toBeNull();
  });

  it('ação em retro inexistente devolve null (vira 404 na rota)', async () => {
    const sqlite = new Database(':memory:');
    __setRetroActionsRunnerForTests(makeRunner(sqlite));
    const r = await retroActionsService.createAction('nao-existe', {
      description: 'x',
      metricKey: 'tokens',
    });
    expect(r).toBeNull();
  });

  it('setMetricAfter em ação de outra retro devolve null (proteção de escopo)', async () => {
    const sqlite = new Database(':memory:');
    __setRetroActionsRunnerForTests(makeRunner(sqlite));
    const { id } = await retroActionsService.createRetrospective(SNAPSHOT);
    const created = await retroActionsService.createAction(id, {
      description: 'reduzir tokens',
      metricKey: 'tokens',
    });
    const updated = await retroActionsService.setMetricAfter('outro-retro', created!.id, 800);
    expect(updated).toBeNull();
  });
});
