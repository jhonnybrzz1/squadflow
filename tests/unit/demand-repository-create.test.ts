import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.STORAGE = 'db';
  process.env.DATABASE_URL = 'sqlite.db';
  // CRÍTICO-01: sob teste a política troca `sqlite.db` por um banco isolado.
  // Este teste exercita a transação real contra o schema já provisionado do
  // banco local, então declara o opt-in explicitamente. Ele cria e apaga as
  // próprias demandas por título (ver cleanupByTitle) — nenhum outro teste
  // deve usar este opt-in sem a mesma disciplina de limpeza.
  process.env.ALLOW_REAL_DB_IN_TESTS = 'true';
});

import { demandRepository } from '../../server/repositories/demand-repository';
import { storage } from '../../server/storage';
import type { InsertDemand, InsertFile } from '@shared/schema';

async function cleanupByTitle(title: string) {
  const all = await storage.getAllDemands();
  for (const demand of all) {
    if (demand.title === title) {
      await storage.deleteDemand(demand.id);
    }
  }
}

describe('DemandRepository.create — transação atômica (spec 10151)', () => {
  const TITLE = 'Teste atômico DemandRepository 10151';
  const ROLLBACK_TITLE = 'Teste rollback DemandRepository 10151';

  beforeAll(async () => {
    await cleanupByTitle(TITLE);
    await cleanupByTitle(ROLLBACK_TITLE);
  });

  afterEach(async () => {
    await cleanupByTitle(TITLE);
    await cleanupByTitle(ROLLBACK_TITLE);
  });

  // O opt-in vale só para este arquivo: `process.env` é compartilhado pelos
  // arquivos que rodam no mesmo worker do Vitest.
  afterAll(() => {
    delete process.env.ALLOW_REAL_DB_IN_TESTS;
  });

  it('cria demanda, arquivos e roundtableConfig em uma única transação', async () => {
    const demand = await demandRepository.create(
      {
        title: TITLE,
        description: 'Descrição enriquecida',
        originalDescription: 'Descrição original',
        type: 'melhoria',
        priority: 'alta',
        domain: 'padrao',
        repoFullName: 'owner/repo',
      } as InsertDemand,
      {
        files: [
          {
            demandId: null,
            filename: 'anexo.txt',
            originalName: 'anexo.txt',
            mimeType: 'text/plain',
            size: 12,
            path: '/tmp/anexo.txt',
          } as InsertFile,
        ],
        roundtableConfig: { agentIds: ['po', 'tl'], maxRounds: 2 },
      },
    );

    expect(demand.id).toBeDefined();
    expect(demand.title).toBe(TITLE);
    expect(demand.roundtableConfig).toEqual({ agentIds: ['po', 'tl'], maxRounds: 2 });

    const files = await storage.getFilesByDemandId(demand.id);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('anexo.txt');
  });

  it('rollback atômico: falha no insert de arquivo não persiste demanda', async () => {
    const corruptFile = {
      demandId: null,
      // `filename` NOT NULL no schema — força falha no insert de files
      filename: null,
      originalName: 'anexo.txt',
      mimeType: 'text/plain',
      size: 12,
      path: '/tmp/anexo.txt',
    } as unknown as InsertFile;

    await expect(
      demandRepository.create(
        {
          title: ROLLBACK_TITLE,
          description: 'Descrição',
          originalDescription: 'Original',
          type: 'bug',
          priority: 'alta',
        } as InsertDemand,
        {
          files: [corruptFile],
          roundtableConfig: { agentIds: ['po'], maxRounds: 1 },
        },
      ),
    ).rejects.toThrow();

    const all = await storage.getAllDemands();
    expect(all.some((d) => d.title === ROLLBACK_TITLE)).toBe(false);
  });
});
