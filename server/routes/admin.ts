import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validate-request';
import { asyncHandler, AppError, UnauthorizedError } from '../middleware/error-handler';
import { adminAuthMiddleware } from '../middleware/auth-stub';
import { env } from '../config/env';
import { reloadDomains } from '../services/domain-config';
import { db } from '../db';
import { demandRepository } from '../repositories/demand-repository';
import { aiResponseCache } from '../services/ai-cache';
import { aiUsageTracker } from '../services/ai-usage-tracker';
import { contextBuilder } from '../services/context-builder';
import { getCostMetrics } from '../services/cost-metrics';
import { setKillSwitchState, getKillSwitchState } from '../services/cost-routing';
import { featureFlags, type FeatureFlags } from '../services/feature-flags';
import { llmTracingService } from '../services/llm-tracing';
import { requestTelemetryService } from '../services/request-telemetry';
import adminModelsRouter from './admin-models';
import { rerankTelemetryService } from '../services/rerank-telemetry';
import { retentionPolicyService } from '../services/retention-policy';
import { semanticCacheService } from '../services/semantic-cache';
import { traceExporterService } from '../services/trace-exporter';
import { traceSamplingService } from '../services/trace-sampling';
import { logger } from '../utils/logger';
import { retentionWorker } from '../workers/retention-worker';
import { validateAdminKey } from './shared';
import { agentMemoryService } from '../services/agent-memory-service';
import { deadLetterService } from '../services/dead-letter-service';

const router = Router();

// Protege todas as rotas administrativas com o middleware unificado.
router.use(adminAuthMiddleware);

// Model Registry admin routes (aliases, candidates, promote, rollback)
router.use('/models', adminModelsRouter);

const configureRerankSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    rerankGroupPercent: z.number().min(0).max(100).optional(),
    testId: z.string().optional(),
  }),
});

router.post(
  '/rerank/configure',
  validateRequest(configureRerankSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { enabled, rerankGroupPercent, testId } = req.body;
    rerankTelemetryService.configureABTest({
      ...(enabled !== undefined && { enabled }),
      ...(rerankGroupPercent !== undefined && { rerankGroupPercent }),
      ...(testId !== undefined && { testId }),
    });
    res.json({ success: true, message: 'A/B test configuration updated' });
  }),
);

const getMetricsSchema = z.object({
  query: z.object({
    days: z.coerce.number().min(1).max(365).optional().default(14),
  }),
});

router.get(
  '/metrics',
  validateRequest(getMetricsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const limitDays = req.query.days ? parseInt(req.query.days as string) : 14;
    const report = await requestTelemetryService.getMetricsReport({ limitDays });
    res.json(report);
  }),
);

router.get('/classification/stats', (req: Request, res: Response) => {
  const stats = requestTelemetryService.getClassificationStats();
  res.json(stats);
});

// ============================================
// Feature Flags — toggles operacionais via UI admin
// ============================================

/**
 * Allowlist de flags editáveis pela UI. NUNCA exponha todas as flags: só as
 * seguras para um operador ligar/desligar, com rótulo em linguagem simples.
 */
const TOGGLEABLE_FLAGS: Array<{ key: keyof FeatureFlags; label: string; description: string }> = [
  {
    key: 'semanticInjectionClassifierEnabled',
    label: 'Proteção avançada contra mensagens maliciosas (IA)',
    description:
      'Usa um modelo de IA para detectar tentativas de manipulação que o filtro básico não pega. Ligado por padrão: detecções BLOQUEIAM a mensagem (spec 006/US5). Desligue aqui para voltar ao filtro básico sem deploy.',
  },
];

router.get(
  '/feature-flags',
  asyncHandler(async (_req: Request, res: Response) => {
    const flags = featureFlags.getFlags();
    const result = TOGGLEABLE_FLAGS.map((f) => ({
      key: f.key,
      label: f.label,
      description: f.description,
      enabled: flags[f.key] === true,
      overridden: featureFlags.hasOverride(f.key),
    }));
    res.json({ flags: result });
  }),
);

const updateFeatureFlagSchema = z.object({
  params: z.object({ key: z.string().min(1) }),
  body: z.object({ enabled: z.boolean() }),
});

