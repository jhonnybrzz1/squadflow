import { describe, expect, it } from 'vitest';
import {
  HANDOFF_FORMAT,
  validateSpeckitManifest,
  type HandoffManifest,
} from '@shared/handoff-manifest';

function validManifest(overrides?: Partial<HandoffManifest>): HandoffManifest {
  return {
    format: HANDOFF_FORMAT,
    demand: { id: 42, title: 'Demanda X', type: 'nova_funcionalidade', priority: 'Média' },
    generatedAt: '2026-07-20T12:00:00.000Z',
    documents: [
      {
        path: 'specs/42-handoff/spec.md',
        kind: 'spec',
        sha256: 'a'.repeat(64),
        version: 1,
        updatedAt: null,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('Spec 10044 T1 — validateSpeckitManifest', () => {
  it('aceita um manifest válido com documento spec', () => {
    const result = validateSpeckitManifest(validManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.demand.id).toBe(42);
    }
  });

  it('rejeita manifest sem documento kind="spec" (nada a implementar)', () => {
    const result = validateSpeckitManifest(
      validManifest({
        documents: [
          {
            path: 'specs/42-handoff/tasks.md',
            kind: 'tasks',
            sha256: 'b'.repeat(64),
            version: 1,
            updatedAt: null,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join(' ')).toMatch(/spec/i);
    }
  });

  it('rejeita format desconhecido', () => {
    const result = validateSpeckitManifest(validManifest({ format: 'outro/v9' as never }));
    expect(result.success).toBe(false);
  });

  it('rejeita sha256 que não é hex de 64 chars', () => {
    const result = validateSpeckitManifest(
      validManifest({
        documents: [
          {
            path: 'specs/42-handoff/spec.md',
            kind: 'spec',
            sha256: 'not-a-hash',
            version: 1,
            updatedAt: null,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejeita demand.id não positivo e devolve erros legíveis (nunca lança)', () => {
    const result = validateSpeckitManifest(
      validManifest({ demand: { id: 0, title: '', type: 't', priority: 'p' } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejeita entrada não-objeto sem lançar', () => {
    expect(validateSpeckitManifest(null).success).toBe(false);
    expect(validateSpeckitManifest('nope').success).toBe(false);
    expect(validateSpeckitManifest(undefined).success).toBe(false);
  });
});
