import { describe, it, expect } from 'vitest';
import {
  isGoLive,
  shouldSkipStage,
  NON_CRITICAL_STAGES,
} from '../../server/services/ai-squad/evaluation-gate';

describe('evaluation-gate (spec 10015 go-live)', () => {
  it('isGoLive só é true com goLiveMode === true (fail-safe)', () => {
    expect(isGoLive({ goLiveMode: true })).toBe(true);
    expect(isGoLive({ goLiveMode: false })).toBe(false);
    expect(isGoLive({ goLiveMode: null })).toBe(false);
    expect(isGoLive({})).toBe(false);
    expect(isGoLive(null)).toBe(false);
    expect(isGoLive(undefined)).toBe(false);
  });

  it('pula etapas não críticas apenas quando go-live está ligado', () => {
    expect(shouldSkipStage('rag_quality', true)).toBe(true);
    expect(shouldSkipStage('content_guardrails', true)).toBe(true);
    expect(shouldSkipStage('rag_quality', false)).toBe(false);
    expect(shouldSkipStage('rag_quality', null)).toBe(false);
    expect(shouldSkipStage('rag_quality', undefined)).toBe(false);
  });

  it('RAG quality e content guardrails são as etapas não críticas', () => {
    expect([...NON_CRITICAL_STAGES].sort()).toEqual(['content_guardrails', 'rag_quality']);
  });
});
