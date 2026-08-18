/**
 * Spec 006 / US5: com o classificador semântico ligado por default e o enforce
 * ativo, uma detecção semântica BLOQUEIA (não apenas flagra), e benignos passam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const classifyMock = vi.fn();
vi.mock('../../server/services/semantic-injection-classifier', () => ({
  classifyInjectionSemantic: (input: string) => classifyMock(input),
}));

vi.mock('../../server/services/feature-flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/services/feature-flags')>();
  return {
    ...original,
    featureFlags: {
      getFlags: () =>
        original.featureFlagsSchema.parse({
          semanticInjectionClassifierEnabled: true,
          semanticInjectionEnforceEnabled: true,
        }),
      hasOverride: () => false,
    },
  };
});

import { runGuardrailsOnMessagesAsync } from '../../server/services/llm-guardrails';
import { featureFlagsSchema } from '../../server/services/feature-flags';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LLM_GUARDRAILS_ENABLED;
});

describe('guardrail semântico no caminho de bloqueio (spec 006/US5)', () => {
  it('defaults do schema: classificador E enforce ligados (FR-011)', () => {
    const defaults = featureFlagsSchema.parse({});
    expect(defaults.semanticInjectionClassifierEnabled).toBe(true);
    expect(defaults.semanticInjectionEnforceEnabled).toBe(true);
  });

  it('detecção semântica bloqueia a mensagem (não apenas flagra)', async () => {
    classifyMock.mockResolvedValue({
      available: true,
      injection: true,
      confidence: 'high',
      reason: 'tentativa de reconfigurar o assistente',
      latencyMs: 5,
    });

    const result = await runGuardrailsOnMessagesAsync(
      [{ role: 'user', content: 'Mensagem semanticamente maliciosa sem padrão regex' }],
      {},
    );

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('semantic_injection');
    expect(result.userMessage).toBeTruthy();
  });

  it('mensagem benigna continua permitida (FP controlado)', async () => {
    classifyMock.mockResolvedValue({
      available: true,
      injection: false,
      confidence: 'low',
      reason: null,
      latencyMs: 5,
    });

    const result = await runGuardrailsOnMessagesAsync(
      [{ role: 'user', content: 'Quero melhorar o fluxo de cadastro de clientes' }],
      {},
    );

    expect(result.blocked).toBe(false);
  });

  it('classificador indisponível => fail-closed por default', async () => {
    classifyMock.mockResolvedValue({
      available: false,
      injection: false,
      confidence: null,
      reason: null,
      latencyMs: 0,
    });

    const result = await runGuardrailsOnMessagesAsync(
      [{ role: 'user', content: 'Pergunta normal de negócio' }],
      {},
    );

    expect(result.blocked).toBe(true);
    expect(result.verdict).toBe('unavailable');
    expect(result.blockReason).toBe('Guardrail pipeline unavailable');
  });
});
