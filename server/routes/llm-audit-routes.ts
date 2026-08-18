/**
 * LLM Audit Log Routes
 *
 * Endpoints for querying, exporting, and providing feedback on LLM audit logs.
 * Protected by a simple token check (LLM_AUDIT_TOKEN env var).
 *
 * Sprint 1: /debug/logs (query + CSV export)
 * Sprint 2: /debug/logs/feedback, /metrics/quality, /debug/logs/ui (HTML)
 */

import { Router, type Request, type Response } from 'express';
import { llmAuditLogService, type LogQueryFilters } from '../services/llm-audit-log';
import { logger } from '../utils/logger';
import { isValidToken } from '../utils/timing-safe-compare';
import { getUserContext } from '../middleware/auth-stub';
import {
  asyncHandler,
  AppError,
  ValidationError,
  ForbiddenError,
  UnauthorizedError,
} from '../middleware/error-handler';

const router = Router();

// ============================================
// Auth middleware — SECURE IMPLEMENTATION
// ============================================

// SECURITY: audit-dev-token is NEVER accepted in any environment.
// Authenticate via LLM_AUDIT_TOKEN env var or JWT admin session.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const AUDIT_TOKEN = process.env.LLM_AUDIT_TOKEN || '';

if (!process.env.LLM_AUDIT_TOKEN) {
  logger.warn('LLM_AUDIT_TOKEN not set - audit routes require JWT admin auth or env token');
}

function requireAuditAuth(req: Request, _res: Response, next: (err?: unknown) => void): void {
  const token = req.headers['x-audit-token'] as string | undefined;

  // SECURITY: Reject audit-dev-token in ALL environments — token removido definitivamente
  if (token === 'audit-dev-token') {
    logger.warn('Rejected audit-dev-token', {
      context: {
        ip: req.ip,
        path: req.path,
        env: process.env.NODE_ENV,
        event: 'auth:failed',
      },
    });
    next(new ForbiddenError('Forbidden. audit-dev-token is permanently disabled.'));
    return;
  }

  // H-2: timing-safe comparison — `===` on secrets leaks matching prefix
  // length via short-circuit. Use crypto.timingSafeEqual via isValidToken.
  if (isValidToken(token, AUDIT_TOKEN)) {
    return next();
  }

  // Fallback: check for JWT admin role (via Passport session)
  const userContext = getUserContext(req);
  if (!IS_PRODUCTION && userContext.isAuthenticated && userContext.role === 'admin') {
    return next();
  }

  // Log failed auth attempt
  logger.warn('Unauthorized audit access attempt', {
    context: {
      ip: req.ip,
      path: req.path,
      hasToken: !!token,
      userRole: userContext.role,
      event: 'auth:failed',
    },
  });

  next(
    new UnauthorizedError(
      'Unauthorized. Provide valid x-audit-token header or authenticate as admin.',
    ),
  );
}

router.use(requireAuditAuth);

// ============================================
// GET /debug/logs — Query logs with filters
// ============================================

router.get(
  '/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const filters: LogQueryFilters = {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      demandId: req.query.demandId ? Number(req.query.demandId) : undefined,
      userId: req.query.userId as string | undefined,
      model: req.query.model as string | undefined,
      operation: req.query.operation as string | undefined,
      feedbackOnly: req.query.feedbackOnly === 'true',
      negativeFeedbackOnly: req.query.negativeFeedbackOnly === 'true',
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    };

    const result = await llmAuditLogService.queryLogs(filters);
    res.json(result);
  }),
);

// ============================================
// GET /debug/logs/export — CSV export
// ============================================

