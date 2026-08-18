import { describe, expect, it } from 'vitest';
import {
  applySoloBuilderPrompt,
  applyKnowledgeCutoffPrompt,
  buildKnowledgeCutoffSuffix,
} from '../server/services/ai-squad/AgentFactory';

describe('applySoloBuilderPrompt', () => {
  it('adds concise solo-builder instructions once', () => {
    const prompt = 'Você é Tech Lead.';

    const once = applySoloBuilderPrompt(prompt);
    const twice = applySoloBuilderPrompt(once);

    expect(once).toContain('MODO DOCUMENTAÇÃO ENXUTA / BUILDER SOLO');
    expect(twice).toBe(once);
  });
});

describe('applyKnowledgeCutoffPrompt (spec 10004 FR-004)', () => {
  it('injeta a consciência de data de corte com a data corrente uma única vez', () => {
    const prompt = 'Você é Tech Lead.';
    const now = new Date('2026-07-18T00:00:00Z');

    const once = applyKnowledgeCutoffPrompt(prompt, now)!;
    const twice = applyKnowledgeCutoffPrompt(once, now);

    expect(once).toContain('CONSCIÊNCIA DE ATUALIDADE');
    expect(once).toContain('2026-07-18');
    expect(once).toContain('data de corte ANTERIOR a 2026');
    expect(twice).toBe(once); // idempotente
  });

  it('instrui a preferir RAG/ferramentas e declarar incerteza em vez de inventar', () => {
    const suffix = buildKnowledgeCutoffSuffix(new Date('2026-07-18T00:00:00Z'));

    expect(suffix).toContain('CONTEXTO RECUPERADO (RAG)');
    expect(suffix).toContain('A VERIFICAR');
    expect(suffix).toMatch(/ferramentas/i);
  });

  it('preserva o prompt original e apenas anexa o bloco', () => {
    const prompt = 'Você é UX.';
    const result = applyKnowledgeCutoffPrompt(prompt, new Date('2026-07-18T00:00:00Z'))!;
    expect(result.startsWith(prompt)).toBe(true);
  });

  it('retorna undefined para prompt vazio/nulo (fail-safe)', () => {
    expect(applyKnowledgeCutoffPrompt(undefined)).toBeUndefined();
    expect(applyKnowledgeCutoffPrompt('')).toBeUndefined();
    expect(applyKnowledgeCutoffPrompt(null)).toBeUndefined();
  });
});
