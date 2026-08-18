/**
 * Guardrail Admin Routes
 *
 * Endpoints for monitoring and auditing guardrail events.
 * Protected by simple token (same as LLM audit routes).
 */

import { Router, type Request, type Response } from 'express';
import {
  guardrailLogStore,
  safetyLogStore,
  type GuardrailType,
  type GuardrailAction,
} from '../services/llm-guardrails';
import { logger } from '../utils/logger';
import { isValidToken } from '../utils/timing-safe-compare';
import { getUserContext } from '../middleware/auth-stub';
import { asyncHandler, ForbiddenError, UnauthorizedError } from '../middleware/error-handler';
import { z } from 'zod';

const router = Router();

// ============================================
// Auth middleware — SECURE IMPLEMENTATION
// ============================================

// SECURITY: audit-dev-token is NEVER accepted in any environment.
const AUDIT_TOKEN = process.env.LLM_AUDIT_TOKEN || '';

if (!process.env.LLM_AUDIT_TOKEN) {
  logger.warn('LLM_AUDIT_TOKEN not set - guardrail routes require JWT admin auth or env token');
}

function requireAuditAuth(req: Request, _res: Response, next: (err?: unknown) => void): void {
  const token = req.headers['x-audit-token'] as string | undefined;

  // SECURITY: Reject audit-dev-token in ALL environments
  if (token === 'audit-dev-token') {
    logger.warn('Rejected audit-dev-token', {
      context: { ip: req.ip, path: req.path, env: process.env.NODE_ENV, event: 'auth:failed' },
    });
    next(new ForbiddenError('Forbidden. audit-dev-token is permanently disabled.'));
    return;
  }

  // H-2: timing-safe comparison — `===` on secrets leaks matching prefix
  // length via short-circuit. Use crypto.timingSafeEqual via isValidToken.
  if (isValidToken(token, AUDIT_TOKEN)) {
    return next();
  }

  // Fallback: check for JWT admin role
  const userContext = getUserContext(req);
  if (process.env.NODE_ENV !== 'production' && userContext.role === 'admin') {
    return next();
  }

  next(new UnauthorizedError('Unauthorized. Provide valid token or authenticate as admin.'));
}

router.use(requireAuditAuth);

const validDate = z.string().datetime({ offset: true });
const guardrailQuerySchema = z.object({
  startDate: validDate.optional(),
  endDate: validDate.optional(),
  type: z.enum(['prompt_injection', 'pii_masking', 'content_moderation']).optional(),
  action: z
    .enum(['blocked', 'masked', 'masked_multiple', 'allowed', 'error', 'flagged'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const statsQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});

// ============================================
// GET /admin/guardrails-logs — Query guardrail events
// ============================================

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = guardrailQuerySchema.parse(req.query);
    const filters = {
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      guardrailType: parsed.type as GuardrailType | undefined,
      action: parsed.action as GuardrailAction | undefined,
      limit: parsed.limit,
      offset: parsed.offset,
    };

    const result = await guardrailLogStore.query(filters);
    res.json(result);
  }),
);

// ============================================
// GET /admin/guardrails-logs/stats — Summary stats
// ============================================

router.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const { hours } = statsQuerySchema.parse(req.query);
    const stats = await guardrailLogStore.getStats(hours);
    res.json({
      ...stats,
      periodHours: hours,
      timestamp: new Date().toISOString(),
    });
  }),
);

// ============================================
// GET /admin/guardrails-logs/ui — HTML dashboard
// ============================================

