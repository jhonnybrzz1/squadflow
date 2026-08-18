import { gitHubService } from './github';
import { logger } from '../utils/logger';

/**
 * Boundary de I/O da validação determinística de caminhos: resolve o conjunto de
 * caminhos reais de um repositório ("owner/name") a partir do GitHub, com cache em
 * memória (TTL curto) para não bater na API a cada documento gerado.
 *
 * Retorna `null` quando não há índice confiável (sem token, repo inacessível, árvore
 * truncada) — o validador trata `null` como "não verificável" e não marca nada.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { paths: Set<string> | null; ts: number }>();

export async function resolveKnownRepoPaths(repoFullName: string): Promise<Set<string> | null> {
  const now = Date.now();
  const cached = cache.get(repoFullName);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.paths;
  }

  const slash = repoFullName.indexOf('/');
  if (slash <= 0) {
    cache.set(repoFullName, { paths: null, ts: now });
    return null;
  }
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);

  let paths: Set<string> | null = null;
  try {
    const result = await gitHubService.getRepoTreePaths(owner, name);
    paths = result.available ? new Set(result.paths) : null;
  } catch (error) {
    logger.warn(`Falha ao resolver índice de paths de ${repoFullName}`, {
      error: error instanceof Error ? error : undefined,
    });
    paths = null;
  }

  cache.set(repoFullName, { paths, ts: now });
  return paths;
}
