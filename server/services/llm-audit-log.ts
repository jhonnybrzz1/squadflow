/**
 * LLM Audit Log Service
 *
 * Structured logging of all LLM interactions for observability and quality auditing.
 *
 * Design rules:
 * - Log is ASYNC — never blocks the main request
 * - In-memory buffer (100 items) for SQLite failure resilience
 * - LLM_LOGS_ENABLED env var controls on/off (default: true)
 * - Fields: prompt, response, latency, model, tokens, cost, feedback
 */

import { sql, type SQL } from 'drizzle-orm';
import { dbHelper } from '../db';
import { logger } from '../utils/logger';
import { recordAuditLoss } from './audit-loss-tracker';

// ============================================
// Types
// ============================================

export interface LlmAuditLogEntry {
  requestId: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  userId?: string | null;
  userName?: string | null;
  prompt: string;
  response: string;
  model: string;
  provider: string;
  operation?: string | null;
  agentName?: string | null;
  latencyMs: number;
  statusCode: number;
  errorMessage?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
  // Domain
  domain?: string | null;
  demandId?: number | null;
  /**
   * Spec 10140: metadados estruturados em JSON para padrões de
   * self-improvement extraídos da mesa redonda.
   */
  metadata?: Record<string, unknown> | null;
}

export interface LlmAuditLogRecord extends LlmAuditLogEntry {
  id: number;
  feedback: 'positive' | 'negative' | null;
  feedbackComment: string | null;
  feedbackAt: number | null;
  createdAt: number;
}

interface DatabaseRow {
  id: number;
  request_id: string;
  user_id: string | null;
  user_name: string | null;
  prompt: string;
  response: string;
  model: string;
  provider: string;
  operation: string | null;
  agent_name: string | null;
  latency_ms: number;
  status_code: number;
  error_message: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  domain: string | null;
  demand_id: number | null;
  metadata: string | null;
  created_at: number;
  feedback: 'positive' | 'negative' | null;
  feedback_comment: string | null;
  feedback_at: number | null;
}

export interface LogQueryFilters {
  startDate?: string; // ISO date
  endDate?: string; // ISO date
  demandId?: number;
  userId?: string;
  model?: string;
  operation?: string;
  feedbackOnly?: boolean;
  negativeFeedbackOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  logs: LlmAuditLogRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface QualityMetrics {
  totalInteractions: number;
  totalWithFeedback: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
  negativeFeedbackRate: number;
  feedbackAdoptionRate: number;
  topProblematicPrompts: Array<{
    operation: string;
    negativeCount: number;
    totalCount: number;
    negativeRate: number;
  }>;
  periodStart: string;
  periodEnd: string;
}

// ============================================
// Configuration
// ============================================

const BUFFER_MAX_SIZE = 100;
const FLUSH_INTERVAL_MS = 5_000; // 5 seconds
const DB_WRITE_TIMEOUT_MS = 5_000; // 5 seconds

function isLoggingEnabled(): boolean {
  const envVal = process.env.LLM_LOGS_ENABLED;
  // Default to true if not set
  if (envVal === undefined || envVal === '') return true;
  return envVal !== 'false' && envVal !== '0';
}

// ============================================
// Service
// ============================================

class LlmAuditLogService {
  private tableReady = false;
  private buffer: LlmAuditLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor() {
    this.startFlushTimer();
  }

