export interface RetrievalMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
}

export function calculateRetrievalMetrics(
  retrievedIds: string[],
  relevantIds: string[],
  k = 5,
): RetrievalMetrics {
  if (!Number.isInteger(k) || k <= 0) throw new Error('k must be a positive integer');
  const relevant = new Set(relevantIds);
  const topK = retrievedIds.slice(0, k);
  const relevantRetrieved = topK.filter((id) => relevant.has(id));
  const firstRelevantIndex = retrievedIds.findIndex((id) => relevant.has(id));

  return {
    recallAtK: relevant.size > 0 ? relevantRetrieved.length / relevant.size : 0,
    precisionAtK: topK.length > 0 ? relevantRetrieved.length / topK.length : 0,
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
  };
}