router.get('/ui', async (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guardrails Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
    h1 { margin-bottom: 20px; color: #1a1a1a; }
    .stats { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat-card { background: #fff; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); min-width: 120px; flex: 1; }
    .stat-card .label { font-size: 12px; color: #666; text-transform: uppercase; font-weight: 600; }
    .stat-card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .blocked { color: #dc2626; }
    .masked { color: #d97706; }
    .allowed { color: #059669; }
    .error { color: #7c3aed; }
    .filters { background: #fff; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .filter-group { display: flex; flex-direction: column; gap: 4px; }
    .filter-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
    .filter-group input, .filter-group select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    table { width: 100%; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); border-collapse: collapse; font-size: 13px; }
    th { background: #f9fafb; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e5e7eb; font-weight: 600; }
    td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .tag-blocked { background: #fef2f2; color: #dc2626; }
    .tag-masked { background: #fffbeb; color: #d97706; }
    .tag-allowed { background: #f0fdf4; color: #059669; }
    .tag-error { background: #f5f3ff; color: #7c3aed; }
    .empty { text-align: center; padding: 40px; color: #999; }
  </style>
</head>
<body>
  <h1>Guardrails Dashboard</h1>
  <div class="stats" id="stats"></div>

  <div class="filters">
    <div class="filter-group">
      <label>Tipo</label>
      <select id="filterType">
        <option value="">Todos</option>
        <option value="prompt_injection">Prompt Injection</option>
        <option value="pii_masking">PII Masking</option>
        <option value="content_moderation">Content Moderation</option>
      </select>
    </div>
    <div class="filter-group">
      <label>Ação</label>
      <select id="filterAction">
        <option value="">Todas</option>
        <option value="blocked">Blocked</option>
        <option value="masked">Masked</option>
        <option value="allowed">Allowed</option>
        <option value="error">Error</option>
      </select>
    </div>
    <div class="filter-group">
      <label>Período (h)</label>
      <select id="filterHours">
        <option value="1">1h</option>
        <option value="6">6h</option>
        <option value="24" selected>24h</option>
        <option value="168">7d</option>
      </select>
    </div>
    <div class="filter-group" style="justify-content: flex-end;">
      <button class="btn-primary" onclick="loadData()">Atualizar</button>
    </div>
  </div>

  <div id="table-container"></div>

<script>
// Spec 011 (M-05): token via header x-audit-token (localStorage), nunca em query string.
const TOKEN = localStorage.getItem('audit_token') || '';
const AUTH_HEADERS = TOKEN ? { 'x-audit-token': TOKEN } : {};
const BASE = window.location.pathname.replace('/ui', '');

async function loadData() {
  const hours = document.getElementById('filterHours').value;
  const type = document.getElementById('filterType').value;
  const action = document.getElementById('filterAction').value;

  const [statsRes, logsRes] = await Promise.all([
    fetch(BASE + '/stats?hours=' + hours, { headers: AUTH_HEADERS }),
    fetch(BASE + '?' + (type ? 'type=' + type + '&' : '') + (action ? 'action=' + action + '&' : '') + 'limit=200', { headers: AUTH_HEADERS }),
  ]);

  const stats = await statsRes.json();
  const logs = await logsRes.json();

  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="label">Total (' + hours + 'h)</div><div class="value">' + stats.total + '</div></div>' +
    '<div class="stat-card"><div class="label">Bloqueados</div><div class="value blocked">' + stats.blocked + '</div></div>' +
    '<div class="stat-card"><div class="label">PII Mascarado</div><div class="value masked">' + stats.masked + '</div></div>' +
    '<div class="stat-card"><div class="label">Permitidos</div><div class="value allowed">' + stats.allowed + '</div></div>' +
    '<div class="stat-card"><div class="label">Erros</div><div class="value error">' + stats.errors + '</div></div>';

  if (!logs.logs || logs.logs.length === 0) {
    document.getElementById('table-container').innerHTML = '<div class="empty">Nenhum incidente registrado nas últimas ' + hours + 'h.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Data</th><th>Tipo</th><th>Ação</th><th>Razão</th><th>Detecções</th><th>Latência</th><th>Hash</th></tr></thead><tbody>';
  logs.logs.forEach(function(log) {
    const date = new Date(log.timestamp * 1000).toLocaleString('pt-BR');
    const tagClass = 'tag-' + log.action.replace('masked_multiple', 'masked');
    html += '<tr><td>' + date + '</td><td>' + esc(log.guardrailType) + '</td><td><span class="tag ' + tagClass + '">' + esc(log.action) + '</span></td><td>' + esc(log.reason || '-') + '</td><td>' + esc(log.detections) + '</td><td>' + log.latencyMs + 'ms</td><td>' + esc(log.inputHash) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('table-container').innerHTML = html;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

loadData();
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ============================================
// GET /admin/guardrails-logs/safety — Safety audit logs (PRD: /api/safety/logs)
// ============================================

router.get(
  '/safety',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 100;
    const logs = await safetyLogStore.query(limit);
    res.json({ logs, count: logs.length });
  }),
);

export default router;