router.put(
  '/feature-flags/:key',
  validateRequest(updateFeatureFlagSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;
    const meta = TOGGLEABLE_FLAGS.find((f) => f.key === key);
    if (!meta) {
      throw new AppError('Flag não editável ou inexistente', 404, 'NOT_FOUND', { key });
    }

    const enabled = Boolean(req.body.enabled);
    featureFlags.setOverride(meta.key, enabled);
    logger.info('Feature flag alterada via admin', {
      context: { key, enabled, admin: req.userContext?.id },
    });
    res.json({
      key,
      label: meta.label,
      description: meta.description,
      enabled,
      overridden: true,
    });
  }),
);

router.get(
  '/dashboard',
  asyncHandler(async (_req: Request, res: Response) => {
    const aiUsageSummary = aiUsageTracker.getSummary();

    const allDemands = await demandRepository.findAll();
    const allEvents = await db.query.documentLifecycleEvents.findMany();
    const comments = await db.query.approvalComments.findMany();

    const demandStats = {
      total: allDemands.length,
      completed: allDemands.filter((d) => d.status === 'completed').length,
      processing: allDemands.filter((d) => d.status === 'processing').length,
      error: allDemands.filter((d) => d.status === 'error').length,
    };

    // Governance Metrics
    const reviewRequestedEvents = allEvents.filter(
      (event: { eventType: string }) => event.eventType === 'DRAFT_TO_APPROVAL_REQUIRED',
    );
    const approvedEvents = allEvents.filter(
      (event: { eventType: string }) => event.eventType === 'APPROVAL_REQUIRED_TO_APPROVED',
    );
    const finalizedEvents = allEvents.filter(
      (event: { eventType: string }) => event.eventType === 'APPROVED_TO_FINAL',
    );

    const governanceStats = {
      reviewAdoptionRate:
        allDemands.length > 0 ? (reviewRequestedEvents.length / allDemands.length) * 100 : 0,
      approvedCount: approvedEvents.length,
      finalizedCount: finalizedEvents.length,
      avgComments:
        reviewRequestedEvents.length > 0 ? comments.length / reviewRequestedEvents.length : 0,
    };

    // Rerank A/B test metrics
    let rerankMetrics = null;
    try {
      rerankMetrics = await rerankTelemetryService.getMetricsSummary();
    } catch (e) {
      logger.warn('Falha ao buscar métricas de rerank', {
        error: e instanceof Error ? e : undefined,
      });
    }

    // Validation metrics from context builder
    const validationMetrics = contextBuilder.getValidationMetrics();

    res.json({
      aiUsage: aiUsageSummary,
      rag: null,
      rerank: rerankMetrics,
      demands: demandStats,
      governance: governanceStats,
      validation: validationMetrics,
      timestamp: new Date().toISOString(),
    });
  }),
);

const getSpansSchema = z.object({
  query: z.object({
    operation: z.string().optional(),
    model: z.string().optional(),
    agentName: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().min(1).max(1000).optional().default(50),
  }),
});

router.get(
  '/tracing/spans',
  validateRequest(getSpansSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { operation, model, agentName, status, limit } = req.query;
    const spans = llmTracingService.querySpans({
      operation: operation as string | undefined,
      model: model as string | undefined,
      agentName: agentName as string | undefined,
      status: status as any, // fallback para SpanStatus ou undefined
      limit: limit ? parseInt(limit as string, 10) : 50,
    });
    res.json({ spans, count: spans.length });
  }),
);

const getTracesSchema = z.object({
  query: z.object({
    limit: z.coerce.number().min(1).max(1000).optional().default(20),
  }),
});

router.get(
  '/tracing/traces',
  validateRequest(getTracesSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const traces = llmTracingService.queryTraces({ limit });
    res.json({ traces, count: traces.length });
  }),
);

const traceIdSchema = z.object({
  params: z.object({
    traceId: z.string().min(1),
  }),
});

router.get(
  '/tracing/traces/:traceId',
  validateRequest(traceIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const trace = llmTracingService.getTrace(req.params.traceId);
    if (!trace) throw new AppError('Trace not found', 404, 'NOT_FOUND');
    res.json(trace);
  }),
);

router.get(
  '/tracing/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      tracing: llmTracingService.getStats(),
      exporter: traceExporterService.getStats(),
      sampling: traceSamplingService.getStats(),
      timestamp: new Date().toISOString(),
    });
  }),
);

