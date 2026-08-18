import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db as defaultDb, type DbClient, isPostgres, dbHelper } from '../db';
import { demandRepository } from '../repositories/demand-repository';
import type { ChatMessage, Demand } from '@shared/schema';
import { dbRun, dbAll } from '../utils/db-utils';
import { logger } from '../utils/logger';
import { resolveDemandRepoFullName } from '../utils/repo-context';
import { embeddingService } from './embedding-service';
import { RetrievalService } from './retrieval-service';
import { vectorSearchService } from './vector-search';
import { screenAndFormat } from './retrieval-guardrail';
import { detectQueryIntent } from './query-intent';
import { featureFlags } from './feature-flags';
import { queryTypeWeightsService } from './query-type-weights';

const DOCUMENTS_DIR = resolvePath('documents');

/**
 * Piso de relevância default (cosine, pré-rerank) para o RAG de refinamentos.
 * Sem piso, topK=4 injeta "o melhor lixo disponível" mesmo sem histórico
 * relevante — origem do ruído onde agentes citavam demandas alheias (spec 029).
 * Conservador porque o ambiente real usa embeddings locais hash-based, cuja
 * distribuição de similaridade é mais achatada que a de embeddings semânticos.
 */
const DEFAULT_MIN_SIMILARITY = 0.25;

/**
 * Lê `REFINEMENT_RAG_MIN_SIMILARITY` a cada chamada (permite override em teste
 * sem reload de módulo). Fail-safe: inválido ou fora de [0,1] → default.
 * `0` é valor legítimo e desliga o piso (kill switch).
 */
function resolveMinSimilarity(): number {
  const raw = process.env.REFINEMENT_RAG_MIN_SIMILARITY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_SIMILARITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    logger.warn(
      `REFINEMENT_RAG_MIN_SIMILARITY inválida ("${raw}") — usando default ${DEFAULT_MIN_SIMILARITY}`,
    );
    return DEFAULT_MIN_SIMILARITY;
  }
  return parsed;
}

interface RefinementDoc {
  sourceKey: string;
  demandId: number | null;
  docType: 'PRD' | 'Tasks' | 'ChatHistory' | 'Unknown';
  content: string;
  /**
   * Canonical "owner/name" identifying which repository this document
   * belongs to. `null` means "global / unattributable" — those rows are
   * excluded from retrieve() by default to prevent cross-repo leakage.
   */
  repoFullName: string | null;
}

/**
 * Options accepted by retrieve / retrieveHybrid / buildContext.
 *
 * `repoFullName` — when provided, retrieval restricts results to documents
 *   tagged with the same repository. This is the primary mechanism that
 *   prevents one initiative's history from contaminating another's.
 *
 * `includeGlobal` — when true, documents with NULL repo_full_name are also
 *   returned (legacy items that couldn't be attributed to a repo). Defaults
 *   to false to be safe-by-default; the caller has to opt in.
 */
export interface RetrievalScope {
  repoFullName?: string | null;
  includeGlobal?: boolean;
  /** Atribuição de custo do rerank na telemetria (spec 011/auditoria). */
  demandId?: number;
  agentName?: string;
  /** A-1: tipo da consulta para override de pesos híbridos. */
  queryType?: string;
  /** A-1: identificador de sessão para telemetria. */
  sessionId?: string;
}

interface RetrievedRow {
  source_key: string;
  doc_type: string;
  demand_id: number | null;
  repo_full_name: string | null;
  content: string;
}

interface RetrievedRowWithEmbedding extends RetrievedRow {
  embedding: string | null;
}

export class RefinementRAGService {
  private initPromise: Promise<void>;
  private readonly retrievalService: RetrievalService;
  /**
   * In-memory map demandId → repoFullName populated during ingestion. Used
   * to attribute documents-on-disk (which only carry the demandId in their
   * filename) without re-querying the database for every file.
   */
  private demandRepoCache: Map<number, string | null> = new Map();

  private lastIngestedAt = 0;
  private readonly INGEST_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutos

  constructor(private readonly database: DbClient = defaultDb) {
    this.retrievalService = new RetrievalService(database);
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
    await queryTypeWeightsService.ensureSchemaAndSeed();
  }

