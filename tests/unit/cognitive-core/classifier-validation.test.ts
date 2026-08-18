/**
 * Classifier Validation Test Suite
 *
 * Dataset de 10 consultas rotuladas para validar o classificador.
 * Meta: ≥ 85% de precisão (≥ 9/10 corretas)
 *
 * Categorias testadas:
 * - technical (2 consultas)
 * - business (2 consultas)
 * - support (2 consultas)
 * - ambiguous/fallback (2 consultas)
 * - analytical/technical extra (2 consultas)
 */

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
      complexity: 50,
      impact: 50,
      confidence: 0.8,
      reasoning: 'Mock reasoning',
      suggestedAgents: [],
    }),
  },
}));

// Mock hybrid classifier to avoid embedding calls
vi.mock('../../../server/services/hybrid-classifier', () => ({
  classifyDemandVagueness: vi.fn().mockResolvedValue({
    isVague: false,
    confidence: 0.8,
    method: 'rule',
    ruleScore: 30,
  }),
}));

/**
 * Validation Dataset - 10 queries with expected classifications
 */
interface ValidationCase {
  id: string;
  query: string;
  description: string;
  expectedCategory: string;
  expectedAgentsContain?: string[];
  shouldTriggerRefinador?: boolean;
  notes?: string;
}

const VALIDATION_DATASET: ValidationCase[] = [
  // ============================================
  // TECHNICAL (2 queries)
  // ============================================
  {
    id: 'TECH-001',
    query: 'Preciso criar uma API REST para integração com o sistema de pagamentos',
    description: 'Integração de API com sistema externo',
    expectedCategory: 'technical',
    expectedAgentsContain: ['tech_lead'],
    notes: 'Keywords: API, integração, sistema',
  },
  {
    id: 'TECH-002',
    query: 'O banco de dados PostgreSQL está lento, preciso otimizar as queries do backend',
    description: 'Performance issue no database',
    expectedCategory: 'technical',
    expectedAgentsContain: ['tech_lead'],
    notes: 'Keywords: banco de dados, backend, queries',
  },

  // ============================================
  // BUSINESS (2 queries)
  // ============================================
  {
    id: 'BIZ-001',
    query: 'Precisamos definir a estratégia de go-to-market para o novo produto',
    description: 'Estratégia de lançamento de produto',
    expectedCategory: 'business',
    expectedAgentsContain: ['product_manager'],
    notes: 'Keywords: estratégia, produto, market',
  },
  {
    id: 'BIZ-002',
    query: 'Como aumentar a receita do segmento enterprise em 20%?',
    description: 'Crescimento de receita',
    expectedCategory: 'business',
    expectedAgentsContain: ['product_manager'],
    notes: 'Keywords: receita, revenue, growth',
  },

  // ============================================
  // SUPPORT (2 queries)
  // ============================================
  {
    id: 'SUP-001',
    query: 'O sistema está dando erro 500 quando tento fazer login',
    description: 'Bug de autenticação',
    expectedCategory: 'support',
    notes: 'Keywords: erro, error, bug',
  },
  {
    id: 'SUP-002',
    query: 'Cliente reportou problema no checkout, precisa de ajuda urgente',
    description: 'Ticket de suporte urgente',
    expectedCategory: 'support',
    notes: 'Keywords: problema, ajuda, help, issue',
  },

  // ============================================
  // AMBIGUOUS / FALLBACK (2 queries)
  // ============================================
  {
    id: 'AMB-001',
    query: 'Quero melhorar as coisas',
    description: 'Consulta vaga sem contexto',
    expectedCategory: 'technical', // fallback default
    shouldTriggerRefinador: false,
    notes:
      'Implementação atual usa threshold ambiguity>85 (rígido) para manter ambiguity rate ≤15%. Queries vagas curtas não disparam refinador via heurística de keywords vague.',
  },
  {
    id: 'AMB-002',
    query: 'Tem como fazer diferente?',
    description: 'Consulta ambígua sem especificidade',
    expectedCategory: 'technical', // fallback default
    shouldTriggerRefinador: false,
    notes:
      'Implementação atual usa threshold ambiguity>85 (rígido) para manter ambiguity rate ≤15%. Queries curtas não disparam refinador.',
  },

  // ============================================
  // ANALYTICAL / TECHNICAL EXTRA (2 queries)
  // ============================================
  {
    id: 'EXTRA-001',
    query: 'Preciso de um relatório com as métricas de vendas e o dashboard do mês',
    description: 'Solicitação de relatório analítico',
    expectedCategory: 'analytical', // data/analysis related
    notes: 'Domain: dados, relatório, métricas',
  },
  {
    id: 'EXTRA-002',
    query: 'Como configurar a integração da API com o sistema de deploy?',
    description: 'Processo técnico de integração',
    expectedCategory: 'technical', // process/system related
    notes: 'Domain: API, integração, sistema',
  },
];

