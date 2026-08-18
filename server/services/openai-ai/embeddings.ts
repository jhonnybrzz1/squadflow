/**
 * Demanda 10209 — Fase 3: embeddings extraídos do god object openai-ai.ts.
 */
import { embeddingsManager } from '../llm-embeddings-operations';

export async function generateEmbedding(text: string): Promise<number[]> {
  return embeddingsManager.generateEmbedding({ text });
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return embeddingsManager.generateEmbeddings({ texts });
}

export function isUsingLocalEmbeddings(): boolean {
  return embeddingsManager.isUsingLocalEmbeddings();
}

export function isUsingLocalEmbeddingsForRAG(): boolean {
  return embeddingsManager.isUsingLocalEmbeddingsForRAG();
}
