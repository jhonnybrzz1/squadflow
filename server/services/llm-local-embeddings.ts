/**
 * Generates local embeddings using a simple hash-based approach.
 *
 * ⚠️ QUALITY NOTICE: this is a PERFORMANCE FALLBACK, not a quality-equivalent
 * replacement for transformer-based embeddings (e.g., text-embedding-3-small,
 * qwen/qwen3-embedding-8b). It uses FNV-1a hashing + trigram features over a
 * sparse 3072d vector, so cosine similarity is driven mostly by lexical overlap.
 * Semantically related but lexically different sentences will have low similarity.
 *
 * Appropriate uses:
 *   - Offline/dev environments without an API key
 *   - Non-critical cache keys or rough deduplication
 *   - Reducing cold-start latency when remote provider is unavailable
 *
 * NOT appropriate for:
 *   - Critical RAG retrieval (semantic recall will be poor)
 *   - Semantic cache where precision matters
 *   - Production ranking of user-facing results
 *
 * The feature flag `enableLocalEmbeddings` controls general availability;
 * `enableLocalEmbeddingsForRAG` (default false) gates usage in RAG paths.
 */

const EMBEDDING_DIMENSIONS = 3072;

/**
 * Hashes a string to an index using FNV-1a algorithm.
 *
 * @param value - String to hash
 * @param modulo - Modulo for the result
 * @returns Hashed index
 */
export function hashToIndex(value: string, modulo: number): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % modulo;
}

/**
 * Generates a local embedding vector for the given text.
 * Uses token-based hashing with trigram features.
 *
 * @param text - Text to embed
 * @returns Embedding vector
 */
export function generateLocalEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);

  for (const token of tokens) {
    const index = hashToIndex(token, EMBEDDING_DIMENSIONS);
    vector[index] += 1;

    for (let i = 0; i < token.length - 2; i += 1) {
      const trigram = token.slice(i, i + 3);
      vector[hashToIndex(`tri:${trigram}`, EMBEDDING_DIMENSIONS)] += 0.35;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(8)));
}