router.get(
  '/logs/export',
  asyncHandler(async (req: Request, res: Response) => {
    const filters: LogQueryFilters = {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      demandId: req.query.demandId ? Number(req.query.demandId) : undefined,
      userId: req.query.userId as string | undefined,
      model: req.query.model as string | undefined,
      operation: req.query.operation as string | undefined,
    };

    const csv = await llmAuditLogService.exportCsv(filters);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="llm-audit-logs-${new Date().toISOString().split('T')[0]}.csv"`,
    );
    res.send(csv);
  }),
);

// ============================================
// POST /debug/logs/feedback — Record feedback
// ============================================

router.post(
  '/logs/feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const { requestId, feedback, comment } = req.body;

    if (!requestId || typeof requestId !== 'string') {
      throw new ValidationError('requestId is required');
    }
    if (!feedback || !['positive', 'negative'].includes(feedback)) {
      throw new ValidationError('feedback must be "positive" or "negative"');
    }

    const sanitizedComment =
      typeof comment === 'string' ? comment.replace(/<[^>]*>/g, '').slice(0, 500) : undefined;

    const success = await llmAuditLogService.recordFeedback(requestId, feedback, sanitizedComment);
    if (!success) {
      throw new AppError('Failed to record feedback', 500, 'INTERNAL_ERROR');
    }
    res.json({ ok: true });
  }),
);

// ============================================
// GET /debug/logs/status — Buffer & health
// ============================================

router.get(
  '/logs/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const bufferSize = llmAuditLogService.getBufferSize();
    const enabled =
      process.env.LLM_LOGS_ENABLED !== 'false' && process.env.LLM_LOGS_ENABLED !== '0';

    res.json({
      enabled,
      bufferSize,
      bufferMax: 100,
      timestamp: new Date().toISOString(),
    });
  }),
);

// ============================================
// GET /metrics/quality — Quality metrics
// ============================================

router.get(
  '/quality',
  asyncHandler(async (req: Request, res: Response) => {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const metrics = await llmAuditLogService.getQualityMetrics(startDate, endDate);
    res.json(metrics);
  }),
);

// ============================================
// GET /debug/logs/ui — Simple HTML interface
// ============================================

router.get('/logs/ui', async (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Audit Logs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
    h1 { margin-bottom: 20px; color: #1a1a1a; }
    .filters { background: #fff; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .filter-group { display: flex; flex-direction: column; gap: 4px; }
    .filter-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
    .filter-group input, .filter-group select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #e5e7eb; color: #374151; }
    .btn-secondary:hover { background: #d1d5db; }
    .btn-export { background: #059669; color: #fff; }
    .btn-export:hover { background: #047857; }
    .stats { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat-card { background: #fff; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); flex: 1; min-width: 140px; }
    .stat-card .label { font-size: 12px; color: #666; text-transform: uppercase; font-weight: 600; }
    .stat-card .value { font-size: 24px; font-weight: 700; color: #1a1a1a; margin-top: 4px; }
    table { width: 100%; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); border-collapse: collapse; font-size: 13px; }
    th { background: #f9fafb; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; position: sticky; top: 0; }
    td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:hover { background: #f9fafb; }
    .status-200 { color: #059669; }
    .status-500 { color: #dc2626; }
    .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
    .empty { text-align: center; padding: 40px; color: #999; }
    .expandable { cursor: pointer; }
    .expandable:hover { background: #f0f4ff; }
    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-row td { white-space: pre-wrap; word-break: break-word; max-width: none; background: #fafbfc; font-family: monospace; font-size: 12px; }
    #loading { text-align: center; padding: 40px; color: #666; }
  </style>
</head>
<body>
  <h1>LLM Audit Logs</h1>

  <div class="filters">
    <div class="filter-group">
      <label>Data Início</label>
      <input type="date" id="startDate">
    </div>
    <div class="filter-group">
      <label>Data Fim</label>
      <input type="date" id="endDate">
    </div>
    <div class="filter-group">
      <label>Demand ID</label>
      <input type="number" id="demandId" placeholder="Ex: 42">
    </div>
    <div class="filter-group">
      <label>Operação</label>
      <input type="text" id="operation" placeholder="Ex: agent_execution">
    </div>
    <div class="filter-group" style="justify-content: flex-end;">
      <button class="btn-primary" onclick="loadLogs()">Buscar</button>
    </div>
    <div class="filter-group" style="justify-content: flex-end;">
      <button class="btn-export" onclick="exportCsv()">Exportar CSV</button>
    </div>
  </div>

  <div class="stats" id="stats" style="display:none;">
    <div class="stat-card"><div class="label">Total</div><div class="value" id="stat-total">0</div></div>
    <div class="stat-card"><div class="label">Página</div><div class="value" id="stat-page">0</div></div>
    <div class="stat-card"><div class="label">Buffer</div><div class="value" id="stat-buffer">0</div></div>
    <div class="stat-card"><div class="label">Status</div><div class="value" id="stat-status">-</div></div>
  </div>

  <div id="loading" style="display:none;">Carregando...</div>
  <div id="table-container"></div>
  <div class="pagination" id="pagination" style="display:none;">
    <button class="btn-secondary" id="btn-prev" onclick="prevPage()">Anterior</button>
    <span id="page-info"></span>
    <button class="btn-secondary" id="btn-next" onclick="nextPage()">Próxima</button>
  </div>

<script>
// Spec 011 (M-05): segredo NUNCA em query string — token via header
// x-audit-token, guardado em localStorage (perfil local: sessão admin
// do stub também autoriza, então o token pode ficar vazio localmente).
const TOKEN = localStorage.getItem('audit_token') || '';
const AUTH_HEADERS = TOKEN ? { 'x-audit-token': TOKEN } : {};
const BASE = window.location.pathname.replace('/logs/ui', '');
let currentOffset = 0;
const PAGE_SIZE = 50;

function getFilters() {
  const f = {};
  ['startDate','endDate','demandId','operation'].forEach(id => {
    const v = document.getElementById(id).value.trim();
    if (v) f[id] = v;
  });
  return f;
}

function buildQS(filters, offset) {
  const p = new URLSearchParams({ limit: PAGE_SIZE, offset: offset, ...filters });
  return p.toString();
}

async function loadLogs() {
  currentOffset = 0;
  await fetchLogs();
}

async function fetchLogs() {
  const loading = document.getElementById('loading');
  loading.style.display = 'block';
  document.getElementById('table-container').innerHTML = '';

  const filters = getFilters();
  try {
    const [logsRes, statusRes] = await Promise.all([
      fetch(BASE + '/logs?' + buildQS(filters, currentOffset), { headers: AUTH_HEADERS }),
      fetch(BASE + '/logs/status', { headers: AUTH_HEADERS }),
    ]);
    const data = await logsRes.json();
    const status = await statusRes.json();

    document.getElementById('stats').style.display = 'flex';
    document.getElementById('stat-total').textContent = data.total;
    document.getElementById('stat-page').textContent = Math.floor(currentOffset / PAGE_SIZE + 1) + '/' + Math.ceil(data.total / PAGE_SIZE);
    document.getElementById('stat-buffer').textContent = status.bufferSize;
    document.getElementById('stat-status').textContent = status.enabled ? 'Ativo' : 'Inativo';

    renderTable(data.logs);

    const pg = document.getElementById('pagination');
    pg.style.display = data.total > PAGE_SIZE ? 'flex' : 'none';
    document.getElementById('btn-prev').disabled = currentOffset === 0;
    document.getElementById('btn-next').disabled = currentOffset + PAGE_SIZE >= data.total;
    document.getElementById('page-info').textContent = (currentOffset + 1) + '-' + Math.min(currentOffset + PAGE_SIZE, data.total) + ' de ' + data.total;
  } catch (e) {
    document.getElementById('table-container').innerHTML = '<div class="empty">Erro ao carregar logs: ' + e.message + '</div>';
  }
  loading.style.display = 'none';
}

function renderTable(logs) {
  if (!logs.length) {
    document.getElementById('table-container').innerHTML = '<div class="empty">Nenhum log encontrado.</div>';
    return;
  }
  let html = '<table><thead><tr><th>ID</th><th>Data</th><th>Modelo</th><th>Operação</th><th>Latência</th><th>Status</th><th>Tokens</th><th>Custo</th><th>Feedback</th></tr></thead><tbody>';
  logs.forEach(log => {
    const date = new Date((log.createdAt || log.created_at) * 1000).toLocaleString('pt-BR');
    const statusClass = (log.statusCode || log.status_code) === 200 ? 'status-200' : 'status-500';
    html += '<tr class="expandable" onclick="toggleDetail(this)"><td>' + log.id + '</td><td>' + date + '</td><td>' + esc(log.model) + '</td><td>' + esc(log.operation || '-') + '</td><td>' + (log.latencyMs || log.latency_ms) + 'ms</td><td class="' + statusClass + '">' + (log.statusCode || log.status_code) + '</td><td>' + (log.totalTokens || log.total_tokens || 0) + '</td><td>$' + ((log.estimatedCostUsd || log.estimated_cost_usd || 0)).toFixed(4) + '</td><td>' + (log.feedback || '-') + '</td></tr>';
    html += '<tr class="detail-row"><td colspan="9"><strong>Prompt:</strong>\\n' + esc(log.prompt).substring(0, 2000) + '\\n\\n<strong>Response:</strong>\\n' + esc(log.response).substring(0, 2000) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('table-container').innerHTML = html;
}

function toggleDetail(row) {
  const detail = row.nextElementSibling;
  if (detail) detail.classList.toggle('open');
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function nextPage() { currentOffset += PAGE_SIZE; fetchLogs(); }
function prevPage() { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); fetchLogs(); }

async function exportCsv() {
  // Spec 011 (M-05): download via fetch com header — sem token em URL.
  const filters = getFilters();
  const qs = new URLSearchParams({ ...filters }).toString();
  const res = await fetch(BASE + '/logs/export?' + qs, { headers: AUTH_HEADERS });
  if (!res.ok) { alert('Falha ao exportar CSV (' + res.status + ')'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'llm-audit-logs.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

export default router;
