/**
 * Departamentalização do RAG por repositório.
 *
 * Esta suíte garante o invariante introduzido pela migration
 * `0018_add_repo_full_name`: a recuperação do RefinementRAGService nunca
 * pode devolver chunks de um repositório diferente do solicitado, mesmo
 * quando outros documentos casariam textualmente com a query.
 *
 * É a barreira contratual contra cross-repo leakage — se este teste
 * quebrar, qualquer agente refinando uma demanda corre risco de receber
 * histórico de outra iniciativa como contexto.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before importing the service so vi.mock hoists them
// above the import resolution.
vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../server/services/embedding-service', () => ({
  embeddingService: {
    getEmbedding: vi.fn().mockRejectedValue(new Error('disabled in test')),
    getEmbeddings: vi.fn().mockResolvedValue([]),
    serializeEmbedding: vi.fn().mockReturnValue('[]'),
    deserializeEmbedding: vi.fn().mockReturnValue([]),
    cosineSimilarity: vi.fn().mockReturnValue(0),
  },
}));

import { RefinementRAGService } from '../server/services/refinement-rag';
import { dbRun } from '../server/utils/db-utils';

interface TestRow {
  source_key: string;
  demand_id: number | null;
  doc_type: 'PRD' | 'Tasks' | 'ChatHistory';
  content: string;
  repo_full_name: string | null;
}

async function seedDocuments(db: any, rows: TestRow[]): Promise<void> {
  for (const row of rows) {
    await dbRun(
      db,
      sql`
        INSERT INTO refinement_rag_documents (id, source_key, demand_id, doc_type, content, repo_full_name, embedding, updated_at)
        VALUES (${row.source_key}, ${row.source_key}, ${row.demand_id}, ${row.doc_type}, ${row.content}, ${row.repo_full_name}, ${'[]'}, ${Date.now()})
      `,
    );
  }
}

describe('RefinementRAGService — departmentalização por repositório', () => {
  let sqliteDb: Database.Database | null = null;

  // Esta suíte testa isolamento de ESCOPO, não relevância. O mock de
  // embeddings devolve similaridade 0, então o piso da spec 029 filtraria
  // tudo — desligamos via kill switch para manter o invariante sob teste.
  beforeEach(() => {
    process.env.REFINEMENT_RAG_MIN_SIMILARITY = '0';
  });

  afterEach(() => {
    delete process.env.REFINEMENT_RAG_MIN_SIMILARITY;
    sqliteDb?.close();
    sqliteDb = null;
  });

  function makeService(): { service: RefinementRAGService; db: any } {
    const sqlite = new Database(':memory:');
    sqliteDb = sqlite;
    const db = drizzle(sqlite);
    const service = new RefinementRAGService(db as any);
    return { service, db };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isola o recall ao repositório solicitado e ignora documentos de outros repos', async () => {
    const { service, db } = makeService();

    await seedDocuments(db, [
      {
        source_key: 'PRD_1_aaa.md',
        demand_id: 1,
        doc_type: 'PRD',
        content: 'integração de pagamento via cartão de crédito stripe',
        repo_full_name: 'acme/payments',
      },
      {
        source_key: 'PRD_2_bbb.md',
        demand_id: 2,
        doc_type: 'PRD',
        content: 'integração de pagamento via boleto bradesco',
        repo_full_name: 'acme/checkout',
      },
      {
        source_key: 'PRD_3_ccc.md',
        demand_id: 3,
        doc_type: 'PRD',
        content: 'tela de cadastro de cliente',
        repo_full_name: 'other-org/crm',
      },
    ]);

    const matches = await service.retrieve('integração pagamento', 4, {
      repoFullName: 'acme/payments',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].sourceKey).toBe('PRD_1_aaa.md');
    expect(matches[0].repoFullName).toBe('acme/payments');
    // Sanity: o documento de acme/checkout ranquearia altíssimo se não fosse o filtro.
    expect(matches.find((m) => m.repoFullName === 'acme/checkout')).toBeUndefined();
  });

  it('exclui documentos globais (repo_full_name NULL) por padrão', async () => {
    const { service, db } = makeService();

    await seedDocuments(db, [
      {
        source_key: 'PRD_1_aaa.md',
        demand_id: 1,
        doc_type: 'PRD',
        content: 'workflow de aprovação',
        repo_full_name: 'acme/payments',
      },
      {
        source_key: 'PRD_99_legacy.md', // gitleaks:allow -- synthetic database field
        demand_id: 99,
        doc_type: 'PRD',
        content: 'workflow de aprovação clássico (legado sem repo)',
        repo_full_name: null,
      },
    ]);

    const matches = await service.retrieve('workflow aprovação', 4, {
      repoFullName: 'acme/payments',
    });

    expect(matches.map((m) => m.sourceKey)).toEqual(['PRD_1_aaa.md']);
  });

  it('inclui documentos globais quando explicitamente solicitado via includeGlobal=true', async () => {
    const { service, db } = makeService();

    await seedDocuments(db, [
      {
        source_key: 'PRD_1_aaa.md',
        demand_id: 1,
        doc_type: 'PRD',
        content: 'workflow de aprovação',
        repo_full_name: 'acme/payments',
      },
      {
        source_key: 'PRD_99_legacy.md', // gitleaks:allow -- synthetic database field
        demand_id: 99,
        doc_type: 'PRD',
        content: 'workflow de aprovação clássico (legado sem repo)',
        repo_full_name: null,
      },
    ]);

    const matches = await service.retrieve('workflow aprovação', 4, {
      repoFullName: 'acme/payments',
      includeGlobal: true,
    });

    const sources = matches.map((m) => m.sourceKey).sort();
    expect(sources).toEqual(['PRD_1_aaa.md', 'PRD_99_legacy.md']);
  });

  it('quando a demanda atual não tem repo, recupera apenas globais (sem vazar entre iniciativas)', async () => {
    const { service, db } = makeService();

    await seedDocuments(db, [
      {
        source_key: 'PRD_1_aaa.md',
        demand_id: 1,
        doc_type: 'PRD',
        content: 'workflow de aprovação',
        repo_full_name: 'acme/payments',
      },
      {
        source_key: 'PRD_99_legacy.md', // gitleaks:allow -- synthetic database field
        demand_id: 99,
        doc_type: 'PRD',
        content: 'workflow de aprovação genérico',
        repo_full_name: null,
      },
    ]);

    const matches = await service.retrieve('workflow aprovação', 4, {
      // demand sem repo → scope.repoFullName ausente
    });

    expect(matches.map((m) => m.sourceKey)).toEqual(['PRD_99_legacy.md']);
  });
});