  // ----------------------------------------
  // Schema initialization
  // ----------------------------------------

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS llm_audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          user_id TEXT,
          user_name TEXT,
          prompt TEXT NOT NULL,
          response TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          operation TEXT,
          agent_name TEXT,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          status_code INTEGER NOT NULL DEFAULT 200,
          error_message TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd REAL,
          domain TEXT DEFAULT 'geral',
          demand_id INTEGER,
          metadata TEXT,
          feedback TEXT CHECK (feedback IN ('positive', 'negative', NULL)),
          feedback_comment TEXT,
          feedback_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      // Create indexes
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_created_at ON llm_audit_logs(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_request_id ON llm_audit_logs(request_id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_demand_id ON llm_audit_logs(demand_id)',
        'CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_feedback ON llm_audit_logs(feedback)',
      ];
      for (const idx of indexes) {
        await dbHelper.run(sql.raw(idx));
      }

      // Spec 10140: migração leve para adicionar coluna metadata em tabelas
      // existentes (SQLite não tem IF NOT EXISTS em ADD COLUMN).
      try {
        await dbHelper.run(sql`ALTER TABLE llm_audit_logs ADD COLUMN metadata TEXT`);
      } catch (alterError) {
        const msg = alterError instanceof Error ? alterError.message : String(alterError);
        const alreadyExists = msg.includes('duplicate column') || msg.includes('already exists');
        if (!alreadyExists) {
          logger.warn('Could not add metadata column to llm_audit_logs', {
            error: alterError instanceof Error ? alterError : undefined,
          });
        }
      }

      this.tableReady = true;
      logger.info('LLM audit log table ready');
    } catch (error) {
      logger.warn('Could not create llm_audit_logs table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  // ----------------------------------------
  // Async log recording (fire-and-forget)
  // ----------------------------------------

  /**
   * Spec 10140: loga um padrão extraído pela heurística de self-improvement.
   * Usa a mesma tabela de llm_audit_logs com operation='roundtable:self_improvement'
   * e os campos do padrão no metadata JSON.
   */
  recordSelfImprovementPattern(params: {
    agent_type: string;
    roundtable_id: number;
    extracted_pattern: unknown;
    confidence_hint: 'low' | 'medium' | 'high';
    feedback_status?: 'pending' | 'approved' | 'rejected';
    extraction_error?: string;
  }): void {
    const {
      agent_type,
      roundtable_id,
      extracted_pattern,
      confidence_hint,
      feedback_status,
      extraction_error,
    } = params;
    this.record({
      requestId: `self-improvement-${roundtable_id}-${Date.now()}`,
      prompt: 'self-improvement heuristic extraction',
      response: extraction_error ? '' : JSON.stringify(extracted_pattern),
      model: 'heuristic',
      provider: 'internal',
      operation: 'roundtable:self_improvement',
      agentName: agent_type,
      latencyMs: 0,
      statusCode: extraction_error ? 500 : 200,
      errorMessage: extraction_error ?? null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      domain: 'self_improvement',
      demandId: roundtable_id,
      metadata: {
        agent_type,
        roundtable_id,
        extracted_pattern,
        confidence_hint,
        feedback_status: feedback_status ?? 'pending',
        extraction_error,
      },
    });
  }

  /**
   * Record an LLM interaction log entry.
   * Non-blocking: buffers if DB is unavailable.
   */
  record(entry: LlmAuditLogEntry): void {
    if (!isLoggingEnabled()) return;

    // Fire-and-forget persist
    this.persistEntry(entry).catch(() => {
      // Buffer on failure
      this.addToBuffer(entry);
    });
  }

  private async persistEntry(entry: LlmAuditLogEntry): Promise<void> {
    await this.ensureTable();
    if (!this.tableReady) {
      this.addToBuffer(entry);
      return;
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DB write timeout')), DB_WRITE_TIMEOUT_MS),
    );

    const writePromise = dbHelper.run(sql`
      INSERT INTO llm_audit_logs (
        request_id, user_id, user_name,
        prompt, response,
        model, provider, operation, agent_name,
        latency_ms, status_code, error_message,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
        domain, demand_id, metadata
      ) VALUES (
        ${entry.requestId},
        ${entry.userId ?? null},
        ${entry.userName ?? null},
        ${entry.prompt},
        ${entry.response},
        ${entry.model},
        ${entry.provider},
        ${entry.operation ?? null},
        ${entry.agentName ?? null},
        ${entry.latencyMs},
        ${entry.statusCode},
        ${entry.errorMessage ?? null},
        ${entry.promptTokens},
        ${entry.completionTokens},
        ${entry.totalTokens},
        ${entry.estimatedCostUsd ?? null},
        ${entry.domain ?? 'geral'},
        ${entry.demandId ?? null},
        ${entry.metadata ? JSON.stringify(entry.metadata) : null}
      )
    `);

    await Promise.race([writePromise, timeoutPromise]);
  }

  // ----------------------------------------
  // In-memory buffer (100 items)
  // ----------------------------------------

  private addToBuffer(entry: LlmAuditLogEntry): void {
    if (this.buffer.length >= BUFFER_MAX_SIZE) {
      // Drop oldest entry — perda observável (spec 015 B3 / M-07).
      this.buffer.shift();
      recordAuditLoss('llm_audit_log', new Error('buffer_full_dropped_oldest'));
    }
    this.buffer.push(entry);
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch((err) => {
        // Spec 015 B3 (M-07): falha de persistência de auditoria não pode
        // ser rebaixada a debug silencioso.
        recordAuditLoss('llm_audit_log', err);
      });
    }, FLUSH_INTERVAL_MS);
    // Don't prevent process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async flushBuffer(): Promise<number> {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;

    let flushed = 0;
    const toFlush = [...this.buffer];
    this.buffer = [];

    for (const entry of toFlush) {
      try {
        await this.persistEntry(entry);
        flushed++;
      } catch (_) {
        // Re-buffer failed entries
        this.addToBuffer(entry);
      }
    }

    this.flushing = false;
    if (flushed > 0) {
      logger.info(`Flushed ${flushed} buffered LLM audit log entries`);
    }
    return flushed;
  }

