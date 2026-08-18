import { metricsCollector as perfMetricsCollector } from '../metrics/collector';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validate-request';
import { adminAuthMiddleware } from '../middleware/auth-stub';
import { adminAuditMiddleware } from '../middleware/admin-audit';
import { aiUsageTracker } from '../services/ai-usage-tracker';
import { ragSubstepMetrics } from '../services/rag-substep-metrics';
import { rerankTelemetryService } from '../services/rerank-telemetry';
import { QualityIndexService } from '../services/quality-index-service';
import { llmMetricsCollector } from '../services/llm-metrics-collector';
import { asyncHandler, AppError } from '../middleware/error-handler';
// (Add other necessary imports here)

const router = Router();

const performanceQuerySchema = z.object({
  query: z.object({
    since: z.coerce.number().positive().optional(),
  }),
});

router.get(
  '/api/metrics/performance',
  validateRequest(performanceQuerySchema),
  (req: Request, res: Response) => {
    const since = req.query.since as unknown as number | undefined;
    const baseline = perfMetricsCollector.exportBaseline(since);
    res.json(baseline);
  },
);

router.post(
  '/api/metrics/performance/clear',
  adminAuditMiddleware('clearMetrics'),
  adminAuthMiddleware,
  (_req: Request, res: Response) => {
    perfMetricsCollector.clear();
    res.json({ message: 'Metrics cleared' });
  },
);

const costOptimizationQuerySchema = z.object({
  query: z.object({
    window: z.coerce.number().positive().optional(),
  }),
});

router.get(
  '/api/metrics/cost-optimization',
  validateRequest(costOptimizationQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const windowMs = (req.query.window as unknown as number) ?? 15 * 60 * 1000;
    const { getCostMetrics } = require('../services/cost-metrics');
    const metrics = getCostMetrics(windowMs);
    res.json(metrics);
  }),
);

const rerankMetricsSchema = z.object({
  query: z.object({
    testId: z.string().optional(),
  }),
});

router.get(
  '/api/metrics/rerank',
  validateRequest(rerankMetricsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const testId = req.query.testId as string | undefined;
    const summary = await rerankTelemetryService.getMetricsSummary(testId);
    res.json(summary);
  }),
);

router.get(
  '/api/metrics/rag-substeps',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = ragSubstepMetrics.getStats();
    res.json({
      ...stats,
      thresholdMs: 200,
      aboveThreshold: stats.avgTotalMs > 200,
      timestamp: new Date().toISOString(),
    });
  }),
);

router.get(
  '/api/metrics/classification',
  asyncHandler(async (_req: Request, res: Response) => {
    const usageSummary = aiUsageTracker.getSummary();
    const classificationRecords = usageSummary.recent.filter((r) =>
      r.operation.startsWith('classification:vagueness:'),
    );

    const byMethod = { rule: 0, hybrid: 0, fallback: 0 };
    let totalCost = 0;
    let totalLatency = 0;

    for (const record of classificationRecords) {
      if (record.operation.includes(':rule')) byMethod.rule++;
      else if (record.operation.includes(':hybrid')) byMethod.hybrid++;
      else if (record.operation.includes(':fallback')) byMethod.fallback++;
      totalCost += record.estimatedCostUsd ?? 0;
      totalLatency += record.latencyMs;
    }

    const total = classificationRecords.length;
    res.json({
      total,
      byMethod,
      avgCostUsd: total > 0 ? totalCost / total : 0,
      avgLatencyMs: total > 0 ? totalLatency / total : 0,
      totalCostUsd: totalCost,
      ambiguousZone: { low: 30, high: 70 },
      timestamp: new Date().toISOString(),
    });
  }),
);

const qualityMetricsSchema = z.object({
  params: z.object({ demandId: z.coerce.number().positive() }),
});

router.get(
  '/api/metrics/quality/:demandId',
  validateRequest(qualityMetricsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = Number(req.params.demandId);
    const latest = await QualityIndexService.getLatestByDemand(demandId);
    if (!latest) {
      throw new AppError('Quality score not found', 404, 'NOT_FOUND');
    }
    res.json(latest);
  }),
);

/**
 * A-2: dashboard consolidado — latência, erro, custo por provedor, cache hit.
 */
router.get(
  '/api/metrics/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const summary = await llmMetricsCollector.getSummary();
    res.json({
      ...summary,
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