const configureSamplingSchema = z.object({
  body: z.object({
    sampleRate: z.number().min(0).max(1).optional(),
    alwaysSampleErrors: z.boolean().optional(),
    priorityOperations: z.array(z.string()).optional(),
    priorityAgents: z.array(z.string()).optional(),
  }),
});

router.post(
  '/tracing/sampling',
  validateRequest(configureSamplingSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { sampleRate, alwaysSampleErrors, priorityOperations, priorityAgents } = req.body;
    const updates: Record<string, unknown> = {};
    if (sampleRate !== undefined) updates.sampleRate = parseFloat(sampleRate);
    if (alwaysSampleErrors !== undefined) updates.alwaysSampleErrors = Boolean(alwaysSampleErrors);
    if (Array.isArray(priorityOperations)) updates.priorityOperations = new Set(priorityOperations);
    if (Array.isArray(priorityAgents)) updates.priorityAgents = new Set(priorityAgents);

    traceSamplingService.updateConfig(updates);
    res.json({
      config: traceSamplingService.getConfig(),
      stats: traceSamplingService.getStats(),
    });
  }),
);

router.post(
  '/tracing/test-export',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await traceExporterService.sendTestSpan();
    res.json({
      ...result,
      stats: traceExporterService.getStats(),
      recommendation: result.dryRun
        ? 'OTLP is in dry-run mode. Set OTEL_EXPORTER_OTLP_ENDPOINT to a real collector URL.'
        : result.success
          ? 'OTLP export is working correctly.'
          : 'OTLP export failed. Check the endpoint URL and collector availability.',
    });
  }),
);

router.post(
  '/tracing/flush',
  asyncHandler(async (_req: Request, res: Response) => {
    const flushed = await traceExporterService.flush();
    res.json({
      flushed,
      stats: traceExporterService.getStats(),
    });
  }),
);

const costsQuerySchema = z.object({
  query: z.object({
    /**
     * Fonte dos dados:
     * - live        → cache quente em RAM (aiUsageTracker). Vista instantânea, perde no restart.
     * - persistent  → agregações SQL da tabela ai_requests. Histórico que sobrevive a restart.
     * - auto        → live se houver registros em RAM, senão persistent (default).
     */
    source: z.enum(['live', 'persistent', 'auto']).optional().default('auto'),
    /** Janela em dias para a fonte persistent (default: 7). Ignorado em live. */
    days: z.coerce.number().min(1).max(365).optional().default(7),
  }),
});

/**
 * GET /api/admin/costs
 *
 * Dashboard de custo. Por padrão (source=auto) usa o cache quente em RAM
 * (aiUsageTracker) quando disponível, e cai para a tabela persistente
 * `ai_requests` quando a RAM está vazia (ex.: logo após um restart) — assim
 * o dashboard nunca fica "morto" mesmo com o tracker sendo in-memory.
 *
 * Forçar uma fonte: ?source=live | ?source=persistent&days=30
 */