  /** Get current buffer size (for monitoring) */
  getBufferSize(): number {
    return this.buffer.length;
  }

  // ----------------------------------------
  // Cost aggregation (durável) — spec 10056
  // ----------------------------------------

  /**
   * Fonte DURÁVEL de custo por demanda: agrega diretamente de `llm_audit_logs`,
   * que sobrevive a restart e não tem o cap de 1000 registros do tracker em
   * memória. Substitui `aiUsageTracker.getUsageForDemand()` no caminho de
   * LEITURA de `/api/demands/:id/costs`, onde o tracker efêmero subcontava ~10×.
   *
   * Faz `flushBuffer()` antes de ler para não perder chamadas recém-gravadas
   * (o audit-log bufferiza e faz flush por timer).
   */
  async getDemandUsage(demandId: number): Promise<{
    records: Array<{
      model: string;
      operation: string;
      estimatedCostUsd: number | null;
      totalTokens: number;
    }>;
    totalCost: number;
    tokensIn: number;
    tokensOut: number;
    unpricedCount: number;
    unpricedTokens: number;
  }> {
    await this.ensureTable();
    // Inclui chamadas ainda bufferizadas (ex.: logo após um refinamento).
    await this.flushBuffer();

    const rows = (await dbHelper.all<{
      model: string;
      operation: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number | null;
    }>(
      sql`SELECT model, operation, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
          FROM llm_audit_logs
          WHERE demand_id = ${demandId}`,
    )) as Array<{
      model: string;
      operation: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number | null;
    }>;

    let totalCost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let unpricedCount = 0;
    let unpricedTokens = 0;

    const records = rows.map((row) => {
      const cost = row.estimated_cost_usd;
      totalCost += cost ?? 0;
      tokensIn += row.prompt_tokens ?? 0;
      tokensOut += row.completion_tokens ?? 0;
      if (cost === null || cost === undefined) {
        unpricedCount += 1;
        unpricedTokens += row.total_tokens ?? 0;
      }
      return {
        model: row.model,
        operation: row.operation ?? '',
        estimatedCostUsd: cost ?? null,
        totalTokens: row.total_tokens ?? 0,
      };
    });

    return { records, totalCost, tokensIn, tokensOut, unpricedCount, unpricedTokens };
  }

  // ----------------------------------------
  // Query logs
  // ----------------------------------------

