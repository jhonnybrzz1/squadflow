/**
 * Demanda 10028 — helper de RAG reutilizável para a reformulação assistida.
 *
 * Escopo (spike T001, docs/reformulate-rag-spike.md): consulta a fonte
 * `refinement` (RAG do repositório, funcional) e, quando a demanda tem
 * `domain` especializado, o corpus curado de `DomainKnowledgeRAGService`.
 */
import { refinementRAGService } from './refinement-rag';
import { domainKnowledgeRAGService } from './domain-knowledge-rag';
import { getDomains, isSpecializedDomain } from './domain-config';
import { logger } from '../utils/logger';
import type { DemandDomain } from '@shared/schema';

export interface RagRetrievalParams {
  query: string;
  repoFullName?: string | null;
  additionalRepos?: string[];
  domain?: DemandDomain | null;
  topK?: number;
  maxTotalChunks?: number;
}

export interface RagRetrievalResult {
  /** String já formatada (guardrail de injection incluído) pronta para o prompt. */
  contextText: string;
  /** Número de chunks relevantes de repositório encontrados (fonte `refinement`). */
  repoChunkCount: number;
  /** true quando a busca no repositório não retornou nenhum chunk relevante. */
  semContextoRepo: boolean;
  /** Indica se o domínio consultado é desconhecido (HTTP 400 deve ser usado pelo caller). */
  domainInvalid?: boolean;
}

const DEFAULT_MAX_TOTAL_CHUNKS = 5;

/**
 * Consulta o RAG do repositório (e, quando aplicável, a base de conhecimento
 * de domínio especializado) para uma query. Sem repositório selecionado, a
 * busca de repo é pulada (evita vazamento entre repos não relacionados) e
 * `semContextoRepo` é `true`.
 */
export async function ragRetrieval(params: RagRetrievalParams): Promise<RagRetrievalResult> {
  const topK = params.topK ?? 4;
  const maxTotalChunks = params.maxTotalChunks ?? DEFAULT_MAX_TOTAL_CHUNKS;
  const repos = [params.repoFullName, ...(params.additionalRepos ?? [])].filter(
    (r): r is string => typeof r === 'string' && r.trim().length > 0,
  );

  let repoChunkCount = 0;
  const repoContextParts: string[] = [];

  if (repos.length > 0) {
    // BUG FIX (reformulação 502): limita o total de chunks enviados ao LLM
    // a `maxTotalChunks`, distribuindo o orçamento entre repositórios.
    let remaining = maxTotalChunks;

    for (const repoFullName of repos) {
      if (remaining <= 0) break;

      const matches = await refinementRAGService.retrieveHybrid(params.query, topK, {
        repoFullName,
      });
      const cappedMatches = matches.slice(0, remaining);
      repoChunkCount += cappedMatches.length;

      if (cappedMatches.length > 0) {
        const repoTopK = Math.min(topK, remaining);
        const context = await refinementRAGService.buildContext(params.query, repoTopK, {
          repoFullName,
        });
        repoContextParts.push(context);
        remaining -= cappedMatches.length;
      }
    }
  }

  const semContextoRepo = repoChunkCount === 0;

  // M-3: domínio inexistente retorna erro claro para o caller propagar HTTP 400.
  if (params.domain && !isSpecializedDomain(params.domain)) {
    logger.warn('M-3: domínio inexistente em ragRetrieval', {
      context: { domain: params.domain },
    });
    return {
      contextText: `Domínio desconhecido: ${params.domain}. Domínios configurados: ${[...getDomainNames()].join(', ')}.`,
      repoChunkCount,
      semContextoRepo,
      domainInvalid: true,
    };
  }

  const domainContextPart =
    params.domain && isSpecializedDomain(params.domain)
      ? domainKnowledgeRAGService.buildContext(params.domain, params.query)
      : '';

  const contextText = [...repoContextParts, domainContextPart].filter(Boolean).join('\n\n');

  logger.info('ragRetrieval executada', {
    context: {
      event: 'reformulate_rag_retrieval',
      repos_queried: repos.length,
      repo_chunk_count: repoChunkCount,
      sem_contexto_repo: semContextoRepo,
      domain_queried: isSpecializedDomain(params.domain),
      domain: params.domain,
    },
  });

  return {
    contextText:
      contextText ||
      'RAG do repositório: sem correspondências relevantes ou nenhum repositório selecionado.',
    repoChunkCount,
    semContextoRepo,
    domainInvalid: false,
  };
}

function getDomainNames(): IterableIterator<string> {
  // Auditoria 2026-08-01 (A14): aqui havia `require('./domain-config')` com o
  // comentário "lazy import to avoid circular dependency at module load time".
  // Duas coisas erradas: (1) o projeto é ESM (`"type": "module"`), então
  // `require` não existe e a chamada lançava `ReferenceError: require is not
  // defined` — derrubando a reformulação de demanda; (2) não havia ciclo para
  // evitar. `domain-config` importa apenas node:fs, node:path, zod, logger e
  // url, e este arquivo JÁ o importa estaticamente na linha 10, o que anularia
  // qualquer proteção do lazy load de todo modo.
  return getDomains()
    .map((d) => d.name)
    [Symbol.iterator]();
}