router.get(
  '/costs',
  validateRequest(costsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const source = (req.query.source as 'live' | 'persistent' | 'auto') ?? 'auto';
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 7;

    const liveSummary = aiUsageTracker.getSummary();
    const liveHasData = liveSummary.requestCount > 0;

    // Resolve a fonte efetiva
    const effectiveSource: 'live' | 'persistent' =
      source === 'auto' ? (liveHasData ? 'live' : 'persistent') : source;

    if (effectiveSource === 'persistent') {
      const history = await requestTelemetryService.getCostHistory({ limitDays: days });
      // cacheSavings semântico não está em ai_requests; complementa com cache live
      // (stats de cache são independentes do tracker de usage e sobrevivem via aiResponseCache).
      const cacheStats = aiResponseCache.getStats();
      res.json({
        ...history,
        cacheSavings: {
          ...history.cacheSavings,
          // Mantém savings de cache do estado live quando disponível
          costSavedUsd: liveSummary.estimatedCostSavedUsd || 0,
          tokensSaved: liveSummary.estimatedTokensSaved || 0,
        },
        semanticCacheStats: semanticCacheService.getStats(),
        cacheHitRateLive: cacheStats.hitRate,
      });
      return;
    }

    // source === 'live'
    const usage = liveSummary;

    // Build cost breakdown by model
    const costByModel = Object.entries(usage.byModel).map(
      ([model, stats]: [
        string,
        {
          requestCount: number;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          estimatedCostUsd: number;
          unpricedTokens: number;
        },
      ]) => ({
        model,
        requestCount: stats.requestCount,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        totalTokens: stats.totalTokens,
        estimatedCostUsd: stats.estimatedCostUsd,
        avgCostPerRequest: stats.requestCount > 0 ? stats.estimatedCostUsd / stats.requestCount : 0,
      }),
    );

    // Sort by cost descending
    costByModel.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

    // Build cost timeline from recent records (bucketed by 5-min intervals)
    const timeline: { bucket: string; cost: number; requests: number }[] = [];
    const bucketMap = new Map<string, { cost: number; requests: number }>();
    for (const record of usage.recent) {
      const ts = new Date(record.timestamp);
      const bucket = `${ts.getHours().toString().padStart(2, '0')}:${(Math.floor(ts.getMinutes() / 5) * 5).toString().padStart(2, '0')}`;
      const entry = bucketMap.get(bucket) || { cost: 0, requests: 0 };
      entry.cost += record.estimatedCostUsd ?? 0;
      entry.requests++;
      bucketMap.set(bucket, entry);
    }
    for (const [bucket, data] of bucketMap) {
      timeline.push({ bucket, ...data });
    }
    timeline.sort((a, b) => a.bucket.localeCompare(b.bucket));

    // Cache savings
    const cacheSavings = {
      exactHits: usage.cacheHits,
      semanticCacheStats: semanticCacheService.getStats(),
      tokensSaved: usage.estimatedTokensSaved,
      costSavedUsd: usage.estimatedCostSavedUsd,
      cacheHitRate: usage.requestCount > 0 ? usage.cacheHits / usage.requestCount : 0,
    };

    // Routing efficiency
    const routingEfficiency = {
      economicRequests: usage.routing.economicCount,
      safeRequests: usage.routing.safeCount,
      fallbackRate: usage.routing.fallbackRate,
      economicRatio:
        usage.routing.economicCount + usage.routing.safeCount > 0
          ? usage.routing.economicCount / (usage.routing.economicCount + usage.routing.safeCount)
          : 0,
    };

    res.json({
      summary: {
        totalCostUsd: usage.estimatedCostUsd,
        totalRequests: usage.requestCount,
        totalTokens: usage.totalTokens,
        avgCostPerRequest: usage.requestCount > 0 ? usage.estimatedCostUsd / usage.requestCount : 0,
        costSavedUsd: usage.estimatedCostSavedUsd,
      },
      costByModel,
      timeline,
      cacheSavings,
      routingEfficiency,
      timestamp: new Date().toISOString(),
      source: 'live',
    });
  }),
);

router.get(
  '/cache/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = {
      exactCache: aiResponseCache.getStats(),
      semanticCache: semanticCacheService.getStats(),
      timestamp: new Date().toISOString(),
    };

    // M-1: headers de debug em dev/staging
    if (env.isDebugEnv) {
      res.setHeader('X-Cache-Status', 'stats');
      res.setHeader('X-Corpus-Version', String(semanticCacheService.getCurrentCorpusVersion()));
    }

    res.json(stats);
  }),
);

// M-1: endpoint para incrementar a versão do corpus (batch update hook)
router.post(
  '/cache/corpus/increment',
  asyncHandler(async (_req: Request, res: Response) => {
    const next = await semanticCacheService.incrementCorpusVersion();
    if (env.isDebugEnv) {
      res.setHeader('X-Corpus-Version', String(next));
    }
    res.json({ corpusVersion: next });
  }),
);

router.get(
  '/retention-policies',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const policies = await retentionPolicyService.getAllPolicies();
    const dataTypes = retentionPolicyService.getAvailableDataTypes();
    res.json({ policies, availableDataTypes: dataTypes });
  }),
);

const policyIdSchema = z.object({
  params: z.object({
    id: z.coerce.number().positive(),
  }),
});

// NOTA: o GET `/retention-policies/:id` foi movido para o FIM desta seção
// (após as rotas literais como /logs, /db-metrics, /scheduler-status,
// /simulate-all). Em Express a ordem importa: registrado aqui, `:id` capturava
// "logs"/"db-metrics"/... e o `z.coerce.number()` de policyIdSchema devolvia 400.

