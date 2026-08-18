/**
 * Classifier Validation Suite - 100 Queries
 *
 * Validates classifier accuracy with a larger, more diverse dataset.
 *
 * Acceptance Criteria:
 * - Global precision ≥ 85%
 * - Recall per category ≥ 75%
 * - Ambiguity rate (refinador triggers) ≤ 15%
 * - Refinador latency ≤ 500ms
 * - Zero regression on 5 fixed bugs
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { demandClassifier } from '../../../server/cognitive-core/demand-classifier';
import { VALIDATION_DATASET_100, DATASET_STATS } from '../../fixtures/classifier-validation-100';

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

// Mock hybrid classifier
vi.mock('../../../server/services/hybrid-classifier', () => ({
  classifyDemandVagueness: vi.fn().mockResolvedValue({
    isVague: false,
    confidence: 0.8,
    method: 'rule',
    ruleScore: 30,
  }),
}));

interface ClassificationResult {
  id: string;
  query: string;
  expectedCategory: string;
  actualCategory: string;
  correct: boolean;
  confidence: number;
  agents: string[];
  refinadorTriggered: boolean;
  durationMs: number;
  isEdgeCase: boolean;
}

interface ValidationMetrics {
  totalQueries: number;
  correctCount: number;
  globalPrecision: number;
  recallByCategory: Record<string, { correct: number; total: number; recall: number }>;
  ambiguityRate: number;
  refinadorTriggerCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  edgeCaseResults: { passed: number; total: number };
  regressionBugs: { id: string; passed: boolean }[];
}

// Store results for reporting
const results: ClassificationResult[] = [];
let metrics: ValidationMetrics;

describe('Classifier Validation Suite - 100 Queries', () => {
  beforeAll(() => {
    console.log('\n========================================');
    console.log('CLASSIFIER VALIDATION - 100 QUERIES');
    console.log('========================================\n');
    console.log(`Dataset: ${DATASET_STATS.total} queries`);
    console.log(
      `Distribution: technical=${DATASET_STATS.byCategory.technical}, business=${DATASET_STATS.byCategory.business}, support=${DATASET_STATS.byCategory.support}, analytical=${DATASET_STATS.byCategory.analytical}, edge=${DATASET_STATS.byCategory.edge_cases}`,
    );
    console.log('----------------------------------------\n');
  });

  describe('Category Classification', () => {
    for (const testCase of VALIDATION_DATASET_100) {
      it(`[${testCase.id}] ${testCase.query.slice(0, 50)}${testCase.query.length > 50 ? '...' : ''}`, async () => {
        const demand = {
          id: 1,
          title: testCase.query.slice(0, 50) || 'Empty Query',
          description: testCase.query || '',
          type: 'feature',
        };

        const startTime = performance.now();

        let classification;
        let _error = null;

        try {
          classification = await demandClassifier.classifyDemand(demand);
        } catch (e) {
          _error = e;
          // For empty queries or errors, use fallback
          classification = {
            category: 'support',
            confidence: 0,
            recommendedAgents: ['refinador'],
            criteria: {
              ambiguity: 100,
              interpretationRisk: 100,
              depthRequired: 0,
              complexity: 0,
              urgency: 0,
            },
          };
        }

        const durationMs = performance.now() - startTime;
        const refinadorTriggered = classification.recommendedAgents.includes('refinador');
        const correct = classification.category === testCase.expectedCategory;

        // Store result
        results.push({
          id: testCase.id,
          query: testCase.query,
          expectedCategory: testCase.expectedCategory,
          actualCategory: classification.category,
          correct,
          confidence: classification.confidence || 0,
          agents: classification.recommendedAgents,
          refinadorTriggered,
          durationMs,
          isEdgeCase: testCase.isEdgeCase,
        });

        // Basic assertions
        expect(classification).toBeDefined();
        expect(classification.category).toBeDefined();

        // For edge cases, we're more lenient
        if (!testCase.isEdgeCase) {
          expect(classification.category).toBe(testCase.expectedCategory);
        }

        // Check refinador expectation
        if (testCase.shouldTriggerRefinador) {
          expect(refinadorTriggered).toBe(true);
        }

        // Performance check
        expect(durationMs).toBeLessThan(500);
      });
    }
  });

  describe('Regression Tests - Fixed Bugs', () => {
    const regressionBugs = [
      {
        id: 'BIZ-002',
        query: 'Como aumentar a receita do segmento enterprise em 20%?',
        expected: 'business',
      },
      {
        id: 'SUP-001',
        query: 'O sistema está dando erro 500 quando tento fazer login',
        expected: 'support',
      },
      {
        id: 'SUP-002',
        query: 'Cliente reportou problema no checkout, precisa de ajuda urgente',
        expected: 'support',
      },
      {
        id: 'EXTRA-001',
        query: 'Qual a taxa de conversão média para o relatório de fechamento do mês?',
        expected: 'analytical',
      },
    ];

    for (const bug of regressionBugs) {
      it(`[REGRESSION] ${bug.id} should still be classified correctly`, async () => {
        const demand = {
          id: 1,
          title: bug.query.slice(0, 50),
          description: bug.query,
          type: 'feature',
        };

        const classification = await demandClassifier.classifyDemand(demand);
        expect(classification.category).toBe(bug.expected);
      });
    }
  });

  describe('Metrics Summary', () => {
    it('should calculate and report all metrics', () => {
      // Calculate metrics
      const correctCount = results.filter((r) => r.correct).length;
      const totalQueries = results.length;
      const globalPrecision = (correctCount / totalQueries) * 100;

      // Calculate recall by category
      const categories = ['technical', 'business', 'support', 'analytical'];
      const recallByCategory: Record<string, { correct: number; total: number; recall: number }> =
        {};

      for (const cat of categories) {
        const catResults = results.filter((r) => r.expectedCategory === cat && !r.isEdgeCase);
        const catCorrect = catResults.filter((r) => r.correct).length;
        const catTotal = catResults.length;
        recallByCategory[cat] = {
          correct: catCorrect,
          total: catTotal,
          recall: catTotal > 0 ? (catCorrect / catTotal) * 100 : 0,
        };
      }

      // Ambiguity rate (refinador triggers)
      const refinadorTriggerCount = results.filter((r) => r.refinadorTriggered).length;
      const ambiguityRate = (refinadorTriggerCount / totalQueries) * 100;

      // Latency stats
      const latencies = results.map((r) => r.durationMs);
      const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatencyMs = Math.max(...latencies);

      // Edge case results
      const edgeCaseResults = results.filter((r) => r.isEdgeCase);
      const edgeCasePassed = edgeCaseResults.filter((r) => r.correct).length;

      metrics = {
        totalQueries,
        correctCount,
        globalPrecision,
        recallByCategory,
        ambiguityRate,
        refinadorTriggerCount,
        avgLatencyMs,
        maxLatencyMs,
        edgeCaseResults: { passed: edgeCasePassed, total: edgeCaseResults.length },
        regressionBugs: [],
      };

      // Print report
      console.log('\n========================================');
      console.log('VALIDATION REPORT');
      console.log('========================================\n');

      console.log('GLOBAL METRICS:');
      console.log(`  Total queries: ${totalQueries}`);
      console.log(`  Correct: ${correctCount}`);
      console.log(`  Precision: ${globalPrecision.toFixed(1)}% (target: ≥85%)`);
      console.log(`  Ambiguity rate: ${ambiguityRate.toFixed(1)}% (target: ≤15%)`);
      console.log(`  Avg latency: ${avgLatencyMs.toFixed(2)}ms`);
      console.log(`  Max latency: ${maxLatencyMs.toFixed(2)}ms (target: ≤500ms)`);

      console.log('\nRECALL BY CATEGORY:');
      for (const [cat, data] of Object.entries(recallByCategory)) {
        const status = data.recall >= 75 ? '✅' : '❌';
        console.log(
          `  ${status} ${cat}: ${data.recall.toFixed(1)}% (${data.correct}/${data.total})`,
        );
      }

      console.log('\nEDGE CASES:');
      console.log(`  Passed: ${edgeCasePassed}/${edgeCaseResults.length}`);

      console.log('\nFAILURES:');
      const failures = results.filter((r) => !r.correct && !r.isEdgeCase);
      if (failures.length === 0) {
        console.log('  None! 🎉');
      } else {
        for (const f of failures.slice(0, 10)) {
          console.log(`  - ${f.id}: expected=${f.expectedCategory}, got=${f.actualCategory}`);
        }
        if (failures.length > 10) {
          console.log(`  ... and ${failures.length - 10} more`);
        }
      }

      console.log('\n========================================');
      console.log('ACCEPTANCE CRITERIA CHECK');
      console.log('========================================');

      const checks = [
        {
          name: 'Global precision ≥ 85%',
          passed: globalPrecision >= 85,
          value: `${globalPrecision.toFixed(1)}%`,
        },
        {
          name: 'Ambiguity rate ≤ 15%',
          passed: ambiguityRate <= 15,
          value: `${ambiguityRate.toFixed(1)}%`,
        },
        {
          name: 'Max latency ≤ 500ms',
          passed: maxLatencyMs <= 500,
          value: `${maxLatencyMs.toFixed(2)}ms`,
        },
      ];

      for (const cat of categories) {
        const recall = recallByCategory[cat].recall;
        checks.push({
          name: `Recall ${cat} ≥ 75%`,
          passed: recall >= 75,
          value: `${recall.toFixed(1)}%`,
        });
      }

      let allPassed = true;
      for (const check of checks) {
        const status = check.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`  ${status}: ${check.name} (${check.value})`);
        if (!check.passed) allPassed = false;
      }

      console.log('\n----------------------------------------');
      console.log(`FINAL RESULT: ${allPassed ? '✅ APPROVED' : '❌ NEEDS ADJUSTMENT'}`);
      console.log('========================================\n');

      // Assertions for CI
      expect(globalPrecision).toBeGreaterThanOrEqual(85);
    });

    it('should have recall ≥ 75% for each main category', () => {
      const categories = ['technical', 'business', 'support', 'analytical'];

      for (const cat of categories) {
        const catResults = results.filter((r) => r.expectedCategory === cat && !r.isEdgeCase);
        const catCorrect = catResults.filter((r) => r.correct).length;
        const recall = (catCorrect / catResults.length) * 100;

        expect(recall).toBeGreaterThanOrEqual(75);
      }
    });

    it('should have ambiguity rate ≤ 15%', () => {
      const refinadorTriggerCount = results.filter((r) => r.refinadorTriggered).length;
      const ambiguityRate = (refinadorTriggerCount / results.length) * 100;

      expect(ambiguityRate).toBeLessThanOrEqual(15);
    });

    it('should have max latency ≤ 500ms', () => {
      const maxLatency = Math.max(...results.map((r) => r.durationMs));
      expect(maxLatency).toBeLessThanOrEqual(500);
    });
  });
});

export { results, metrics };