  async ingestFromDocuments(): Promise<number> {
    await this.initPromise;

    // Performance Fix T3: Debounce to prevent constant DB scans
    const now = Date.now();
    if (now - this.lastIngestedAt < this.INGEST_DEBOUNCE_MS) {
      return 0; // Return early if already ingested recently
    }
    this.lastIngestedAt = now;

    // Refresh the demandId → repoFullName cache once per ingest so freshly
    // inserted demands' artifacts can be attributed correctly.
    await this.refreshDemandRepoCache();

    if (!fs.existsSync(DOCUMENTS_DIR)) {
      return 0;
    }

    const files = fs.readdirSync(DOCUMENTS_DIR).filter((file) => file.endsWith('.md'));
    let ingested = 0;
    let skipped = 0;

    // Spec 10172-hotfix: limita ingestão síncrona para não bloquear o
    // processamento de demandas por minutos/horas quando a API de embeddings
    // estiver lenta. Processa no máximo 20 documentos por batida; o restante
    // fica para a próxima janela de 5 minutos (debounce acima).
    const maxDocsPerIngest = 20;

    for (const file of files) {
      if (ingested >= maxDocsPerIngest) {
        skipped += 1;
        continue;
      }
      const fullPath = path.join(DOCUMENTS_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = this.parseFile(file, content);
      if (!parsed) continue;
      try {
        await this.upsertDocument(parsed);
        ingested += 1;
      } catch (error) {
        logger.warn('Failed to upsert document during ingest', {
          error: error instanceof Error ? error : undefined,
          context: { sourceKey: parsed.sourceKey },
        });
      }
    }

    if (skipped > 0) {
      logger.info('RAG document ingestion capped', {
        context: { ingested, skipped, total: files.length, cap: maxDocsPerIngest },
      });
    }

    const ingestedFromChat = await this.ingestFromDemandChats();
    ingested += ingestedFromChat;

    return ingested;
  }

  /**
   * Keyword-only retrieval. Delegado ao RetrievalService unificado.
   */
  async retrieve(
    query: string,
    topK = 4,
    scope: RetrievalScope = {},
  ): Promise<
    Array<{
      sourceKey: string;
      docType: string;
      demandId: number | null;
      repoFullName: string | null;
      snippet: string;
      score: number;
    }>
  > {
    await this.initPromise;
    const results = await this.retrievalService.retrieve(query, {
      source: 'refinement',
      topK,
      minSimilarity: resolveMinSimilarity(),
      scope,
      useReranking: false,
      queryType: scope.queryType,
      sessionId: scope.sessionId,
    });
    return results.map((r) => ({
      sourceKey: r.sourceKey,
      docType: r.docType,
      demandId: (r.metadata?.demandId as number | null) ?? null,
      repoFullName: r.repoFullName,
      snippet: this.extractSnippet(query, r.content),
      score: r.score,
    }));
  }

  /**
   * Avaliação de RAG (2026-07-26, A-1): apesar do nome, esta busca é
   * puramente semântica (embedding via `RetrievalService`) — não há nenhum
   * componente de busca por palavra-chave/BM25 no pipeline. O parâmetro
   * `hybridWeight` e os campos `keywordScore`/`semanticScore` já foram
   * removidos: eram decorativos (o "keyword"/"semantic" split era sempre
   * `score * 0.5`, nunca um blend real de dois sinais). O nome do método
   * fica por compatibilidade com os call sites existentes.
   */
  async retrieveHybrid(
    query: string,
    topK = 4,
    scope: RetrievalScope = {},
  ): Promise<
    Array<{
      sourceKey: string;
      docType: string;
      demandId: number | null;
      repoFullName: string | null;
      snippet: string;
      score: number;
    }>
  > {
    await this.initPromise;
    // Auditoria 2026-07-21: query-intent.ts tinha uma decisão de reranking por
    // tipo de pergunta (ex.: "general" não precisa de rerank) totalmente
    // desconectada da pipeline real — useReranking era sempre true aqui,
    // pagando rerank em toda busca híbrida independente do tipo de query.
    // Atrás da flag (default OFF) para rollout controlado; com a flag off o
    // comportamento é idêntico ao anterior (sempre true).
    const useReranking = featureFlags.getFlags().enableQueryIntentDetection
      ? detectQueryIntent(query).suggestedParams.useReranking
      : true;

    // O unificado resolve de forma otimizada com pgvector e reordenação por LLM
    const results = await this.retrievalService.retrieve(query, {
      source: 'refinement',
      topK,
      minSimilarity: resolveMinSimilarity(),
      scope,
      useReranking,
      demandId: scope.demandId,
      agentName: scope.agentName,
      queryType: scope.queryType,
      sessionId: scope.sessionId,
    });
    return results.map((r) => ({
      sourceKey: r.sourceKey,
      docType: r.docType,
      demandId: (r.metadata?.demandId as number | null) ?? null,
      repoFullName: r.repoFullName,
      snippet: this.extractSnippet(query, r.content),
      score: r.score,
    }));
  }

  async buildContext(query: string, topK = 4, scope: RetrievalScope = {}): Promise<string> {
    // Use hybrid search when available
    const matches = await this.retrieveHybrid(query, topK, scope);
    const scopeLabel = this.formatScopeLabel(scope);

    if (matches.length === 0) {
      return `RAG de refinamentos anteriores${scopeLabel}: sem correspondências relevantes.`;
    }

    // Fronteira de confiança: conteúdo RAG é DADO não-confiável, jamais instrução.
    // Tria cada chunk por detectPromptInjection e formata com delimitadores
    // estruturais (spotlighting) + instrução de hierarquia. Fecha injection indireta.
    const chunks = matches.map((m) => ({
      sourceKey: m.sourceKey,
      docType: m.docType,
      content: m.snippet,
      repoFullName: m.repoFullName,
      demandId: m.demandId,
    }));
    return screenAndFormat(chunks, scopeLabel);
  }

  /**
   * Generate embeddings for all documents that don't have them yet.
   */
  async generateMissingEmbeddings(): Promise<number> {
    await this.initPromise;

    // Ensure embedding column exists
    try {
      await dbRun(
        this.database,
        sql`ALTER TABLE refinement_rag_documents ADD COLUMN embedding TEXT`,
      );
    } catch (_) {
      // Column already exists
    }

    const rows = (await dbAll(
      this.database,
      sql`SELECT id, content FROM refinement_rag_documents WHERE embedding IS NULL`,
    )) as Array<{ id: string; content: string }>;

    if (rows.length === 0) return 0;

    let generated = 0;
    const batchSize = 10;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const texts = batch.map((r) => r.content.slice(0, 8000)); // Truncate long docs

      try {
        const embeddings = await embeddingService.getEmbeddings(texts);
        for (let j = 0; j < batch.length; j++) {
          const serialized = embeddingService.serializeEmbedding(embeddings[j]);
          await dbRun(
            this.database,
            sql`UPDATE refinement_rag_documents SET embedding = ${serialized} WHERE id = ${batch[j].id}`,
          );
          generated++;
        }
      } catch (error) {
        logger.warn('Failed to generate refinement embeddings', {
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    return generated;
  }

  /**
   * Backfill `repo_full_name` for previously-ingested rows by joining each
   * row's demandId against the cached demand repository map. Returns how
   * many rows were updated. Safe to re-run; documents already attributed
   * keep their value.
   */
  async backfillRepoFullName(): Promise<number> {
    await this.initPromise;
    await this.refreshDemandRepoCache();

    const rows = (await dbAll(
      this.database,
      sql`
        SELECT id, demand_id
        FROM refinement_rag_documents
        WHERE repo_full_name IS NULL AND demand_id IS NOT NULL
      `,
    )) as Array<{ id: string; demand_id: number | null }>;

    let updated = 0;
    for (const row of rows) {
      if (row.demand_id == null) continue;
      const repoFullName = this.demandRepoCache.get(row.demand_id) ?? null;
      if (!repoFullName) continue;
      await dbRun(
        this.database,
        sql`UPDATE refinement_rag_documents SET repo_full_name = ${repoFullName} WHERE id = ${row.id}`,
      );
      updated += 1;
    }
    return updated;
  }

  private parseFile(fileName: string, content: string): RefinementDoc | null {
    const docType = fileName.startsWith('PRD_')
      ? 'PRD'
      : fileName.startsWith('Tasks_')
        ? 'Tasks'
        : 'Unknown';
    const idMatch = fileName.match(/^(?:PRD|Tasks)_(\d+)_/);
    const demandId = idMatch ? Number.parseInt(idMatch[1], 10) : null;
    if (!content.trim()) return null;

    const resolvedDemandId = Number.isFinite(demandId as number) ? demandId : null;
    const repoFullName =
      resolvedDemandId != null ? (this.demandRepoCache.get(resolvedDemandId) ?? null) : null;

    return {
      sourceKey: fileName,
      demandId: resolvedDemandId,
      docType,
      content,
      repoFullName,
    };
  }

  private async ingestFromDemandChats(): Promise<number> {
    const demands = await demandRepository.findAll();
    let ingested = 0;

    for (const demand of demands) {
      const completedMessages = (demand.chatMessages || []).filter(
        (message: ChatMessage) => message.type === 'completed',
      );
      if (completedMessages.length === 0) {
        continue;
      }

      const sourceKey = `CHAT_${demand.id}`;
      const content = this.buildChatContent(demand.title || '', completedMessages);
      await this.upsertDocument({
        sourceKey,
        demandId: demand.id,
        docType: 'ChatHistory',
        content,
        repoFullName: resolveDemandRepoFullName(demand),
      });
      ingested += 1;
    }

    return ingested;
  }

  private buildChatContent(title: string, messages: ChatMessage[]): string {
    // Spec 029: sem "Demanda {id}:" no corpo — agentes ecoavam o id de demandas
    // históricas como se fossem a atual. O id segue nos metadados estruturados
    // (demand_id na linha, demand:{id} no wrapper do guardrail).
    const header = `Refinamento anterior: ${title}`.trim();
    const body = messages
      .slice(-40)
      .map((message) => `[${message.agent}] ${message.message}`)
      .join('\n\n');
    return `${header}\n\n${body}`;
  }

  private async upsertDocument(doc: RefinementDoc): Promise<void> {
    // 1. Gerar o embedding para o conteúdo do documento
    let embedding: number[] | null = null;
    try {
      embedding = await embeddingService.getEmbedding(doc.content.slice(0, 8000));
    } catch (err) {
      logger.warn(`Failed to generate embedding for doc ${doc.sourceKey} during ingest:`, err);
    }

    // 2. Dedup por conteúdo na escrita (Problem #5): similaridade cosine > 0.97
    if (embedding) {
      let isDuplicate = false;
      const useNative = await vectorSearchService.isNativeAvailable();

      if (useNative) {
        const vectorLiteral = `[${embedding.join(',')}]`;
        try {
          const similar = await dbHelper.all<{ id: string; source_key: string }>(
            sql`
            SELECT id, source_key
            FROM refinement_rag_documents
            WHERE embedding IS NOT NULL AND (1 - (embedding <=> ${vectorLiteral}::vector)) > 0.97
            LIMIT 1
            `,
          );
          if (similar.length > 0 && similar[0].source_key !== doc.sourceKey) {
            isDuplicate = true;
          }
        } catch (_) {
          // Ignora erro no check nativo e segue
        }
      } else {
        const rows = (await dbAll(
          this.database,
          sql`SELECT id, source_key, embedding FROM refinement_rag_documents WHERE embedding IS NOT NULL`,
        )) as Array<{ id: string; source_key: string; embedding: string }>;
        for (const row of rows) {
          try {
            const other = embeddingService.deserializeEmbedding(row.embedding);
            const sim = embeddingService.cosineSimilarity(embedding, other);
            if (sim > 0.97 && row.source_key !== doc.sourceKey) {
              isDuplicate = true;
              break;
            }
          } catch (_) {
            // Ignora embedding corrompido
          }
        }
      }

      if (isDuplicate) {
        logger.info(
          `[RAG Dedup] Duplicate content detected (similarity > 0.97) for ${doc.sourceKey}, skipping.`,
          {
            sourceKey: doc.sourceKey,
          },
        );
        return;
      }
    }

    const existing = (await dbAll(
      this.database,
      sql`SELECT id FROM refinement_rag_documents WHERE source_key = ${doc.sourceKey} LIMIT 1`,
    )) as Array<{ id: string }>;

    const docId = existing[0]?.id || randomUUID();
    const serializedEmbedding = embedding ? embeddingService.serializeEmbedding(embedding) : null;

    if (existing.length === 0) {
      await dbRun(
        this.database,
        sql`
        INSERT INTO refinement_rag_documents (id, source_key, demand_id, doc_type, content, embedding, repo_full_name, updated_at)
        VALUES (${docId}, ${doc.sourceKey}, ${doc.demandId}, ${doc.docType}, ${doc.content}, ${serializedEmbedding}, ${doc.repoFullName}, ${Date.now()})
      `,
      );
    } else {
      await dbRun(
        this.database,
        sql`
        UPDATE refinement_rag_documents
        SET demand_id = ${doc.demandId},
            doc_type = ${doc.docType},
            content = ${doc.content},
            embedding = ${serializedEmbedding},
            repo_full_name = ${doc.repoFullName},
            updated_at = ${Date.now()}
        WHERE id = ${docId}
      `,
      );
    }

    // Sincronizar com a tabela central do pgvector HNSW se disponível
    if (embedding) {
      try {
        await vectorSearchService.storeEmbedding({
          chunkId: docId,
          chunkSource: 'refinement',
          embedding,
        });
      } catch (err) {
        logger.warn('Failed to sync embedding to central pgvector index', { error: err });
      }
    }
  }

  /**
   * Loads all known (demandId → repoFullName) pairs into memory. Called at
   * the start of each ingest and backfill so file-based attribution stays
   * accurate without per-file SQL.
   */
  private async refreshDemandRepoCache(): Promise<void> {
    try {
      const demands = (await demandRepository.findAll()) as Demand[];
      this.demandRepoCache.clear();
      for (const demand of demands) {
        this.demandRepoCache.set(demand.id, resolveDemandRepoFullName(demand));
      }
    } catch (error) {
      logger.warn('Não foi possível carregar mapping demand → repo para o RAG', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Issues the actual SELECT against `refinement_rag_documents` with the
   * appropriate WHERE clause depending on `scope`. Centralised to keep both
   * `retrieve` and `retrieveHybrid` consistent and to make the filter
   * semantics auditable in one place.
   */
  private async fetchScopedRows(
    scope: RetrievalScope,
    withEmbedding = false,
  ): Promise<RetrievedRow[] | RetrievedRowWithEmbedding[]> {
    const repoFullName = scope.repoFullName?.trim() || null;
    const includeGlobal = scope.includeGlobal === true;

    if (repoFullName && includeGlobal) {
      const query = withEmbedding
        ? sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content, embedding
          FROM refinement_rag_documents
          WHERE repo_full_name = ${repoFullName} OR repo_full_name IS NULL
        `
        : sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content
          FROM refinement_rag_documents
          WHERE repo_full_name = ${repoFullName} OR repo_full_name IS NULL
        `;
      return (await dbAll(this.database, query)) as RetrievedRow[] | RetrievedRowWithEmbedding[];
    }

    if (repoFullName) {
      const query = withEmbedding
        ? sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content, embedding
          FROM refinement_rag_documents
          WHERE repo_full_name = ${repoFullName}
        `
        : sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content
          FROM refinement_rag_documents
          WHERE repo_full_name = ${repoFullName}
        `;
      return (await dbAll(this.database, query)) as RetrievedRow[] | RetrievedRowWithEmbedding[];
    }

    if (!includeGlobal) {
      // Demand has no repo: return only the un-attributed pool, never the
      // documents tied to a different initiative — this is the symmetric
      // protection of the per-repo branch above.
      const query = withEmbedding
        ? sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content, embedding
          FROM refinement_rag_documents
          WHERE repo_full_name IS NULL
        `
        : sql`
          SELECT source_key, doc_type, demand_id, repo_full_name, content
          FROM refinement_rag_documents
          WHERE repo_full_name IS NULL
        `;
      return (await dbAll(this.database, query)) as RetrievedRow[] | RetrievedRowWithEmbedding[];
    }

    // No scope at all (admin/diagnostic path): return everything.
    const query = withEmbedding
      ? sql`
        SELECT source_key, doc_type, demand_id, repo_full_name, content, embedding
        FROM refinement_rag_documents
      `
      : sql`
        SELECT source_key, doc_type, demand_id, repo_full_name, content
        FROM refinement_rag_documents
      `;
    return (await dbAll(this.database, query)) as RetrievedRow[] | RetrievedRowWithEmbedding[];
  }

  private formatScopeLabel(scope: RetrievalScope): string {
    if (scope.repoFullName) {
      const repoLabel = scope.repoFullName;
      return scope.includeGlobal ? ` (repo:${repoLabel} + globais)` : ` (repo:${repoLabel})`;
    }
    return scope.includeGlobal ? ' (todos os repositórios)' : ' (apenas globais)';
  }

  private tokenize(text: string): string[] {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3);
  }

  private score(queryTokens: string[], content: string): number {
    const contentNorm = content
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (contentNorm.includes(token)) score += 1;
    }
    return score;
  }

  private extractSnippet(query: string, content: string): string {
    const queryTokens = this.tokenize(query);
    if (!content.trim()) return '';

    // Remove espaços extras e quebras excessivas para normalizar
    const normalized = content.replace(/\s+/g, ' ').trim();

    // Divide em sentenças mantendo pontuações normais (. ! ?)
    const sentences = normalized
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length === 0) return '';

    // Encontra a primeira sentença que contém algum dos tokens da busca
    let matchIdx = -1;
    for (let i = 0; i < sentences.length; i++) {
      const lowerSentence = sentences[i].toLowerCase();
      const hasToken = queryTokens.some((token) => lowerSentence.includes(token));
      if (hasToken) {
        matchIdx = i;
        break;
      }
    }

    // Fallback: se nenhuma sentença bater com os tokens de busca, retorna as primeiras até ~300 caracteres
    if (matchIdx === -1) {
      let result = '';
      for (const s of sentences) {
        if (result.length + s.length > 300 && result.length > 0) break;
        result += (result ? ' ' : '') + s;
      }
      return result;
    }

    // Constrói o snippet: sentença anterior + sentença correspondente + próxima sentença
    const startIdx = Math.max(0, matchIdx - 1);
    const endIdx = Math.min(sentences.length - 1, matchIdx + 1);

    let result = '';
    for (let i = startIdx; i <= endIdx; i++) {
      const s = sentences[i];
      if (result.length + s.length > 400 && i > matchIdx) break; // Evita estourar o limite aceitável do snippet
      result += (result ? ' ' : '') + s;
    }
    return result;
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbRun(
        this.database,
        sql`
        CREATE TABLE IF NOT EXISTS refinement_rag_documents (
          id TEXT PRIMARY KEY NOT NULL,
          source_key TEXT NOT NULL UNIQUE,
          demand_id INTEGER,
          doc_type TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding TEXT,
          repo_full_name TEXT,
          updated_at BIGINT NOT NULL
        )
      `,
      );

      // Add embedding column if table already exists without it
      try {
        await dbRun(
          this.database,
          sql`ALTER TABLE refinement_rag_documents ADD COLUMN embedding TEXT`,
        );
      } catch (_) {
        // Column already exists - ignore
      }

      // Add repo_full_name column if table already exists without it.
      // Mirrors the formal migration in migrations/0018_add_repo_full_name.sql
      // so dev databases that bypass the migration runner still get the column.
      try {
        await dbRun(
          this.database,
          sql`ALTER TABLE refinement_rag_documents ADD COLUMN repo_full_name TEXT`,
        );
      } catch (_) {
        // Column already exists - ignore
      }

      try {
        await dbRun(
          this.database,
          sql`CREATE INDEX IF NOT EXISTS idx_refinement_rag_documents_repo_full_name ON refinement_rag_documents(repo_full_name)`,
        );
      } catch (_) {
        // Index creation non-fatal
      }

      // Migration: convert INTEGER to BIGINT for timestamps (PostgreSQL only)
      if (isPostgres) {
        try {
          await dbRun(
            this.database,
            sql`
            ALTER TABLE refinement_rag_documents
            ALTER COLUMN updated_at TYPE BIGINT USING updated_at::BIGINT
          `,
          );
        } catch (_) {
          // Column already BIGINT or migration already applied
        }
      }
    } catch (error) {
      logger.warn('Não foi possível garantir schema refinement_rag_documents', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const refinementRAGService = new RefinementRAGService();