const createPolicySchema = z.object({
  body: z.object({
    dataType: z.string().min(1),
    ttlDays: z.number().int().positive(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
});

router.post(
  '/retention-policies',
  validateRequest(createPolicySchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    // Validate TTL is a positive number (PRD requirement)
    const { ttlDays } = req.body;
    if (typeof ttlDays === 'string') {
      throw new AppError('TTL must be a number, not a string', 400, 'INVALID_TTL_TYPE');
    }
    if (typeof ttlDays === 'number' && (ttlDays <= 0 || !Number.isInteger(ttlDays))) {
      throw new AppError('TTL must be a positive integer', 400, 'INVALID_TTL_VALUE');
    }

    let policy;
    try {
      policy = await retentionPolicyService.createPolicy(req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create policy';
      if (message.includes('already exists')) {
        throw new AppError(message, 409, 'DUPLICATE_POLICY');
      }
      if (message.includes('Validation error')) {
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }
      throw error;
    }
    res.status(201).json(policy);
  }),
);

const updatePolicySchema = z.object({
  params: z.object({
    id: z.coerce.number().positive(),
  }),
  body: z.object({
    dataType: z.string().optional(),
    ttlDays: z.number().int().positive().optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
});

router.put(
  '/retention-policies/:id',
  validateRequest(updatePolicySchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError('Invalid policy ID', 400, 'VALIDATION_ERROR');
    }

    // Validate TTL if provided
    const { ttlDays } = req.body;
    if (ttlDays !== undefined) {
      if (typeof ttlDays === 'string') {
        throw new AppError('TTL must be a number, not a string', 400, 'INVALID_TTL_TYPE');
      }
      if (typeof ttlDays === 'number' && (ttlDays <= 0 || !Number.isInteger(ttlDays))) {
        throw new AppError('TTL must be a positive integer', 400, 'INVALID_TTL_VALUE');
      }
    }

    let policy;
    try {
      policy = await retentionPolicyService.updatePolicy(id, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update policy';
      if (message.includes('Validation error')) {
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }
      throw error;
    }
    if (!policy) {
      throw new AppError('Policy not found', 404, 'NOT_FOUND');
    }
    res.json(policy);
  }),
);

router.delete(
  '/retention-policies/:id',
  validateRequest(policyIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError('Invalid policy ID', 400, 'VALIDATION_ERROR');
    }

    const deleted = await retentionPolicyService.deletePolicy(id);
    if (!deleted) {
      throw new AppError('Policy not found', 404, 'NOT_FOUND');
    }
    res.json({ success: true, message: 'Policy deleted' });
  }),
);

const simulatePolicySchema = z.object({
  body: z.object({
    dataType: z.string().min(1),
    ttlDays: z.number().int().positive(),
  }),
});

router.post(
  '/retention-policies/simulate',
  validateRequest(simulatePolicySchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const { dataType, ttlDays } = req.body;

    if (!dataType || !ttlDays) {
      throw new AppError('dataType and ttlDays are required', 400, 'VALIDATION_ERROR');
    }

    if (typeof ttlDays !== 'number' || ttlDays <= 0 || !Number.isInteger(ttlDays)) {
      throw new AppError('TTL must be a positive integer', 400, 'INVALID_TTL_VALUE');
    }

    const result = await retentionPolicyService.simulateImpact(dataType, ttlDays);
    res.json(result);
  }),
);

router.get(
  '/retention-policies/simulate-all',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const results = await retentionPolicyService.simulateAllPolicies();
    const dbMetrics = await retentionPolicyService.getDbSizeMetrics();
    res.json({ simulations: results, dbMetrics });
  }),
);

const policyLogsSchema = z.object({
  query: z.object({
    policyId: z.coerce.number().positive().optional(),
    limit: z.coerce.number().min(1).max(1000).optional().default(50),
    offset: z.coerce.number().min(0).optional().default(0),
  }),
});

router.get(
  '/retention-policies/logs',
  validateRequest(policyLogsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const policyId = req.query.policyId ? parseInt(req.query.policyId as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const logs = await retentionPolicyService.getJobLogs({ policyId, limit, offset });
    res.json({ logs });
  }),
);