describe('Classifier Validation Suite', () => {
  // Track results for summary
  const results: { id: string; passed: boolean; reason?: string }[] = [];

  describe('Category Classification', () => {
    for (const testCase of VALIDATION_DATASET) {
      it(`[${testCase.id}] ${testCase.description}`, async () => {
        const demand = {
          id: 1,
          title: testCase.query.slice(0, 50),
          description: testCase.query,
          type: 'feature',
        };

        const startTime = Date.now();
        const classification = await demandClassifier.classifyDemand(demand);
        const durationMs = Date.now() - startTime;

        // Basic validation
        expect(classification).toBeDefined();
        expect(classification.category).toBeDefined();

        // Category check
        const categoryMatch = classification.category === testCase.expectedCategory;

        // Agent check (if specified)
        let agentMatch = true;
        if (testCase.expectedAgentsContain) {
          agentMatch = testCase.expectedAgentsContain.every((agent) =>
            classification.recommendedAgents.includes(agent),
          );
        }

        // Refinador check for ambiguous queries
        let refinadorMatch = true;
        if (testCase.shouldTriggerRefinador) {
          refinadorMatch = classification.recommendedAgents.includes('refinador');
        }

        // Performance check (should be < 1s for unit test)
        expect(durationMs).toBeLessThan(1000);

        // Record result
        results.push({
          id: testCase.id,
          passed: categoryMatch && agentMatch && refinadorMatch,
          reason: !categoryMatch
            ? `Expected ${testCase.expectedCategory}, got ${classification.category}`
            : !agentMatch
              ? `Missing expected agents`
              : !refinadorMatch
                ? `Should have triggered refinador`
                : undefined,
        });

        // Log for debugging
        console.log(
          `[${testCase.id}] Category: ${classification.category}, Agents: ${classification.recommendedAgents.join(', ')}, Duration: ${durationMs}ms`,
        );

        // Assert category (primary check)
        expect(classification.category).toBe(testCase.expectedCategory);

        // Assert agents if specified
        if (testCase.expectedAgentsContain) {
          for (const agent of testCase.expectedAgentsContain) {
            expect(classification.recommendedAgents).toContain(agent);
          }
        }

        // Assert refinador for ambiguous
        if (testCase.shouldTriggerRefinador) {
          expect(classification.recommendedAgents).toContain('refinador');
        }
      });
    }
  });

  describe('Validation Summary', () => {
    it('should achieve ≥ 85% accuracy (9/10 correct)', () => {
      const passed = results.filter((r) => r.passed).length;
      const total = results.length;
      const accuracy = (passed / total) * 100;

      console.log('\n========================================');
      console.log('VALIDATION SUMMARY');
      console.log('========================================');
      console.log(`Total: ${total}`);
      console.log(`Passed: ${passed}`);
      console.log(`Failed: ${total - passed}`);
      console.log(`Accuracy: ${accuracy.toFixed(1)}%`);
      console.log(`Target: ≥ 85%`);
      console.log('----------------------------------------');

      // Log failures
      const failures = results.filter((r) => !r.passed);
      if (failures.length > 0) {
        console.log('FAILURES:');
        for (const f of failures) {
          console.log(`  - ${f.id}: ${f.reason}`);
        }
      }

      console.log('========================================\n');

      // Meta: 85% = 8.5, arredondando para 9
      expect(passed).toBeGreaterThanOrEqual(9);
    });
  });
});

/**
 * Export dataset for use in other tests or scripts
 */
export { VALIDATION_DATASET, type ValidationCase };
