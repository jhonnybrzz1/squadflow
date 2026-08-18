/**
 * Prompt Versioning & A/B Testing Service
 *
 * Manages prompt versions, activation/rollback, A/B test configuration,
 * and per-interaction success metrics.
 *
 * Design:
 * - All DB operations are async and non-blocking
 * - Fallback to previous version if active version is corrupted
 * - Deterministic A/B assignment by hash(session_id)
 * - Version resolution < 5ms (in-memory cache with DB sync)
 */

import { sql, type SQL } from 'drizzle-orm';
import { createHash } from 'crypto';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

interface PromptVersionRow {
  id: number;
  prompt_name: string;
  version: string;
  content: string;
  is_active: number;
  created_at: number;
  activated_at: number | null;
  author: string | null;
  description: string | null;
}

interface ABTestRow {
  id: number;
  prompt_name: string;
  version_a: string;
  version_b: string;
  traffic_percent_b: number;
  is_active: number;
  created_at: number;
  ended_at: number | null;
}

export interface PromptVersion {
  id: number;
  promptName: string;
  version: string;
  content: string;
  isActive: boolean;
  createdAt: number;
  activatedAt: number | null;
  author: string | null;
  description: string | null;
}

export interface ABTestConfig {
  id: number;
  promptName: string;
  versionA: string;
  versionB: string;
  trafficPercentB: number;
  isActive: boolean;
  createdAt: number;
  endedAt: number | null;
}

export interface PromptMetric {
  id: number;
  promptName: string;
  version: string;
  sessionId: string | null;
  demandId: number | null;
  model: string | null;
  successFlag: boolean;
  latencyMs: number | null;
  abTestId: number | null;
  createdAt: number;
}

export interface VersionResolutionResult {
  version: string;
  content: string;
  source: 'active' | 'ab_test' | 'fallback' | 'filesystem';
  abTestId?: number;
}

export interface MetricsAggregation {
  promptName: string;
  version: string;
  model: string | null;
  totalInteractions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number | null;
}

/**
 * Auditoria 2026-08-01 (A08): `is_active`/`success_flag` são INTEGER 0/1 no
 * SQLite e BOOLEAN nativo no PostgreSQL, então comparar com 1 nem tipa no PG
 * ("operator does not exist: boolean = integer"). Bindar um boolean JS também
 * não serve: o better-sqlite3 recusa ("can only bind numbers, strings, bigints,
 * buffers, and null"). Literal por dialeto resolve os dois lados.
 */
const BOOL_TRUE = isPostgres ? sql.raw('TRUE') : sql.raw('1');
const BOOL_FALSE = isPostgres ? sql.raw('FALSE') : sql.raw('0');

// ============================================
// Service
// ============================================

class PromptVersionService {
  private tableReady = false;
  // In-memory cache for fast version resolution
  private activeVersionCache: Map<string, { version: string; content: string; cachedAt: number }> =
    new Map();
  private abTestCache: Map<string, ABTestConfig> = new Map();
  private readonly CACHE_TTL_MS = 300_000; // 5 minutes

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;