router.get(
  '/retention-policies/db-metrics',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const metrics = await retentionPolicyService.getDbSizeMetrics();
    res.json(metrics);
  }),
);

router.post(
  '/retention-policies/run-cleanup',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    if (retentionWorker.isJobRunning()) {
      throw new AppError('Cleanup job is already running', 409, 'JOB_ALREADY_RUNNING');
    }

    const result = await retentionWorker.runCleanup();
    res.json({
      success: true,
      result: {
        startedAt: result.startedAt.toISOString(),
        completedAt: result.completedAt.toISOString(),
        durationMs: result.completedAt.getTime() - result.startedAt.getTime(),
        dbSizeBeforeMb: result.dbSizeBeforeMb,
        dbSizeAfterMb: result.dbSizeAfterMb,
        sizeReductionMb: Math.round((result.dbSizeBeforeMb - result.dbSizeAfterMb) * 100) / 100,
        policiesProcessed: result.policiesProcessed,
        totalRowsDeleted: result.totalRowsDeleted,
        results: result.results,
        errors: result.errors,
      },
    });
  }),
);

router.get(
  '/retention-policies/scheduler-status',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    res.json({
      schedulerRunning: retentionWorker.isSchedulerRunning(),
      jobRunning: retentionWorker.isJobRunning(),
      enabled: process.env.RETENTION_WORKER_ENABLED === 'true',
      intervalHours: parseInt(process.env.RETENTION_WORKER_INTERVAL_HOURS || '24', 10),
    });
  }),
);

const startSchedulerSchema = z.object({
  body: z.object({
    intervalHours: z.number().int().positive().optional().default(24),
  }),
});

router.post(
  '/retention-policies/scheduler/start',
  validateRequest(startSchedulerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    if (retentionWorker.isSchedulerRunning()) {
      throw new AppError('Scheduler is already running', 409, 'SCHEDULER_ALREADY_RUNNING');
    }

    const intervalHours = req.body.intervalHours || 24;
    retentionWorker.startScheduler(intervalHours);

    res.json({
      success: true,
      message: `Scheduler started with ${intervalHours} hour interval`,
    });
  }),
);

router.post(
  '/retention-policies/scheduler/stop',
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    if (!retentionWorker.isSchedulerRunning()) {
      throw new AppError('Scheduler is not running', 409, 'SCHEDULER_NOT_RUNNING');
    }

    retentionWorker.stopScheduler();

    res.json({
      success: true,
      message: 'Scheduler stopped',
    });
  }),
);

