import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../server/db', () => ({
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
  isPostgres: false,
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { classifyTaskType, classifyByTokenCount } from '../server/services/task-classifier';
import { requestTelemetryService } from '../server/services/request-telemetry';

describe('TaskClassifier', () => {
  beforeEach(() => {
    process.env.CLASSIFICATION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.CLASSIFICATION_ENABLED;
  });

  describe('classifyTaskType', () => {
    it('classifies greetings as simple', () => {
      const result = classifyTaskType('Olá, bom dia!', 8);
      expect(result.taskType).toBe('simple');
      expect(result.confidence).toBeGreaterThan(0.3);
    });

    it('classifies yes/no responses as simple', () => {
      const result = classifyTaskType('Sim, pode continuar', 8);
      expect(result.taskType).toBe('simple');
    });

    it('classifies thank you as simple', () => {
      const result = classifyTaskType('Obrigado, era isso mesmo', 10);
      expect(result.taskType).toBe('simple');
    });

    it('classifies simple definitions as simple', () => {
      const result = classifyTaskType('O que é RADAR?', 12);
      expect(result.taskType).toBe('simple');
    });

    it('classifies status checks as simple', () => {
      const result = classifyTaskType(
        'Verificar status do deploy',
        12,
        'agent_interaction:refinador',
      );
      expect(result.taskType).toBe('simple');
    });

    it('classifies standard feature requests as intermediate', () => {
      const result = classifyTaskType(
        'Preciso criar uma nova funcionalidade de filtro avançado na listagem de demandas. O usuário deve poder filtrar por data, status, tipo e responsável.',
        120,
        'agent_interaction:refinador',
      );
      expect(result.taskType).toBe('intermediate');
    });

    it('classifies bug reports as intermediate', () => {
      const result = classifyTaskType(
        'O botão de salvar não está funcionando na tela de edição. Quando clico aparece um erro no console do navegador.',
        95,
        'agent_interaction:qa',
      );
      expect(result.taskType).toBe('intermediate');
    });

    it('classifies architecture redesigns as complex', () => {
      const result = classifyTaskType(
        'Precisamos redesenhar completamente a arquitetura de autenticação do sistema. Atualmente usamos JWT simples, mas precisamos migrar para OAuth 2.0 com refresh tokens, rotação de tokens, e integração com Keycloak.',
        350,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('complex');
    });

    it('classifies multi-component implementations as complex', () => {
      const result = classifyTaskType(
        'Implementar sistema de notificações em tempo real com WebSocket. Servidor WebSocket com rooms, sistema de filas Redis, fallback para polling, backpressure handling, persistência, API para marcar como lida.',
        320,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('complex');
    });

    it('classifies CI/CD pipeline creation as complex', () => {
      const result = classifyTaskType(
        'Criar pipeline CI/CD completo: lint, type-check, unit tests, integration tests, build, deploy staging, deploy produção, rollback automático.',
        310,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('complex');
    });

    it('classifies production incidents as critical', () => {
      const result = classifyTaskType(
        'URGENTE: Deploy para produção falhou e o sistema está fora do ar. Health check retornando 503. Precisamos fazer rollback imediato. Impacto: todos os usuários sem acesso.',
        180,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('critical');
    });

    it('classifies security vulnerabilities as critical', () => {
      const result = classifyTaskType(
        'Descobrimos uma vulnerabilidade de SQL injection no endpoint de busca. O payload malicioso permite extrair dados de qualquer tabela incluindo credenciais. Precisamos de hotfix imediato.',
        220,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('critical');
    });

    it('classifies compliance issues as critical', () => {
      const result = classifyTaskType(
        'Uma auditoria de compliance identificou não-conformidade no registro de operações financeiras. Temos 5 dias úteis para corrigir conforme a norma aplicável. Impacto: multa de R$ 500k/dia.',
        180,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('critical');
    });

    it('classifies financial data migration as critical', () => {
      const result = classifyTaskType(
        'Migrar 2.5 milhões de registros financeiros. Dados incluem transações e contratos. Regras: zero perda de dados, auditoria completa, conformidade regulatória.',
        280,
        'agent_interaction:tech_lead',
      );
      expect(result.taskType).toBe('critical');
    });

    it('uses operation hints for classification operations', () => {
      const result = classifyTaskType('Classifique esta demanda', 20, 'classification:demand_type');
      expect(result.taskType).toBe('simple');
    });

    it('uses internal taskType hints', () => {
      const result = classifyTaskType('Process this data', 50, undefined, 'classification');
      expect(result.taskType).toBe('simple');
    });

    it('detects code blocks as complex signal', () => {
      const result = classifyTaskType(
        'Refatorar este código:\n```typescript\nclass Service {\n  async process() {\n    // complex logic\n  }\n}\n```\nAdicionar error handling e testes.',
        200,
        'agent_interaction:tech_lead',
      );
      expect(['complex', 'intermediate']).toContain(result.taskType);
    });

    it('returns unknown when classification is disabled', async () => {
      // Dynamically mock isClassificationEnabled for this test
      const telemetry = await import('../server/services/request-telemetry');
      const spy = vi.spyOn(telemetry, 'isClassificationEnabled').mockReturnValue(false);
      try {
        const result = classifyTaskType('Teste de classificação', 50);
        expect(result.taskType).toBe('unknown');
        expect(result.confidence).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('includes signals in the result', () => {
      const result = classifyTaskType('Olá, bom dia!', 8);
      expect(result.signals).toBeInstanceOf(Array);
      expect(result.signals.length).toBeGreaterThan(0);
    });
  });

  describe('classifyByTokenCount', () => {
    it('classifies very short prompts as simple', () => {
      expect(classifyByTokenCount(50)).toBe('simple');
    });

    it('classifies medium prompts as intermediate', () => {
      expect(classifyByTokenCount(400)).toBe('intermediate');
    });

    it('classifies long prompts as complex', () => {
      expect(classifyByTokenCount(1500)).toBe('complex');
    });

    it('returns unknown when classification is disabled', async () => {
      const telemetry = await import('../server/services/request-telemetry');
      const spy = vi.spyOn(telemetry, 'isClassificationEnabled').mockReturnValue(false);
      try {
        expect(classifyByTokenCount(50)).toBe('unknown');
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('Ground Truth Validation', () => {
  beforeEach(() => {
    process.env.CLASSIFICATION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.CLASSIFICATION_ENABLED;
  });

  it('loads the ground truth fixture', () => {
    const groundTruth = require('./fixtures/classification_ground_truth.json');
    expect(groundTruth.requests).toHaveLength(50);
    expect(groundTruth.target_accuracy_pct).toBe(70);
  });

  it('has unique IDs', () => {
    const groundTruth = require('./fixtures/classification_ground_truth.json');
    const ids = groundTruth.requests.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all task types', () => {
    const groundTruth = require('./fixtures/classification_ground_truth.json');
    const types = new Set(groundTruth.requests.map((r: any) => r.expectedTaskType));
    expect(types.has('simple')).toBe(true);
    expect(types.has('intermediate')).toBe(true);
    expect(types.has('complex')).toBe(true);
    expect(types.has('critical')).toBe(true);
  });

  it('achieves >= 70% accuracy on ground truth (PRD requirement)', () => {
    const groundTruth = require('./fixtures/classification_ground_truth.json');
    let correct = 0;
    let total = 0;
    const failures: Array<{ id: string; expected: string; got: string; prompt: string }> = [];

    for (const request of groundTruth.requests) {
      const result = classifyTaskType(request.prompt, request.tokenCount, request.operation);
      total++;

      if (result.taskType === request.expectedTaskType) {
        correct++;
      } else {
        failures.push({
          id: request.id,
          expected: request.expectedTaskType,
          got: result.taskType,
          prompt: request.prompt.slice(0, 80),
        });
      }
    }

    const accuracy = (correct / total) * 100;
    console.log(`\nClassification accuracy: ${accuracy.toFixed(1)}% (${correct}/${total})`);
    if (failures.length > 0) {
      console.log(`Misclassified (${failures.length}):`);
      for (const f of failures) {
        console.log(`  ${f.id}: expected=${f.expected}, got=${f.got} | "${f.prompt}..."`);
      }
    }

    expect(accuracy).toBeGreaterThanOrEqual(70);
  });
});

describe('RequestTelemetryService', () => {
  it('exports the singleton service', () => {
    expect(requestTelemetryService).toBeDefined();
    expect(typeof requestTelemetryService.recordEvent).toBe('function');
    expect(typeof requestTelemetryService.getMetricsReport).toBe('function');
    expect(typeof requestTelemetryService.getClassificationStats).toBe('function');
  });

  it('returns empty metrics when no data', async () => {
    const report = await requestTelemetryService.getMetricsReport();

    expect(report.byTaskType).toBeInstanceOf(Array);
    expect(report.byModel).toBeInstanceOf(Array);
    expect(report.totals.requestCount).toBe(0);
    expect(report.classificationAccuracy).toBeDefined();
  });

  it('returns classification stats', () => {
    const stats = requestTelemetryService.getClassificationStats();

    expect(stats).toHaveProperty('totalClassified');
    expect(stats).toHaveProperty('correctClassifications');
    expect(stats).toHaveProperty('accuracyPct');
    expect(stats).toHaveProperty('autoDisabled');
  });
});