  async queryLogs(filters: LogQueryFilters = {}): Promise<LogQueryResult> {
    await this.ensureTable();

    const limit = Math.min(filters.limit ?? 100, 1000);
    const offset = filters.offset ?? 0;

    // Parametrizado via sql`` (não sql.raw + concatenação) — filtros vêm de
    // query params HTTP (server/routes/llm-audit-routes.ts), então precisam
    // ser bind params reais, não texto interpolado na query.
    const conditions: SQL[] = [];

    if (filters.startDate) {
      const startEpoch = Math.floor(new Date(filters.startDate).getTime() / 1000);
      conditions.push(sql`created_at >= ${startEpoch}`);
    }
    if (filters.endDate) {
      const endEpoch = Math.floor(new Date(filters.endDate).getTime() / 1000);
      conditions.push(sql`created_at <= ${endEpoch}`);
    }
    if (filters.demandId !== undefined) {
      conditions.push(sql`demand_id = ${Number(filters.demandId)}`);
    }
    if (filters.userId) {
      conditions.push(sql`user_id = ${filters.userId}`);
    }
    if (filters.model) {
      conditions.push(sql`model LIKE ${`%${filters.model}%`}`);
    }
    if (filters.operation) {
      conditions.push(sql`operation = ${filters.operation}`);
    }
    if (filters.feedbackOnly) {
      conditions.push(sql`feedback IS NOT NULL`);
    }
    if (filters.negativeFeedbackOnly) {
      conditions.push(sql`feedback = 'negative'`);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    const countResult = await dbHelper.get<{ cnt: number }>(
      sql`SELECT COUNT(*) as cnt FROM llm_audit_logs ${whereClause}`,
    );
    const total = countResult?.cnt ?? 0;

    const rows = await dbHelper.all<LlmAuditLogRecord>(
      sql`SELECT * FROM llm_audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    );

    return {
      logs: this.mapRows(rows as unknown as DatabaseRow[]),
      total,
      limit,
      offset,
    };
  }

  // ----------------------------------------
  // Feedback
  // ----------------------------------------

  async recordFeedback(
    requestId: string,
    feedback: 'positive' | 'negative',
    comment?: string,
  ): Promise<boolean> {
    await this.ensureTable();
    if (!this.tableReady) return false;

    try {
      const now = Math.floor(Date.now() / 1000);
      await dbHelper.run(sql`
        UPDATE llm_audit_logs
        SET feedback = ${feedback},
            feedback_comment = ${comment ?? null},
            feedback_at = ${now}
        WHERE request_id = ${requestId}
      `);
      return true;
    } catch (error) {
      logger.warn('Failed to record LLM audit feedback', {
        error: error instanceof Error ? error : undefined,
      });
      return false;
    }
  }

  // ----------------------------------------
  // Quality metrics (Sprint 2)
  // ----------------------------------------

  async getQualityMetrics(startDate?: string, endDate?: string): Promise<QualityMetrics> {
    await this.ensureTable();

    // CRIT-13: parametrizado via sql`` (não sql.raw + concatenação de string),
    // mesmo padrão já usado em queryLogs. startDate/endDate vêm de query params
    // HTTP — interpolá-los em sql.raw permitia injeção de SQL arbitrário no
    // WHERE (e quebrava com NaN quando o Date era inválido). Agora são bind
    // params reais.
    const conditions: SQL[] = [];

    if (startDate) {
      const startEpoch = Math.floor(new Date(startDate).getTime() / 1000);
      conditions.push(sql`created_at >= ${startEpoch}`);
    }
    if (endDate) {
      const endEpoch = Math.floor(new Date(endDate).getTime() / 1000);
      conditions.push(sql`created_at <= ${endEpoch}`);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    // Totals
    const totals = await dbHelper.get<{
      total: number;
      with_feedback: number;
      positive: number;
      negative: number;
    }>(
      sql`SELECT
          COUNT(*) as total,
          COUNT(feedback) as with_feedback,
          SUM(CASE WHEN feedback = 'positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN feedback = 'negative' THEN 1 ELSE 0 END) as negative
        FROM llm_audit_logs ${whereClause}`,
    );

    const totalInteractions = totals?.total ?? 0;
    const totalWithFeedback = totals?.with_feedback ?? 0;
    const positiveFeedbackCount = totals?.positive ?? 0;
    const negativeFeedbackCount = totals?.negative ?? 0;

    // Top problematic prompts by operation
    const topProblematic = await dbHelper.all<{
      operation: string;
      negative_count: number;
      total_count: number;
    }>(
      sql`SELECT
          COALESCE(operation, 'unknown') as operation,
          SUM(CASE WHEN feedback = 'negative' THEN 1 ELSE 0 END) as negative_count,
          COUNT(*) as total_count
        FROM llm_audit_logs ${whereClause}
        GROUP BY operation
        HAVING negative_count > 0
        ORDER BY negative_count DESC
        LIMIT 10`,
    );

    return {
      totalInteractions,
      totalWithFeedback,
      positiveFeedbackCount,
      negativeFeedbackCount,
      negativeFeedbackRate: totalWithFeedback > 0 ? negativeFeedbackCount / totalWithFeedback : 0,
      feedbackAdoptionRate: totalInteractions > 0 ? totalWithFeedback / totalInteractions : 0,
      topProblematicPrompts: (topProblematic || []).map((row) => ({
        operation: row.operation,
        negativeCount: row.negative_count,
        totalCount: row.total_count,
        negativeRate: row.total_count > 0 ? row.negative_count / row.total_count : 0,
      })),
      periodStart: startDate ?? 'all',
      periodEnd: endDate ?? 'now',
    };
  }

  // ----------------------------------------
  // CSV export
  // ----------------------------------------

  async exportCsv(filters: LogQueryFilters = {}): Promise<string> {
    // Override limit for export
    const result = await this.queryLogs({ ...filters, limit: 10000, offset: 0 });

    // CSV column headers (snake_case) → camelCase property mapping
    const columns: Array<{ header: string; key: keyof LlmAuditLogRecord }> = [
      { header: 'id', key: 'id' },
      { header: 'request_id', key: 'requestId' },
      { header: 'created_at', key: 'createdAt' },
      { header: 'user_id', key: 'userId' },
      { header: 'user_name', key: 'userName' },
      { header: 'model', key: 'model' },
      { header: 'provider', key: 'provider' },
      { header: 'operation', key: 'operation' },
      { header: 'agent_name', key: 'agentName' },
      { header: 'latency_ms', key: 'latencyMs' },
      { header: 'status_code', key: 'statusCode' },
      { header: 'error_message', key: 'errorMessage' },
      { header: 'prompt_tokens', key: 'promptTokens' },
      { header: 'completion_tokens', key: 'completionTokens' },
      { header: 'total_tokens', key: 'totalTokens' },
      { header: 'estimated_cost_usd', key: 'estimatedCostUsd' },
      { header: 'domain', key: 'domain' },
      { header: 'demand_id', key: 'demandId' },
      { header: 'feedback', key: 'feedback' },
      { header: 'feedback_comment', key: 'feedbackComment' },
      { header: 'prompt', key: 'prompt' },
      { header: 'response', key: 'response' },
    ];

    const headers = columns.map((c) => c.header);

    const rows = result.logs.map((log) =>
      columns.map(({ key, header }) => {
        const val = log[key];
        if (val === null || val === undefined) return '';
        if (header === 'created_at' && typeof val === 'number') {
          return new Date(val * 1000).toISOString();
        }
        // Escape CSV values
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }),
    );

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  // ----------------------------------------
  // Helpers
  // ----------------------------------------

  /**
   * Detecta possíveis vazamentos de dados sensíveis nos logs de erro dos
   * últimos `days` dias. Retorna contagem e amostras (request_id) sem expor o
   * conteúdo sensível em si.
   *
   * B-1 (2026-07-28): baseline e pós-fix para sanitização de erros.
   */
  async detectSensitiveDataLeaks(days = 7): Promise<{
    total: number;
    matches: Array<{ requestId: string; createdAt: number; patterns: string[] }>;
    patterns: string[];
  }> {
    const sensitivePatterns = [
      /Bearer\s+[A-Za-z0-9._-]{6,}/i,
      /\bsk-[A-Za-z0-9_-]{16,}\b/,
      /(?:^|[^A-Za-z0-9])(\/Users\/[^\s\n]+)/g,
      /(?:^|[^A-Za-z0-9])(\/home\/[^\s\n]+)/g,
      /(?:^|[^A-Za-z0-9])(C:\\\\[^\s\n]+)/gi,
      /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g,
      /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g,
      /(?:^|[^A-Za-z0-9])(\/[^\s\n]*(?:private|secret|\.env)[^\s\n]*)/gi,
    ];
    const patternNames = [
      'bearer_token',
      'api_key',
      'macos_path',
      'linux_path',
      'windows_path',
      'process_env',
      'env_var_interpolation',
      'sensitive_path',
    ];

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { logs } = await this.queryLogs({
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      limit: 1000,
      offset: 0,
    });

    const matches: Array<{ requestId: string; createdAt: number; patterns: string[] }> = [];
    for (const log of logs) {
      const haystack = `${log.errorMessage ?? ''} ${log.prompt ?? ''} ${log.response ?? ''} ${log.metadata ? JSON.stringify(log.metadata) : ''}`;
      const hitPatterns: string[] = [];
      for (let i = 0; i < sensitivePatterns.length; i++) {
        if (sensitivePatterns[i].test(haystack)) {
          hitPatterns.push(patternNames[i]);
        }
      }
      if (hitPatterns.length > 0) {
        matches.push({ requestId: log.requestId, createdAt: log.createdAt, patterns: hitPatterns });
      }
    }

    return {
      total: matches.length,
      matches,
      patterns: patternNames,
    };
  }

  private mapRows(rows: DatabaseRow[]): LlmAuditLogRecord[] {
    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      userId: row.user_id,
      userName: row.user_name,
      prompt: row.prompt,
      response: row.response,
      model: row.model,
      provider: row.provider,
      operation: row.operation,
      agentName: row.agent_name,
      latencyMs: row.latency_ms,
      statusCode: row.status_code,
      errorMessage: row.error_message,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      domain: row.domain,
      demandId: row.demand_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      feedback: row.feedback,
      feedbackComment: row.feedback_comment,
      feedbackAt: row.feedback_at,
      createdAt: row.created_at,
    }));
  }

  /** Stop flush timer (for tests / shutdown) */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const llmAuditLogService = new LlmAuditLogService();
