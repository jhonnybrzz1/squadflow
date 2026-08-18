/**
 * Demanda 10111 — Classificador determinístico de tipos de demanda.
 */
import { describe, expect, it } from 'vitest';
import { classifyDemandTypeF1, getDemandStartContract } from '../../shared/demand-start-contract';
import { DEMAND_TYPES, isDemandType } from '../../shared/demand-types';

describe('Classificador determinístico de tipos de demanda', () => {
  it('classifica "melhorar velocidade do filtro" como melhoria', () => {
    const result = classifyDemandTypeF1({
      title: 'melhorar velocidade do filtro',
      description: '',
    });
    expect(result.suggestedType).toBe('melhoria');
    expect(result.fallback).toBe(false);
  });

  it('classifica "revisar se demanda X foi entregue conforme spec" como revisao', () => {
    const result = classifyDemandTypeF1({
      title: 'revisar se demanda X foi entregue conforme spec',
      description: '',
    });
    expect(result.suggestedType).toBe('revisao');
    expect(result.fallback).toBe(false);
  });

  it('classifica "criar dashboard de métricas" como nova_funcionalidade', () => {
    const result = classifyDemandTypeF1({
      title: 'criar dashboard de métricas',
      description: '',
    });
    expect(result.suggestedType).toBe('nova_funcionalidade');
    expect(result.fallback).toBe(false);
  });

  it('classifica "avaliar viabilidade de cache" como analise_exploratoria', () => {
    const result = classifyDemandTypeF1({
      title: 'avaliar viabilidade de cache',
      description: '',
    });
    expect(result.suggestedType).toBe('analise_exploratoria');
    expect(result.fallback).toBe(false);
  });

  it('não sugere discovery para a própria demanda 10111', () => {
    const result = classifyDemandTypeF1({
      title: 'sugestão de contrato de inicio nao diferenciam em demandas',
      description: 'Muitos momentos um incremento e lido como nova feature',
    });
    expect(result.suggestedType).not.toBe('discovery');
  });

  it('template de revisao tem 3 campos obrigatórios', () => {
    const contract = getDemandStartContract('revisao');
    expect(contract.fields.length).toBe(3);
    expect(contract.fields.every((f) => f.required)).toBe(true);
    expect(contract.fields.map((f) => f.id)).toEqual([
      'review_original_demand',
      'review_acceptance_criteria',
      'review_result',
    ]);
  });

  it('tipo revisao está registrado em DEMAND_TYPES e no schema', () => {
    expect(isDemandType('revisao')).toBe(true);
    expect(DEMAND_TYPES.revisao).toBeDefined();
    expect(DEMAND_TYPES.revisao.description).toBe(
      'Validar se uma entrega foi construída conforme spec.',
    );
  });
});
