import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import type { Demand } from '../shared/schema';
import {
  MODEL_MINI,
  MODEL_NANO,
  ModelRoutingService,
  isModelRoutingFailureReason,
} from '../server/services/model-routing';

function createTestDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

const baseDemand = {
  id: 1,
  title: 'Roteamento híbrido',
  description: 'Reduzir custo com fallback objetivo.',
  type: 'melhoria',
  priority: 'media',
} as Demand;

describe('ModelRoutingService', () => {
  let activeDb: Database.Database | null = null;

  afterEach(() => {
    activeDb?.close();
    activeDb = null;
  });

  it('uses nano for router classification', () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new ModelRoutingService(testDb.db);

    expect(service.classifyRouterModel()).toBe(MODEL_NANO);
  });

  it('chooses mini for critical validation stages and nano for low-risk operational stages', () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new ModelRoutingService(testDb.db);

    expect(
      service.decideStageModel({
        demand: baseDemand,
        stageName: 'template_validator',
      }).model,
    ).toBe(MODEL_MINI);

    expect(
      service.decideStageModel({
        demand: { ...baseDemand, priority: 'baixa' },
        stageName: 'agent:ux',
        classification: {
          category: 'creative',
          criteria: {
            ambiguity: 10,
            interpretationRisk: 10,
            depthRequired: 20,
            complexity: 25,
            urgency: 20,
          },
          confidence: 90,
          recommendedAgents: ['ux'],
          notes: '',
          personalReadiness: {
            score: 90,
            level: 'ready',
            blockers: [],
            nextQuestions: [],
            recommendation: 'Pode executar.',
          },
        },
      }).model,
    ).toBe(MODEL_NANO);
  });

  it('persists stage runs with closed failure reasons', async () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new ModelRoutingService(testDb.db);

    expect(isModelRoutingFailureReason('validation_failed')).toBe(true);
    expect(isModelRoutingFailureReason('confidence_low')).toBe(false);

    await service.recordStageRun({
      demandId: 1,
      executionId: 'exec-test',
      stageName: 'template_validator',
      modelUsed: MODEL_NANO,
      attemptIndex: 1,
      status: 'fallback_triggered',
      validationPassed: false,
      validationErrorsCount: 2,
      failureReason: 'validation_failed',
    });

    const rows = await service.getDemandStageRuns(1, 'exec-test');
    expect(rows).toHaveLength(1);
    expect(rows[0].stageName).toBe('template_validator');
    expect(rows[0].modelUsed).toBe(MODEL_NANO);
    expect(rows[0].failureReason).toBe('validation_failed');
  });

  it('enforces retry budget and returns budget_exhausted deterministically', () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new ModelRoutingService(testDb.db);

    const first = service.shouldFallback({
      demandId: 1,
      stageName: 'qa',
      attemptIndex: 1,
      failureReason: 'qa_failed_critical',
    });
    expect(first.allowed).toBe(true);
    expect(first.nextAttemptIndex).toBe(2);

    const exhausted = service.shouldFallback({
      demandId: 1,
      stageName: 'qa',
      attemptIndex: first.budget.maxAttemptsPerStage,
      failureReason: 'qa_failed_critical',
    });
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.failureReason).toBe('budget_exhausted');
  });
});
