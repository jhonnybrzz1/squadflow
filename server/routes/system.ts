import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError, NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import path from 'path';
import { frameworkManager } from '../frameworks';
import { canOverride, getUserContext, adminAuthMiddleware } from '../middleware/auth-stub';
import { adminAuditMiddleware } from '../middleware/admin-audit';
import { agentInterventionService } from '../services/agent-intervention-service';
import { aiResponseCache } from '../services/ai-cache';
import { aiUsageTracker } from '../services/ai-usage-tracker';
import { getHealthStatus, getReadyStatus, logHealthStatus } from '../services/health-check';
import { circuitBreaker } from '../services/circuit-breaker';
import { contextBuilder } from '../services/context-builder';
import { domainTelemetryService } from '../services/domain-telemetry';
import { classifyDemandVagueness } from '../services/hybrid-classifier';
import { logger } from '../utils/logger';
import { probeDocuMente } from '../services/documente-health';
// (Add other necessary imports here)
import { demandDomainSchema } from '@shared/schema';
import type { DemandDomain } from '@shared/schema';
import { evaluateDomainRolloutGate } from '../services/domain-rollout-gate';

const router = Router();

router.get('/api/health', async (_req: Request, res: Response) => {
  try {
    const result = await getHealthStatus();
    logHealthStatus(result);
    const statusCode = result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(result);
  } catch (error) {
    logger.error('Health check failed', { error: error instanceof Error ? error : undefined });
    res.status(503).json({ status: 'unhealthy', error: 'Failed to run health check' });
  }
});

router.get('/api/ready', async (_req: Request, res: Response) => {
  try {
    const result = await getReadyStatus();
    logHealthStatus(result);
    const statusCode = result.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(result);
  } catch (error) {
    logger.error('Readiness check failed', { error: error instanceof Error ? error : undefined });
    res.status(503).json({ status: 'unhealthy', error: 'Failed to run readiness check' });
  }
});

router.get('/api/integrations/documente/status', async (_req: Request, res: Response) => {
  const status = await probeDocuMente();
  res.json(status);
});

router.get('/api/ai/usage', (_req: Request, res: Response) => {
  res.json({
    usage: aiUsageTracker.getSummary(),
    cache: aiResponseCache.getStats(),
    context: contextBuilder.getContextStats(),
  });
});

const domainParamSchema = z.object({
  params: z.object({
    domain: demandDomainSchema,
  }),
});

router.get(
  '/api/domains/:domain/report',
  validateRequest(domainParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const domain = req.params.domain as DemandDomain;
    const report = await domainTelemetryService.generateDomainReport(domain);

    if (!report) {
      throw new AppError('No execution data found for this domain', 404, 'NOT_FOUND');
    }

    res.json(report);
  }),
);

router.get(
  '/api/domains/:domain/rollout-gate',
  validateRequest(domainParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const domain = req.params.domain as DemandDomain;
    if (domain === 'padrao') {
      throw new AppError(
        'Rollout gate is only defined for specialized domains',
        400,
        'BAD_REQUEST',
      );
    }
    const observedRealDemands = await domainTelemetryService.countDistinctDemands(domain);
    res.json(
      evaluateDomainRolloutGate({
        domain,
        observedRealDemands,
        // Confirmação humana deliberadamente não é inferida de métricas técnicas.
        humanValueConfirmed: false,
      }),
    );
  }),
);

router.post(
  '/api/ai/usage/reset',
  adminAuditMiddleware('resetAI'),
  adminAuthMiddleware,
  (_req: Request, res: Response) => {
    aiUsageTracker.reset();
    res.json({ success: true });
  },
);

router.post(
  '/api/ai/cache/clear',
  adminAuditMiddleware('clearCache'),
  adminAuthMiddleware,
  (_req: Request, res: Response) => {
    aiResponseCache.clear();
    res.json({ success: true, cache: aiResponseCache.getStats() });
  },
);

router.get('/api/ai/circuit-breaker', (_req: Request, res: Response) => {
  res.json({
    circuits: circuitBreaker.getAllStats(),
  });
});

const serviceParamSchema = z.object({
  params: z.object({ service: z.string().min(1) }),
});

router.post(
  '/api/ai/circuit-breaker/:service/reset',
  adminAuditMiddleware('resetCircuitBreaker'),
  adminAuthMiddleware,
  validateRequest(serviceParamSchema),
  (req: Request, res: Response) => {
    const { service } = req.params;
    circuitBreaker.reset(service);
    res.json({ success: true, service });
  },
);

router.get(
  '/api/frameworks',
  asyncHandler(async (_req: Request, res: Response) => {
    const frameworks = frameworkManager.getAllFrameworks();
    res.json({
      success: true,
      count: frameworks.length,
      frameworks: frameworks,
    });
  }),
);

// Spec 013 (H-01/FR-007): rota estática ANTES da paramétrica /:id.
router.get(
  '/api/frameworks/metrics',
  asyncHandler(async (_req: Request, res: Response) => {
    const metrics = frameworkManager.getFrameworkMetricsSummary();

    res.json({
      success: true,
      metrics: metrics,
    });
  }),
);

const idStringParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

router.get(
  '/api/frameworks/:id',
  validateRequest(idStringParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const framework = frameworkManager.getFrameworkById(id);
    if (!framework) {
      throw new NotFoundError('Framework', id);
    }
    res.json(framework);
  }),
);

const filenameParamSchema = z.object({
  params: z.object({
    filename: z
      .string()
      .min(1)
      .refine((value) => !/[\\/]/.test(value), 'filename must not include path separators')
      .refine((value) => !value.includes('..'), 'filename must not include parent traversal')
      .refine((value) => !/[\x00-\x1F\x7F]/.test(value), 'filename contains invalid characters'),
  }),
});

