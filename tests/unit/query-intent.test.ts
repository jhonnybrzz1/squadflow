/**
 * query-intent.ts não tinha nenhuma cobertura de teste antes de ser conectado
 * de verdade à pipeline (refinement-rag.ts, atrás de enableQueryIntentDetection).
 * Cobertura mínima da classificação, já que agora tem efeito real em custo
 * (useReranking) quando a flag estiver ligada.
 */
import { describe, it, expect } from 'vitest';
import {
  detectQueryIntent,
  getRetrievalParamsForIntent,
  mergeRetrievalParams,
} from '../../server/services/query-intent';

describe('detectQueryIntent', () => {
  it('classifica pergunta factual (o que é / qual é)', () => {
    const result = detectQueryIntent('O que é a política de retenção de dados?');
    expect(result.intent).toBe('factual');
    expect(result.suggestedParams.useReranking).toBe(true);
  });

  it('classifica pergunta procedural (como fazer / passo a passo)', () => {
    const result = detectQueryIntent('Como funciona o fluxo de aprovação passo a passo?');
    expect(result.intent).toBe('procedural');
  });

  it('classifica pergunta comparativa (diferença / versus)', () => {
    const result = detectQueryIntent('Qual a diferença entre sequential e roundtable?');
    expect(result.intent).toBe('comparative');
  });

  it('classifica pergunta regulatória (resolução / compliance) com maior peso', () => {
    const result = detectQueryIntent('Qual o prazo da resolução normativa de compliance?');
    expect(result.intent).toBe('regulatory');
    expect(result.suggestedParams.useReranking).toBe(true);
  });

  it('cai para "general" (rerank OFF) quando nenhum padrão bate', () => {
    const result = detectQueryIntent('xyz abc texto aleatório sem sentido nenhum');
    expect(result.intent).toBe('general');
    expect(result.suggestedParams.useReranking).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('ignora acentuação/caixa (normaliza antes de casar keywords)', () => {
    const result = detectQueryIntent('QUAL É a definição de RAG?');
    expect(result.intent).toBe('factual');
  });
});

describe('getRetrievalParamsForIntent / mergeRetrievalParams', () => {
  it('retorna uma cópia independente (mutação não afeta o default compartilhado)', () => {
    const params = getRetrievalParamsForIntent('factual');
    params.topK = 999;
    expect(getRetrievalParamsForIntent('factual').topK).not.toBe(999);
  });

  it('overrides do usuário vencem os sugeridos pela intenção', () => {
    const intentParams = getRetrievalParamsForIntent('general');
    const merged = mergeRetrievalParams(intentParams, { useReranking: true });
    expect(merged.useReranking).toBe(true);
    expect(merged.topK).toBe(intentParams.topK);
  });
});
