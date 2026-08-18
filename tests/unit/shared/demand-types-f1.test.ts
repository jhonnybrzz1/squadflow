import { describe, expect, it } from 'vitest';
import { demandTypeSchema, DEMAND_TYPES } from '../../../shared/demand-types';
import {
  CLASSIFIER_FALLBACK_THRESHOLD,
  classifyDemandTypeF1,
} from '../../../shared/demand-start-contract';
import { F1_CLASSIFIER_PAYLOADS } from '../../fixtures/demand-type-f1-payloads';

describe('Spec 009 — tipos incrementais', () => {
  it('preserva os tipos legados e aceita os tipos das Fases 1/2', () => {
    const activeTypes = [
      'nova_funcionalidade',
      'melhoria',
      'bug',
      'discovery',
      'analise_exploratoria',
      'security',
      'refactoring',
      'infraestrutura',
    ];
    activeTypes.forEach((type) => expect(demandTypeSchema.parse(type)).toBe(type));
  });

  it('mantém as identidades visuais contratadas', () => {
    expect(DEMAND_TYPES.security).toMatchObject({ icon: 'ShieldAlert', color: '#e11d48' });
    expect(DEMAND_TYPES.refactoring).toMatchObject({ icon: 'Wrench', color: '#64748b' });
    expect(DEMAND_TYPES.infraestrutura).toMatchObject({
      icon: 'Cloud',
      color: '#6366f1',
    });
  });

  it('declara ausência de baseline e a origem dos defaults numéricos', () => {
    expect(DEMAND_TYPES.security).toMatchObject({
      measurementStatus: 'A MEDIR — sem baseline',
      configurationBasis: 'inherited:nova_funcionalidade',
      suggestedPriority: 'alta',
      maxEffortDays: 5,
    });
    expect(DEMAND_TYPES.refactoring).toMatchObject({
      measurementStatus: 'A MEDIR — sem baseline',
      configurationBasis: 'inherited:melhoria',
      maxEffortDays: 5,
    });
    expect(DEMAND_TYPES.infraestrutura).toMatchObject({
      measurementStatus: 'A MEDIR — sem baseline',
      configurationBasis: 'inherited:security',
      maxEffortDays: 5,
    });
  });

  it('mantém 0.7 por default e permite seam de avaliação sem mudar produção', () => {
    const payload = { title: 'Cloud', description: 'Ajustar infraestrutura' };
    expect(classifyDemandTypeF1(payload).fallback).toBe(false);
    expect(classifyDemandTypeF1(payload, { threshold: 0.9 }).fallback).toBe(true);
    expect(CLASSIFIER_FALLBACK_THRESHOLD).toBe(0.7);
  });

  it.each(F1_CLASSIFIER_PAYLOADS)('$id respeita o contrato do classificador', (payload) => {
    const result = classifyDemandTypeF1(payload);
    if (payload.expected === 'fallback') {
      expect(result.fallback).toBe(true);
      expect(result.confidence).toBeLessThan(CLASSIFIER_FALLBACK_THRESHOLD);
      expect(result.suggestedType).toBe('nova_funcionalidade');
    } else {
      expect(result.fallback).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_FALLBACK_THRESHOLD);
      expect(result.suggestedType).toBe(payload.expected);
    }
  });
});
