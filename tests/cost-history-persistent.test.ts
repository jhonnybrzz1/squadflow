/**
 * Testa a fonte persistente do dashboard de custo (item #2 do roadmap de observabilidade).
 *
 * O `aiUsageTracker` é in-memory e perde-se no restart. A fonte histórica vive na
 * tabela `ai_requests` (escrita por `requestTelemetryService`). Este teste garante
 * que `getCostHistory()` agrega corretamente custo por modelo, timeline, routing e
 * totais — ou seja, que o dashboard sobrevive a restarts lendo do DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbHelper } from '../server/db';
import { requestTelemetryService } from '../server/services/request-telemetry';

describe('Cost history persistente (ai_requests) — requestTelemetryService.getCostHistory', () => {
  beforeEach(async () => {
    // Garante o schema (idempotente) e limpa para um estado conhecido.
    await requestTelemetryService.getCostHistory({ limitDays: 1 }).catch(() => {});
    await dbHelper.run(sql`DELETE FROM ai_requests`);
  });

  it('retorna a shape do dashboard de custo agregando ai_requests por modelo', async () => {
    const now = Date.now();
    // Dois modelos, custos distintos, um fallback, um cache hit.
    await dbHelper.run(sql`
      INSERT INTO ai_requests (
        request_id, demand_id, model, provider, operation,
        latency_ms, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_usd,
        task_type_inferred, task_type_provided, classification_confidence,
        routing_mode, routing_reason,
        error, error_type, fallback_used, cache_hit, created_at
      ) VALUES
        ('r1', 1, 'openai:gpt-5.4-mini', 'openai', 'agent_interaction:po',
         1200, 1000, 500, 1500, 0.001, 'complex', NULL, 0.9,
         'economic', 'task_complex', 0, NULL, 0, 0, ${now}),
        ('r2', 1, 'openai:gpt-5.4-mini', 'openai', 'agent_interaction:po',
         800, 800, 400, 1200, 0.0008, 'complex', NULL, 0.9,
         'safe', 'governance', 0, NULL, 1, 0, ${now - 60_000}),
        ('r3', 2, 'mistral:mistral-large-3', 'mistral', 'agent_interaction:qa',
         3000, 2000, 1000, 3000, 0.005, 'critical', NULL, 0.95,
         'safe', 'task_critical', 0, NULL, 0, 1, ${now - 120_000})
    `);

    const result = await requestTelemetryService.getCostHistory({ limitDays: 7 });

    expect(result.source).toBe('persistent');
    expect(result.windowDays).toBe(7);

    // Totais
    expect(result.summary.totalRequests).toBe(3);
    expect(result.summary.totalTokens).toBe(5700);
    expect(result.summary.totalCostUsd).toBeCloseTo(0.0068, 6);
    expect(result.summary.avgCostPerRequest).toBeCloseTo(0.0068 / 3, 6);

    // Por modelo — ordenado por custo desc; mistral-large-3 custa mais por req
    expect(result.costByModel).toHaveLength(2);
    const mistral = result.costByModel.find((m) => m.model === 'mistral:mistral-large-3');
    const openai = result.costByModel.find((m) => m.model === 'openai:gpt-5.4-mini');
    expect(mistral).toBeDefined();
    expect(mistral?.requestCount).toBe(1);
    expect(mistral?.estimatedCostUsd).toBeCloseTo(0.005, 6);
    expect(openai?.requestCount).toBe(2);
    expect(openai?.estimatedCostUsd).toBeCloseTo(0.0018, 6);

    // Routing: 1 economic + 2 safe; 1 fallback dentre os routed (3)
    expect(result.routingEfficiency.economicRequests).toBe(1);
    expect(result.routingEfficiency.safeRequests).toBe(2);
    expect(result.routingEfficiency.fallbackRate).toBeCloseTo(1 / 3, 4);
    expect(result.routingEfficiency.economicRatio).toBeCloseTo(1 / 3, 4);

    // Cache: 1 hit em 3 requisições
    expect(result.cacheSavings.exactHits).toBe(1);
    expect(result.cacheSavings.cacheHitRate).toBeCloseTo(1 / 3, 4);
    // tokensSaved/costSavedUsd não estão em ai_requests → 0 (documentado)
    expect(result.cacheSavings.tokensSaved).toBe(0);
    expect(result.cacheSavings.costSavedUsd).toBe(0);

    // Timeline tem ao menos 1 bucket
    expect(result.timeline.length).toBeGreaterThanOrEqual(1);
    for (const bucket of result.timeline) {
      expect(bucket.bucket).toMatch(/^\d{2}:\d{2}$/);
      expect(bucket.requests).toBeGreaterThan(0);
    }
  });

  it('retorna zeros e shape válida quando não há registros (dashboard não quebra)', async () => {
    const result = await requestTelemetryService.getCostHistory({ limitDays: 7 });

    expect(result.source).toBe('persistent');
    expect(result.summary.totalRequests).toBe(0);
    expect(result.summary.totalCostUsd).toBe(0);
    expect(result.costByModel).toEqual([]);
    expect(result.timeline).toEqual([]);
    expect(result.routingEfficiency.economicRatio).toBe(0);
    expect(result.cacheSavings.cacheHitRate).toBe(0);
  });

  it('respeita a janela limitDays (exclui registros antigos)', async () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    await dbHelper.run(sql`
      INSERT INTO ai_requests (
        request_id, model, provider, operation, latency_ms,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
        task_type_inferred, routing_mode, error, fallback_used, cache_hit, created_at
      ) VALUES
        ('recent', 'openai:gpt-5.4-mini', 'openai', 'op', 100, 10, 10, 20, 0.0001,
         'simple', 'economic', 0, 0, 0, ${now}),
        ('old', 'openai:gpt-5.4-mini', 'openai', 'op', 100, 10, 10, 20, 0.0001,
         'simple', 'economic', 0, 0, 0, ${tenDaysAgo})
    `);

    const result7d = await requestTelemetryService.getCostHistory({ limitDays: 7 });
    expect(result7d.summary.totalRequests).toBe(1); // só o recente

    const result30d = await requestTelemetryService.getCostHistory({ limitDays: 30 });
    expect(result30d.summary.totalRequests).toBe(2); // ambos
  });
});