// GET `/retention-policies/:id` — registrado por ÚLTIMO na seção para não
// capturar as rotas literais acima (/logs, /db-metrics, /scheduler-status,
// /simulate-all). Ver nota na definição de `policyIdSchema`.
router.get(
  '/retention-policies/:id',
  validateRequest(policyIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateAdminKey(req)) {
      throw new UnauthorizedError('Unauthorized. Provide valid X-Admin-Key header.');
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError('Invalid policy ID', 400, 'VALIDATION_ERROR');
    }

    const policy = await retentionPolicyService.getPolicyById(id);
    if (!policy) {
      throw new AppError('Policy not found', 404, 'NOT_FOUND');
    }
    res.json(policy);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// [MA-1] Cost Logs & Monitoring — /api/admin/cost-logs
// ─────────────────────────────────────────────────────────────────────────────

const costLogsQuerySchema = z.object({
  query: z.object({
    /** Janela de análise em milissegundos (default: 15 min) */
    windowMs: z.coerce.number().min(60_000).max(86_400_000).optional().default(900_000),
  }),
});

/**
 * GET /api/admin/cost-logs
 *
 * Retorna métricas de custo detalhadas:
 * - Custo médio por requisição vs baseline
 * - Breakdown por modelo
 * - Taxa de fallback e custo incremental
 * - Hit rate do cache semântico
 * - Status do kill-switch
 * - Routing econômico vs seguro
 */
router.get(
  '/cost-logs',
  validateRequest(costLogsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const windowMs = req.query.windowMs ? parseInt(req.query.windowMs as string, 10) : 900_000; // 15 min default

    const metrics = getCostMetrics(windowMs);
    const usage = aiUsageTracker.getSummary();

    // Breakdown de fallbacks dos últimos registros
    const fallbackRecords = usage.recent.filter((r) => r.fallbackUsed);
    const fallbackCostTotal = fallbackRecords.reduce(
      (sum, r) => sum + (r.estimatedCostUsd ?? 0),
      0,
    );

    res.json({
      ...metrics,
      fallback: {
        count: usage.routing.fallbackCount,
        rate: usage.routing.fallbackRate,
        estimatedExtraCostUsd: Number(fallbackCostTotal.toFixed(6)),
        recentFallbacks: fallbackRecords.slice(-10).map((r) => ({
          timestamp: r.timestamp,
          model: r.model,
          operation: r.operation,
          estimatedCostUsd: r.estimatedCostUsd,
          routingReason: r.routingReason,
        })),
      },
      semanticCache: semanticCacheService.getStats(),
      window: {
        requestedMs: windowMs,
        start: new Date(Date.now() - windowMs).toISOString(),
        end: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

const killSwitchSchema = z.object({
  body: z.object({
    active: z.boolean(),
    component: z.enum(['routing', 'cache']).optional().default('routing'),
    reason: z.string().optional(),
  }),
});

/**
 * POST /api/admin/cost-logs/kill-switch
 *
 * Controle manual do kill-switch de custos.
 * Permite ativar ou desativar o kill-switch via API sem aguardar detecção automática.
 */
router.post(
  '/cost-logs/kill-switch',
  validateRequest(killSwitchSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { active, component, reason } = req.body;
    const safeReason = reason ?? (active ? 'manual_admin_activation' : 'manual_admin_deactivation');

    setKillSwitchState(active, active ? (component ?? 'routing') : null, safeReason);

    logger.warn('[Admin] Kill-switch alterado manualmente', {
      context: { active, component, reason: safeReason },
    });

    res.json({
      success: true,
      killSwitch: getKillSwitchState(),
      message: active
        ? `Kill-switch ativado para componente: ${component}`
        : 'Kill-switch desativado',
    });
  }),
);

const agentMemoryCleanupSchema = z.object({
  body: z.object({
    ttlDays: z.coerce.number().int().min(0).optional(),
  }),
});

/**
 * POST /api/admin/agent-memory/cleanup
 *
 * Spec 10126 T4: executa limpeza de agent_memory com TTL configurável.
 * TTL 0 desabilita a limpeza. Sem body, usa o valor da feature flag
 * `agentMemoryTtlDays` (default 90 dias).
 */
router.post(
  '/agent-memory/cleanup',
  validateRequest(agentMemoryCleanupSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const ttlDays = req.body.ttlDays as number | undefined;
    const result = await agentMemoryService.cleanup(ttlDays);
    res.json({
      success: true,
      ...result,
      policy: 'hard-delete after TTL',
    });
  }),
);

// M-3: recarga atômica de domínios RAG via domains.json
const RELOAD_TOKEN = process.env.ADMIN_RELOAD_TOKEN;

router.post(
  '/domains/reload',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (!RELOAD_TOKEN || token !== RELOAD_TOKEN) {
      throw new UnauthorizedError('Token inválido ou não configurado');
    }

    try {
      const next = reloadDomains();
      res.json({
        reloadedAt: new Date(next.loadedAt).toISOString(),
        domains: next.domains.map((d) => d.name),
      });
    } catch (error) {
      logger.error('M-3: falha ao recarregar domains.json', {
        error: error instanceof Error ? error : undefined,
      });
      throw new AppError(
        error instanceof Error ? error.message : 'Falha ao recarregar domains.json',
        500,
        'DOMAIN_RELOAD_FAILED',
      );
    }
  }),
);

// M-2: endpoint GET /dead-letters para inspeção manual da DLQ do event bus.
const deadLettersSchema = z.object({
  query: z.object({
    since: z.string().datetime().optional(),
    limit: z.coerce.number().min(1).max(100).optional().default(50),
  }),
});

router.get(
  '/dead-letters',
  validateRequest(deadLettersSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 50;
    const rows = await deadLetterService.list(since, limit);
    res.json({ data: rows });
  }),
);

// M-2: métricas agregadas de dead letters (GROUP BY eventType, DATE(createdAt)).
router.get(
  '/dead-letters/metrics',
  asyncHandler(async (_req: Request, res: Response) => {
    const metrics = await deadLetterService.getMetrics();
    res.json({ data: metrics });
  }),
);

export default router;
