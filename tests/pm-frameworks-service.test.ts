/**
 * Demanda 10091 — catálogo de frameworks de Product Discovery.
 * SQLite real (`:memory:`) — não mocka o banco que esta feature introduz.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  pmFrameworksService,
  __setPmFrameworksRunnerForTests,
} from '../server/services/pm-frameworks-service';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite);
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

afterEach(() => __setPmFrameworksRunnerForTests(null));

describe('PmFrameworksService', () => {
  it('cria schema idempotentemente e faz upsert por slug', async () => {
    const sqlite = new Database(':memory:');
    __setPmFrameworksRunnerForTests(makeRunner(sqlite));
    await pmFrameworksService.ensureSchema();
    await pmFrameworksService.ensureSchema(); // idempotente

    await pmFrameworksService.upsert({
      slug: 'deepsearch',
      name: 'DeepSearch',
      content: '# DeepSearch\nv1',
      description: 'Framework de discovery',
    });
    // Reimportar o mesmo slug ATUALIZA, não duplica.
    await pmFrameworksService.upsert({
      slug: 'deepsearch',
      name: 'DeepSearch',
      content: '# DeepSearch\nv2',
      version: '2',
    });

    const all = await pmFrameworksService.list();
    expect(all).toHaveLength(1);

    const found = await pmFrameworksService.findBySlug('deepsearch');
    expect(found?.content).toContain('v2');
    expect(found?.version).toBe('2');
  });

  it('list omite o content (payload leve) e findBySlug inexistente retorna null', async () => {
    const sqlite = new Database(':memory:');
    __setPmFrameworksRunnerForTests(makeRunner(sqlite));
    await pmFrameworksService.upsert({ slug: 'a', name: 'A', content: 'conteudo A' });
    await pmFrameworksService.upsert({ slug: 'b', name: 'B', content: 'conteudo B' });

    const list = await pmFrameworksService.list();
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty('content');
    // ordenado por nome
    expect(list.map((f) => f.slug)).toEqual(['a', 'b']);

    expect(await pmFrameworksService.findBySlug('nao-existe')).toBeNull();
  });
});
