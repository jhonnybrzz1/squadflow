/**
 * Few-Shot Scoring (Fase 4 / slice 6 — achado 4.4).
 *
 * Funções PURAS para medir e usar a eficácia dos exemplos few-shot:
 * - `cosineSimilarity`: similaridade textual (TF de tokens) entre saída gerada e
 *   a saída válida de referência. Base da ablação.
 * - `deltaToScore`: mapeia o delta de qualidade (-1..1) para um score 0-100.
 * - `rankByEfficacy` / `filterByThreshold`: usadas na injeção do prompt para
 *   PREFERIR exemplos comprovadamente bons e DESCARTAR (sem deletar arquivos) os
 *   que pioram o output.
 *
 * Sem I/O e sem dependências de runtime — fácil de testar e reusar no harness.
 */
import { normalizeForEval } from '@shared/prompt-eval-schema';
import type { StructuredFewShotExample } from './few-shot-bank';

/** Score atribuído a exemplos ainda não avaliados (neutro). */
export const NEUTRAL_EFFICACY_SCORE = 50;

/**
 * Similaridade de cosseno por frequência de termos (sem dependências).
 * Reusa `normalizeForEval` (mesma normalização da suíte prompts:eval).
 */
export function cosineSimilarity(a: string, b: string): number {
  const tokenize = (text: string): string[] =>
    normalizeForEval(text)
      .split(/\s+/)
      .filter((t) => t.length > 2);

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const tf = (tokens: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
    return map;
  };

  const tfA = tf(tokensA);
  const tfB = tf(tokensB);
  const vocab = new Set([...tfA.keys(), ...tfB.keys()]);

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const term of vocab) {
    const fa = tfA.get(term) ?? 0;
    const fb = tfB.get(term) ?? 0;
    dot += fa * fb;
    normA += fa * fa;
    normB += fb * fb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Converte o delta de qualidade da ablação em score 0-100.
 * delta = (qualidade COM o exemplo) − (qualidade SEM ele), tipicamente em [-1, 1].
 * 0 → 50 (neutro); +1 → 100 (muito útil); -1 → 0 (atrapalha).
 */
export function deltaToScore(delta: number): number {
  const score = 50 + delta * 50;
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

/** Score efetivo de um exemplo (neutro quando ainda não avaliado). */
export function effectiveScore(example: StructuredFewShotExample): number {
  return example.efficacy?.score ?? NEUTRAL_EFFICACY_SCORE;
}

/**
 * Ordena exemplos por eficácia (desc). Exemplos não avaliados ficam no meio
 * (score neutro), não são empurrados pra fora. Estável para empates.
 */
export function rankByEfficacy<T extends StructuredFewShotExample>(examples: T[]): T[] {
  return examples
    .map((example, index) => ({ example, index }))
    .sort((a, b) => {
      const diff = effectiveScore(b.example) - effectiveScore(a.example);
      return diff !== 0 ? diff : a.index - b.index; // empate => ordem original
    })
    .map((entry) => entry.example);
}

/**
 * Remove exemplos cujo score AVALIADO está abaixo do threshold. Exemplos sem
 * score (não avaliados) SEMPRE passam — não escondemos exemplos novos, só os que
 * a ablação reprovou explicitamente. threshold <= 0 nunca filtra nada.
 */
export function filterByThreshold<T extends StructuredFewShotExample>(
  examples: T[],
  threshold: number,
): T[] {
  if (!Number.isFinite(threshold) || threshold <= 0) return examples;
  return examples.filter((example) => {
    const score = example.efficacy?.score;
    return score === undefined || score >= threshold;
  });
}

/**
 * Pipeline de seleção para injeção: filtra reprovados, depois rankeia por eficácia.
 */
export function selectForInjection<T extends StructuredFewShotExample>(
  examples: T[],
  threshold: number,
): T[] {
  return rankByEfficacy(filterByThreshold(examples, threshold));
}
