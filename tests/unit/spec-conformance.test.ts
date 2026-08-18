import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  enforceSpecConformance,
  prependNeedsReviewBanner,
} from '../../server/cognitive-core/spec-conformance';

const GOOD_PRD = `# PRD

## Problema
Documentos inconsistentes.

## Objetivo
Padronizar.

## Critérios de Aceite
- ok
`;

const BAD_PRD = `# PRD

## Objetivo
Sem problema nem critérios.
`;

describe('enforceSpecConformance', () => {
  it('passa na 1ª tentativa sem regenerar quando já conforme', async () => {
    const generate = vi.fn(async () => GOOD_PRD);
    const result = await enforceSpecConformance('prd', generate, { maxAttempts: 2 });

    expect(result.ok).toBe(true);
    expect(result.needsReview).toBe(false);
    expect(result.attempts).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('regenera com feedback e converge dentro do teto', async () => {
    const generate = vi
      .fn<[string | undefined], Promise<string>>()
      .mockResolvedValueOnce(BAD_PRD)
      .mockResolvedValueOnce(GOOD_PRD);

    const result = await enforceSpecConformance('prd', generate, { maxAttempts: 2 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    // A 2ª chamada recebe o feedback dos erros da 1ª.
    expect(generate.mock.calls[0][0]).toBeUndefined();
    expect(generate.mock.calls[1][0]).toContain('SpecKit');
  });

  it('marca needs_review após esgotar as tentativas e devolve a melhor versão', async () => {
    const generate = vi.fn(async () => BAD_PRD);
    const result = await enforceSpecConformance('prd', generate, { maxAttempts: 2 });

    expect(result.ok).toBe(false);
    expect(result.needsReview).toBe(true);
    expect(result.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.content).toBe(BAD_PRD);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('respeita maxAttempts=1 (sem retry)', async () => {
    const generate = vi.fn(async () => BAD_PRD);
    const result = await enforceSpecConformance('prd', generate, { maxAttempts: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.needsReview).toBe(true);
  });
});

describe('prependNeedsReviewBanner', () => {
  it('prepende banner needs_review:true com as pendências', () => {
    const banner = prependNeedsReviewBanner({
      content: '# doc',
      ok: false,
      needsReview: true,
      attempts: 2,
      issues: [{ field: 'hasProblema', message: 'faltou Problema' }],
      durationMs: 3,
    });
    expect(banner).toContain('needs_review: true');
    expect(banner).toContain('faltou Problema');
    expect(banner.endsWith('# doc')).toBe(true);
  });
});