router.get(
  '/api/documents/:filename',
  validateRequest(filenameParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const filename = req.params.filename;
    const documentsDir = resolvePath('documents');
    const filepath = path.resolve(documentsDir, filename);

    // SECURITY: Verificar que o path resolvido está contido dentro de documents/
    // Usa startsWith com sep para prevenir edge cases tipo /documents-extra/ ou similares
    if (!filepath.startsWith(documentsDir + path.sep) && filepath !== documentsDir) {
      logger.warn('path_traversal:blocked', {
        context: {
          filename,
          resolvedPath: filepath,
          documentsDir,
          ip: (req as any).ip,
          event: 'path_traversal:blocked',
        },
      });
      throw new ForbiddenError('Forbidden. Access to this path is not allowed.');
    }

    if (!fs.existsSync(filepath)) {
      throw new NotFoundError('Document', filename);
    }

    const isWordDoc = filename.endsWith('.docx');
    const isPdf = filename.endsWith('.pdf');

    // Spec 019: o download entrega o nome real do arquivo (legível, com o nome
    // da solução) em vez de reescrever para PRD_{timestamp} — mesma regra de
    // nomeação do salvamento em disco, para todos os formatos.
    const downloadName = path.basename(filepath);

    if (isWordDoc) {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      const buffer = fs.readFileSync(filepath);
      res.send(buffer);
    } else if (isPdf) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      const buffer = fs.readFileSync(filepath);
      res.send(buffer);
    } else {
      const content = fs.readFileSync(filepath, 'utf8');
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.send(content);
    }
  }),
);

const listDocumentsQuerySchema = z.object({
  query: z.object({
    demandId: z.coerce.number().int().positive().optional(),
    prefix: z.enum(['PRD', 'Tasks']).optional(),
  }),
});

/**
 * Demanda 10197 — listagem de artefatos em documents/ com filtro por demandId e prefixo.
 * Retorna metadados (filename, createdAt) ordenados do mais recente para o mais antigo.
 */
router.get(
  '/api/documents',
  validateRequest(listDocumentsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const documentsDir = resolvePath('documents');
    if (!fs.existsSync(documentsDir)) {
      res.json({ documents: [] });
      return;
    }

    const { demandId, prefix } = req.query as { demandId?: string; prefix?: 'PRD' | 'Tasks' };
    const demandIdNum = demandId ? Number(demandId) : undefined;

    const files = fs
      .readdirSync(documentsDir)
      .filter((name) => {
        if (prefix && !name.startsWith(`${prefix}_`)) return false;
        if (demandIdNum != null) {
          const parts = name.split('_');
          const fileDemandId = Number(parts[1]);
          if (Number.isNaN(fileDemandId) || fileDemandId !== demandIdNum) return false;
        }
        return true;
      })
      .map((name) => {
        const stat = fs.statSync(path.resolve(documentsDir, name));
        return {
          filename: name,
          createdAt: stat.mtime.toISOString(),
          size: stat.size,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ documents: files });
  }),
);

router.get(
  '/api/optimization/metrics',
  asyncHandler(async (_req: Request, res: Response) => {
    const { optimizationTracker } = await import('../services/ai-usage-tracker');
    const report = optimizationTracker.getOptimizationReport();
    const usageSummary = aiUsageTracker.getSummary();
    const savings = optimizationTracker.getTotalSavings();

    res.json({
      optimization: {
        report,
        savings,
        bySource: savings.bySource,
        byStage: savings.byStage,
      },
      usage: usageSummary,
    });
  }),
);

const vaguenessSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'title is required'),
    description: z.string().min(1, 'description is required'),
  }),
});

router.post(
  '/api/classify/vagueness',
  validateRequest(vaguenessSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const result = await classifyDemandVagueness(payload.title, payload.description);
    res.json(result);
  }),
);

const demandIdParamSchema = z.object({
  params: z.object({ demandId: z.coerce.number().positive() }),
});

router.get(
  '/api/anti-overengineering/interventions/:demandId',
  validateRequest(demandIdParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.demandId, 10);
    const entries = await agentInterventionService.getByDemandId(demandId);
    res.json(entries);
  }),
);

const overrideMetricsSchema = z.object({
  query: z.object({ months: z.coerce.number().positive().optional().default(3) }),
});

router.get(
  '/api/anti-overengineering/metrics',
  validateRequest(overrideMetricsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const lastMonths = req.query.months as unknown as number;
    const summary = await agentInterventionService.getMonthlyMetrics(
      isNaN(lastMonths) ? 3 : lastMonths,
    );
    res.json(summary);
  }),
);

const overrideInterventionSchema = z.object({
  params: z.object({ interventionId: z.coerce.number().positive() }),
  body: z.object({
    justification: z
      .string()
      .min(10, 'justification é obrigatória e deve ter pelo menos 10 caracteres.'),
  }),
});

router.post(
  '/api/anti-overengineering/override/:interventionId',
  validateRequest(overrideInterventionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const interventionId = parseInt(req.params.interventionId, 10);

    if (!canOverride(req)) {
      throw new ForbiddenError(
        'Apenas product_manager, tech_lead ou admin podem registrar overrides.',
      );
    }

    const { justification } = req.body;
    const ctx = getUserContext(req);

    await agentInterventionService.applyOverride(interventionId, ctx.id, justification.trim());
    logger.info('Override anti-overengineering registrado', {
      context: { interventionId, overrideBy: ctx.id, role: ctx.role },
    });
    res.json({ success: true, interventionId, overrideBy: ctx.id });
  }),
);

export default router;
