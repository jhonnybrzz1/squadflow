/**
 * errors.ts - Endpoint para coleta de erros do cliente
 *
 * POST /api/errors - Recebe erros do ErrorBoundary do cliente
 * GET /api/errors/analysis - Retorna análise agregada para validação de hipóteses
 */

import { logger } from '../utils/logger';
import { Router, type Request, type Response } from 'express';
import { asyncHandler, ValidationError, RateLimitError } from '../middleware/error-handler';
import { db, dbHelper, isPostgres } from '../db';
import { clientErrors } from '../../shared/schema';
import { sql } from 'drizzle-orm';

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClientErrorPayload {
  timestamp: string;
  sessionId: string;
  component: string;
  errorMessage: string;
  stackTrace: string;
  payload: Record<string, unknown>;
  dataSource: 'gov_api' | 'internal' | 'ai_model' | 'unknown';
  userAgent: string;
  url: string;
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minuto
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 erros por minuto por sessão

function isRateLimited(sessionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(sessionId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(sessionId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  entry.count++;
  return false;
}

// Cleanup periódico
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (now > value.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ─── Validation ───────────────────────────────────────────────────────────────

function validatePayload(body: unknown): body is ClientErrorPayload {
  if (!body || typeof body !== 'object') return false;

  const payload = body as Record<string, unknown>;

  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.component === 'string' &&
    typeof payload.errorMessage === 'string' &&
    typeof payload.dataSource === 'string' &&
    ['gov_api', 'internal', 'ai_model', 'unknown'].includes(payload.dataSource as string)
  );
}

// ─── POST /api/errors ─────────────────────────────────────────────────────────

router.post(
  '/api/errors',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body;

    // Validação
    if (!validatePayload(body)) {
      throw new ValidationError('Invalid payload');
    }

    // Rate limiting
    if (isRateLimited(body.sessionId)) {
      throw new RateLimitError('Too many errors reported');
    }

    // Persistir no banco
    await db.insert(clientErrors).values({
      timestamp: new Date(body.timestamp),
      sessionId: body.sessionId,
      component: body.component,
      errorMessage: body.errorMessage,
      stackTrace: body.stackTrace || '',
      payload: body.payload || {},
      dataSource: body.dataSource,
      userAgent: body.userAgent || '',
      url: body.url || '',
    });

    logger.info('[client-errors] Error logged:', {
      context: {
        component: body.component,
        dataSource: body.dataSource,
        error: body.errorMessage.substring(0, 100),
      },
    });

    return res.status(201).json({ success: true });
  }),
);

// ─── GET /api/errors/analysis ─────────────────────────────────────────────────

router.get(
  '/api/errors/analysis',
  asyncHandler(async (_req: Request, res: Response) => {
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000; // 48 horas
    const cutoff = new Date(cutoffMs);

    // Parametrizado via sql`` (bind param real) — mantém a lógica dialeto-
    // específica (timestamptz Postgres vs epoch SQLite) sem concatenar texto.
    const timestampCondition = isPostgres
      ? sql`timestamp >= ${cutoff.toISOString()}::timestamptz`
      : sql`timestamp >= ${Math.floor(cutoffMs / 1000)}`;

    // Query agregada por data_source
    const byDataSourceQuery = sql`
      SELECT data_source as "dataSource", COUNT(*) as count
      FROM client_errors
      WHERE ${timestampCondition}
      GROUP BY data_source
      ORDER BY count DESC
    `;

    // Query agregada por componente
    const byComponentQuery = sql`
      SELECT component, data_source as "dataSource", COUNT(*) as count
      FROM client_errors
      WHERE ${timestampCondition}
      GROUP BY component, data_source
      ORDER BY count DESC
    `;

    // Total de erros
    const totalQuery = sql`
      SELECT COUNT(*) as total
      FROM client_errors
      WHERE ${timestampCondition}
    `;

    const [byDataSource, byComponent, totalResult] = await Promise.all([
      dbHelper.all<{ dataSource: string; count: number }>(byDataSourceQuery),
      dbHelper.all<{ component: string; dataSource: string; count: number }>(byComponentQuery),
      dbHelper.get<{ total: number }>(totalQuery),
    ]);

    const total = Number(totalResult?.total) || 0;

    // Calcular percentuais
    const dataSourceStats = byDataSource.map((row) => ({
      dataSource: row.dataSource,
      count: Number(row.count),
      percentage: total > 0 ? ((Number(row.count) / total) * 100).toFixed(2) : '0.00',
    }));

    // Determinar recomendação com base na hipótese
    const govApiErrors = Number(byDataSource.find((r) => r.dataSource === 'gov_api')?.count) || 0;
    const govApiPercentage = total > 0 ? (govApiErrors / total) * 100 : 0;

    let recommendation: string;
    if (govApiPercentage >= 80) {
      recommendation =
        'ALTA CORRELAÇÃO: gov_api >= 80%. Correção específica recomendada para componentes de integração com APIs externas e transformação de dados.';
    } else if (govApiPercentage >= 50) {
      recommendation =
        'CORRELAÇÃO MODERADA: gov_api 50-80%. Considerar ErrorBoundary específico + sanitização adicional.';
    } else {
      recommendation =
        'BAIXA CORRELAÇÃO: gov_api < 50%. ErrorBoundary global é suficiente. Investigar outras causas.';
    }

    return res.json({
      period: '48h',
      cutoffTime: cutoff.toISOString(),
      totalErrors: total,
      byDataSource: dataSourceStats,
      byComponent: byComponent.map((r) => ({ ...r, count: Number(r.count) })),
      recommendation,
      hypothesis: {
        govApiPercentage: govApiPercentage.toFixed(2),
        threshold: '80%',
        passed: govApiPercentage >= 80,
      },
    });
  }),
);

// ─── GET /api/errors/recent ───────────────────────────────────────────────────

router.get(
  '/api/errors/recent',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const query = sql`
      SELECT * FROM client_errors
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const errors = await dbHelper.all(query);

    return res.json({ errors });
  }),
);

export default router;
