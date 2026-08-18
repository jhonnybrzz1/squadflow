/**
 * Roundtable Cache Policy — funções puras
 *
 * Encapsula as regras de cache do roundtable de forma testável sem I/O.
 * O orchestrator usa estas funções em vez de replicar a lógica inline.
 *
 * Contrato do metadata (llm-cache-operations.ts:185-198):
 *   semantic hit → { cacheHit: true, semanticCacheHit: true }
 *   exact hit    → { cacheHit: true, semanticCacheHit: false | undefined }
 *   no hit       → { cacheHit: false, semanticCacheHit: false | undefined }
 */

export type CacheClassification = 'exact' | 'semantic' | 'none';

export interface RoundtableCachePolicyInput {
  /** Feature flag global de cache do roundtable */
  enabled: boolean;
  /** true quando chamado dentro de um loop de Self-Consistency */
  forSelfConsistency: boolean;
  /** TTL em ms a ser passado ao aiResponseCache */
  ttlMs: number;
}

export interface RoundtableCachePolicyOutput {
  /** Valor a passar em GenerateOptions.cache */
  cache: boolean;
  /** Valor a passar em GenerateOptions.cacheTtlMs (undefined quando cache=false) */
  cacheTtlMs: number | undefined;
  /**
   * Sempre true: bloqueia lookup E gravação no cache semântico.
   * Moderador e consolidação usam JSON estruturado — hits semânticos
   * stale degradariam a qualidade e gerariam embeddings desnecessários.
   */
  semanticCacheDisabled: true;
}

/**
 * Resolve a política de cache para um estágio do roundtable.
 *
 * Regras (em ordem de precedência):
 *  1. cache=false quando a flag estiver desligada.
 *  2. cache=false durante amostras de Self-Consistency (garante diversidade).
 *  3. semanticCacheDisabled=true sempre (exact-only; bloqueia lookup e write).
 */
export function resolveRoundtableCachePolicy(
  input: RoundtableCachePolicyInput,
): RoundtableCachePolicyOutput {
  const shouldCache = input.enabled && !input.forSelfConsistency;
  return {
    cache: shouldCache,
    cacheTtlMs: shouldCache ? input.ttlMs : undefined,
    semanticCacheDisabled: true,
  };
}

/**
 * Classifica um metadata de cache hit de acordo com o contrato real.
 *
 * semanticCacheHit é verificado ANTES de cacheHit porque o contrato de
 * trySemanticCache retorna { cacheHit: true, semanticCacheHit: true } para
 * hits semânticos. Verificar cacheHit primeiro classificaria erroneamente
 * como 'exact' quando o hit era na verdade semântico.
 */
export function classifyCacheResult(metadata: {
  cacheHit: boolean;
  semanticCacheHit?: boolean;
}): CacheClassification {
  if (metadata.semanticCacheHit) return 'semantic';
  if (metadata.cacheHit) return 'exact';
  return 'none';
}

/**
 * Retorna true se o metadata indica cache hit (exact ou semântico).
 * Usado para decidir se emite métricas de custo/tokens — hits não
 * consomem tokens reais do provedor.
 */
export function isCacheHit(metadata: { cacheHit: boolean; semanticCacheHit?: boolean }): boolean {
  return metadata.cacheHit || (metadata.semanticCacheHit ?? false);
}