    // Auditoria 2026-08-01 (A08): este DDL é SQLite puro — `AUTOINCREMENT` e
    // `unixepoch()` são erro de sintaxe no PostgreSQL. Sem guarda de dialeto,
    // as três criações falhavam, o `catch` abaixo engolia com um warn e
    // `tableReady` nunca virava true: cada chamada tentava de novo, as tabelas
    // nunca existiam e o versionamento de prompt caía para filesystem em
    // silêncio. No PG as tabelas agora vêm da migration
    // `0055_backlog_and_prompt_versioning.sql`.
    if (isPostgres) {
      this.tableReady = true;
      return;
    }

    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_name TEXT NOT NULL,
          version TEXT NOT NULL,
          content TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          activated_at INTEGER,
          author TEXT,
          description TEXT,
          UNIQUE(prompt_name, version)
        )
      `);
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS prompt_ab_tests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_name TEXT NOT NULL,
          version_a TEXT NOT NULL,
          version_b TEXT NOT NULL,
          traffic_percent_b INTEGER NOT NULL DEFAULT 50,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          ended_at INTEGER
        )
      `);
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS prompt_version_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_name TEXT NOT NULL,
          version TEXT NOT NULL,
          session_id TEXT,
          demand_id INTEGER,
          model TEXT,
          success_flag INTEGER NOT NULL,
          latency_ms INTEGER,
          ab_test_id INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      try {
        await dbHelper.run(sql.raw('ALTER TABLE prompt_version_metrics ADD COLUMN model TEXT'));
      } catch (_) {
        // Existing/new schemas may already contain the additive column.
      }
      await dbHelper.run(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS idx_prompt_versions_name ON prompt_versions(prompt_name)',
        ),
      );
      await dbHelper.run(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS idx_prompt_metrics_name_version ON prompt_version_metrics(prompt_name, version)',
        ),
      );
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create prompt_versions tables', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  // ============================================
  // Version CRUD
  // ============================================

  /**
   * Create a new prompt version.
   */
  async createVersion(params: {
    promptName: string;
    version: string;
    content: string;
    author?: string;
    description?: string;
  }): Promise<PromptVersion | null> {
    await this.ensureTable();
    try {
      await dbHelper.run(sql`
        INSERT INTO prompt_versions (prompt_name, version, content, author, description)
        VALUES (${params.promptName}, ${params.version}, ${params.content}, ${params.author ?? null}, ${params.description ?? null})
      `);

      return this.getVersion(params.promptName, params.version);
    } catch (error) {
      logger.error('Failed to create prompt version', {
        error: error instanceof Error ? error : undefined,
        context: { promptName: params.promptName, version: params.version },
      });
      return null;
    }
  }

  /**
   * Get a specific version.
   */
  async getVersion(promptName: string, version: string): Promise<PromptVersion | null> {
    await this.ensureTable();
    const row = await dbHelper.get<PromptVersionRow>(sql`
      SELECT * FROM prompt_versions WHERE prompt_name = ${promptName} AND version = ${version}
    `);
    return row ? this.mapRow(row) : null;
  }

  /**
   * List all versions for a prompt.
   */
  async listVersions(promptName: string): Promise<PromptVersion[]> {
    await this.ensureTable();
    const rows = await dbHelper.all<PromptVersionRow>(sql`
      SELECT * FROM prompt_versions WHERE prompt_name = ${promptName} ORDER BY created_at DESC
    `);
    return (rows || []).map(this.mapRow);
  }

  /**
   * Activate a specific version. Deactivates all others for the same prompt.
   * Also cancels any active A/B test for this prompt.
   */
  async activateVersion(promptName: string, version: string): Promise<boolean> {
    await this.ensureTable();
    try {
      // Deactivate all versions for this prompt
      await dbHelper.run(sql`
        UPDATE prompt_versions SET is_active = ${BOOL_FALSE} WHERE prompt_name = ${promptName}
      `);

      // Activate the requested version
      const now = Math.floor(Date.now() / 1000);
      await dbHelper.run(sql`
        UPDATE prompt_versions SET is_active = ${BOOL_TRUE}, activated_at = ${now}
        WHERE prompt_name = ${promptName} AND version = ${version}
      `);

      // Cancel any active A/B test
      await dbHelper.run(sql`
        UPDATE prompt_ab_tests SET is_active = ${BOOL_FALSE}, ended_at = ${now}
        WHERE prompt_name = ${promptName} AND is_active = ${BOOL_TRUE}
      `);

      // Invalidate cache
      this.activeVersionCache.delete(promptName);
      this.abTestCache.delete(promptName);

      logger.info('Prompt version activated', { context: { promptName, version } });
      return true;
    } catch (error) {
      logger.error('Failed to activate prompt version', {
        error: error instanceof Error ? error : undefined,
        context: { promptName, version },
      });
      return false;
    }
  }

  /**
   * Get the currently active version for a prompt.
   */
  async getActiveVersion(promptName: string): Promise<PromptVersion | null> {
    await this.ensureTable();
    const row = await dbHelper.get<PromptVersionRow>(sql`
      SELECT * FROM prompt_versions WHERE prompt_name = ${promptName} AND is_active = ${BOOL_TRUE}
    `);
    return row ? this.mapRow(row) : null;
  }

  // ============================================
  // Version Resolution (with A/B + fallback)
  // ============================================

  /**
   * Resolve which prompt version to use for a given agent/session.
   * Priority: A/B test (if active) → active version → fallback to previous → null
   * Uses in-memory cache for <5ms resolution.
   */
  async resolveVersion(
    promptName: string,
    sessionId?: string,
  ): Promise<VersionResolutionResult | null> {
    await this.ensureTable();

    // Check A/B test first
    const abTest = await this.getActiveABTest(promptName);
    if (abTest && sessionId) {
      const assignedVersion = this.assignABVersion(abTest, sessionId);
      const versionData = await this.getVersion(promptName, assignedVersion);
      if (versionData && this.isValidContent(versionData.content)) {
        return {
          version: assignedVersion,
          content: versionData.content,
          source: 'ab_test',
          abTestId: abTest.id,
        };
      }
    }

    // Check cache
    const cached = this.activeVersionCache.get(promptName);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return { version: cached.version, content: cached.content, source: 'active' };
    }

    // Query active version from DB
    const active = await this.getActiveVersion(promptName);
    if (active && this.isValidContent(active.content)) {
      this.activeVersionCache.set(promptName, {
        version: active.version,
        content: active.content,
        cachedAt: Date.now(),
      });
      return { version: active.version, content: active.content, source: 'active' };
    }

    // Fallback: get the most recent non-active version
    if (active && !this.isValidContent(active.content)) {
      logger.warn('Active prompt version has invalid content, falling back', {
        context: { promptName, version: active.version },
      });
      const fallback = await this.getFallbackVersion(promptName, active.version);
      if (fallback) {
        return { version: fallback.version, content: fallback.content, source: 'fallback' };
      }
    }

    return null; // No versioned prompt available, caller should use filesystem
  }

  /**
   * Get fallback version (most recent version that is NOT the current one).
   */
  private async getFallbackVersion(
    promptName: string,
    excludeVersion: string,
  ): Promise<PromptVersion | null> {
    const row = await dbHelper.get<PromptVersionRow>(sql`
      SELECT * FROM prompt_versions
      WHERE prompt_name = ${promptName} AND version != ${excludeVersion}
      ORDER BY created_at DESC LIMIT 1
    `);
    return row ? this.mapRow(row) : null;
  }

  // ============================================
  // A/B Testing
  // ============================================

  /**
   * Create an A/B test for a prompt.
   */
  async createABTest(params: {
    promptName: string;
    versionA: string;
    versionB: string;
    trafficPercentB: number;
  }): Promise<ABTestConfig | null> {
    await this.ensureTable();

    // Validate percent
    if (params.trafficPercentB < 0 || params.trafficPercentB > 100) {
      return null;
    }

    // Validate both versions exist
    const vA = await this.getVersion(params.promptName, params.versionA);
    const vB = await this.getVersion(params.promptName, params.versionB);
    if (!vA || !vB) {
      logger.warn('Cannot create A/B test: one or both versions do not exist', {
        context: params,
      });
      return null;
    }

    try {
      // Deactivate any existing A/B test for this prompt
      const now = Math.floor(Date.now() / 1000);
      await dbHelper.run(sql`
        UPDATE prompt_ab_tests SET is_active = ${BOOL_FALSE}, ended_at = ${now}
        WHERE prompt_name = ${params.promptName} AND is_active = ${BOOL_TRUE}
      `);

      await dbHelper.run(sql`
        INSERT INTO prompt_ab_tests (prompt_name, version_a, version_b, traffic_percent_b)
        VALUES (${params.promptName}, ${params.versionA}, ${params.versionB}, ${params.trafficPercentB})
      `);

      // Invalidate cache
      this.abTestCache.delete(params.promptName);

      const row = await dbHelper.get<ABTestRow>(sql`
        SELECT * FROM prompt_ab_tests WHERE prompt_name = ${params.promptName} AND is_active = ${BOOL_TRUE}
      `);
      return row ? this.mapABTestRow(row) : null;
    } catch (error) {
      logger.error('Failed to create A/B test', {
        error: error instanceof Error ? error : undefined,
        context: params,
      });
      return null;
    }
  }

  /**
   * Get active A/B test for a prompt (cached).
   */
  async getActiveABTest(promptName: string): Promise<ABTestConfig | null> {
    const cached = this.abTestCache.get(promptName);
    if (cached && cached.isActive) return cached;

    await this.ensureTable();
    const row = await dbHelper.get<ABTestRow>(sql`
      SELECT * FROM prompt_ab_tests WHERE prompt_name = ${promptName} AND is_active = ${BOOL_TRUE}
    `);

    if (row) {
      const config = this.mapABTestRow(row);
      this.abTestCache.set(promptName, config);
      return config;
    }

    this.abTestCache.set(promptName, {
      id: 0,
      promptName,
      versionA: '',
      versionB: '',
      trafficPercentB: 0,
      isActive: false,
      createdAt: 0,
      endedAt: null,
    });
    return null;
  }

  /**
   * End an A/B test.
   */
  async endABTest(promptName: string): Promise<boolean> {
    await this.ensureTable();
    const now = Math.floor(Date.now() / 1000);
    try {
      await dbHelper.run(sql`
        UPDATE prompt_ab_tests SET is_active = ${BOOL_FALSE}, ended_at = ${now}
        WHERE prompt_name = ${promptName} AND is_active = ${BOOL_TRUE}
      `);
      this.abTestCache.delete(promptName);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Deterministic version assignment by session_id hash.
   */
  assignABVersion(abTest: ABTestConfig, sessionId: string): string {
    const hash = createHash('md5').update(`${abTest.id}:${sessionId}`).digest();
    const bucket = hash.readUInt16BE(0) % 100; // 0-99
    return bucket < abTest.trafficPercentB ? abTest.versionB : abTest.versionA;
  }

  // ============================================
  // Metrics
  // ============================================

  /**
   * Record a metric for a prompt interaction (async, non-blocking).
   */
  recordMetric(params: {
    promptName: string;
    version: string;
    sessionId?: string;
    demandId?: number;
    model?: string;
    successFlag: boolean;
    latencyMs?: number;
    abTestId?: number;
  }): void {
    // Fire-and-forget — CRIT-18: log em vez de engolir silenciosamente.
    this.recordMetricAsync(params).catch((err) => {
      logger.warn('Failed to record prompt metric (fire-and-forget)', {
        error: err instanceof Error ? err : undefined,
        context: { promptName: params.promptName, version: params.version },
      });
    });
  }

  private async recordMetricAsync(params: {
    promptName: string;
    version: string;
    sessionId?: string;
    demandId?: number;
    model?: string;
    successFlag: boolean;
    latencyMs?: number;
    abTestId?: number;
  }): Promise<void> {
    await this.ensureTable();
    await dbHelper.run(sql`
      INSERT INTO prompt_version_metrics (prompt_name, version, session_id, demand_id, model, success_flag, latency_ms, ab_test_id)
      VALUES (
        ${params.promptName},
        ${params.version},
        ${params.sessionId ?? null},
        ${params.demandId ?? null},
        ${params.model ?? null},
        ${params.successFlag ? 1 : 0},
        ${params.latencyMs ?? null},
        ${params.abTestId ?? null}
      )
    `);
  }

  /**
   * Get aggregated metrics for all versions of a prompt.
   */
  async getMetrics(
    promptName: string,
    options?: { sinceHours?: number; abTestId?: number },
  ): Promise<MetricsAggregation[]> {
    await this.ensureTable();

    const sinceEpoch = options?.sinceHours
      ? Math.floor(Date.now() / 1000) - options.sinceHours * 3600
      : 0;

    // Parametrizado via sql`` — promptName vem de req.params (rota pública,
    // sem auth real hoje) e era interpolado sem escape nenhum antes deste fix.
    const conditions: SQL[] = [sql`prompt_name = ${promptName}`, sql`created_at >= ${sinceEpoch}`];
    if (options?.abTestId) {
      conditions.push(sql`ab_test_id = ${options.abTestId}`);
    }

    const query = sql`
      SELECT
        prompt_name, version, model,
        COUNT(*) as total,
        SUM(CASE WHEN success_flag = ${BOOL_TRUE} THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN success_flag = ${BOOL_FALSE} THEN 1 ELSE 0 END) as failures,
        AVG(latency_ms) as avg_latency
      FROM prompt_version_metrics
      WHERE ${sql.join(conditions, sql` AND `)}
      GROUP BY prompt_name, version, model ORDER BY version, model
    `;

    const rows = await dbHelper.all<Record<string, unknown>>(query);
    return (rows || []).map((row) => ({
      promptName: row.prompt_name as string,
      version: row.version as string,
      model: (row.model as string | null) ?? null,
      totalInteractions: row.total as number,
      successCount: row.successes as number,
      failureCount: row.failures as number,
      successRate:
        (row.total as number) > 0 ? (row.successes as number) / (row.total as number) : 0,
      avgLatencyMs: row.avg_latency as number | null,
    }));
  }

  // ============================================
  // Validation
  // ============================================

  /**
   * Check if content is valid (non-empty, parseable).
   */
  private isValidContent(content: string): boolean {
    if (!content || content.trim().length === 0) return false;
    // Basic check: content should have at least some meaningful text
    return content.trim().length > 10;
  }

  // ============================================
  // Row Mappers
  // ============================================

  private mapRow(row: PromptVersionRow): PromptVersion {
    return {
      id: row.id,
      promptName: row.prompt_name,
      version: row.version,
      content: row.content,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      author: row.author,
      description: row.description,
    };
  }

  private mapABTestRow(row: ABTestRow): ABTestConfig {
    return {
      id: row.id,
      promptName: row.prompt_name,
      versionA: row.version_a,
      versionB: row.version_b,
      trafficPercentB: row.traffic_percent_b,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    };
  }
}

export const promptVersionService = new PromptVersionService();
