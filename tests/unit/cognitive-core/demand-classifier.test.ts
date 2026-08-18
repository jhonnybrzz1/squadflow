import { describe, it, expect, vi } from 'vitest';
import { demandClassifier } from '../../../server/cognitive-core/demand-classifier';

// Mock db to avoid better-sqlite3 native binding errors
vi.mock('../../../server/db', () => ({
  isPostgres: false,
  db: {
    query: {
      demands: { findFirst: vi.fn() },
    },
  },
}));

// Mock dependencies
vi.mock('../../../server/repositories/demand-repository', () => ({
  demandRepository: {
    update: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../../server/services/openai-ai', () => ({
  aiService: {
    evaluateComplexityAndImpact: vi.fn().mockResolvedValue({
      complexity: 65,
      impact: 80,
      confidence: 0.9,
      reasoning: 'Test reasoning',
      suggestedAgents: ['architecture_expert'],
    }),
  },
}));

describe('DemandClassifier', () => {
  it('should correctly classify a demand based on complexity', async () => {
    const demand: any = {
      id: 1,
      title: 'Test Demand',
      description: 'Test description',
      type: 'feature',
    };

    const classification = await demandClassifier.classifyDemand(demand);

    expect(classification).toBeDefined();
    expect(classification.category).toBe('technical');
    expect(typeof classification.criteria.complexity).toBe('number');
    expect(classification.recommendedAgents).toBeInstanceOf(Array);
  });

  it('recommends the Security Specialist for security demands', async () => {
    const classification = await demandClassifier.classifyDemand({
      id: 9,
      title: 'Vulnerabilidade LGPD',
      description: 'Corrigir segurança e proteção de dados pessoais.',
      type: 'security',
      priority: 'alta',
    } as any);

    expect(classification.recommendedAgents).toContain('security_specialist');
    expect(classification.category).toBe('legal');
    expect(classification.routerContract?.tipo_demanda).toBe('security');
  });

  it('uses registry category and squad for refactoring demands', async () => {
    const classification = await demandClassifier.classifyDemand({
      id: 11,
      title: 'Refatorar módulo de pagamentos',
      description: 'Reduzir débito técnico preservando comportamento e testes de regressão.',
      type: 'refactoring',
      priority: 'media',
    } as any);

    expect(classification.category).toBe('technical');
    expect(classification.recommendedAgents).toContain('architect');
    expect(classification.routerContract?.tipo_demanda).toBe('refactoring');
  });

  it('recommends Architect for infrastructure demands', async () => {
    const classification = await demandClassifier.classifyDemand({
      id: 10,
      title: 'Migração de cloud',
      description: 'Planejar infraestrutura, observabilidade e rollback do deploy.',
      type: 'infraestrutura',
      priority: 'alta',
      domain: 'padrao',
    } as any);

    expect(classification.category).toBe('technical');
    expect(classification.recommendedAgents).toContain('architect');
    expect(classification.routerContract?.tipo_demanda).toBe('infraestrutura');
  });

  it('routes domain specialists without replacing the base squad', async () => {
    const legaltech = await demandClassifier.classifyDemand({
      id: 12,
      title: 'Dados pessoais',
      description: 'Avaliar riscos de privacidade e LGPD.',
      type: 'security',
      priority: 'alta',
      domain: 'legaltech_lgpd',
    } as any);

    expect(legaltech.recommendedAgents).toContain('security_specialist');
  });
});
