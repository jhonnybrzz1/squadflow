import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================
// Mocks
// ============================================

const mockRun = vi.fn().mockResolvedValue(undefined);
const mockAll = vi.fn().mockResolvedValue([]);
const mockGet = vi.fn().mockResolvedValue(undefined);

vi.mock('../server/services/audit-loss-tracker', () => ({
  recordAuditLoss: vi.fn(),
  getAuditLossState: vi.fn(() => ({ degraded: false, totalLosses: 0, lastSink: null })),
  resetAuditLossState: vi.fn(),
}));

vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: (...args: any[]) => mockRun(...args),
    all: (...args: any[]) => mockAll(...args),
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================
// Test setup
// ============================================

let llmAuditLogService: typeof import('../server/services/llm-audit-log').llmAuditLogService;

async function reimportService() {
  vi.resetModules();
  const mod = await import('../server/services/llm-audit-log');
  llmAuditLogService = mod.llmAuditLogService;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockRun.mockResolvedValue(undefined);
  mockAll.mockResolvedValue([]);
  mockGet.mockResolvedValue(undefined);
  delete process.env.LLM_LOGS_ENABLED;
  await reimportService();
});

afterEach(() => {
  if (llmAuditLogService) {
    llmAuditLogService.destroy();
  }
});

// ============================================
// Helper
// ============================================

/** Deeply serialize a drizzle SQL object to a string for assertion purposes */
function sqlToString(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  try {
    return JSON.stringify(obj);
  } catch (_) {
    return String(obj);
  }
}

function findCallContaining(mockFn: ReturnType<typeof vi.fn>, text: string): boolean {
  return mockFn.mock.calls.some((c: any[]) => {
    return c.some((arg: unknown) => sqlToString(arg).includes(text));
  });
}

function makeEntry(
  overrides: Partial<import('../server/services/llm-audit-log').LlmAuditLogEntry> = {},
): import('../server/services/llm-audit-log').LlmAuditLogEntry {
  return {
    requestId: 'req-001',
    prompt: 'How do I refactor this module?',
    response: 'Extract the shared logic into a helper.',
    model: 'openrouter:deepseek-v3',
    provider: 'openrouter',
    operation: 'agent_execution:tech_lead',
    agentName: 'tech_lead',
    latencyMs: 1234,
    statusCode: 200,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.001,
    domain: 'padrao',
    demandId: 42,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('LlmAuditLogService', () => {
  // ----------------------------------------
  // Recording
  // ----------------------------------------
  describe('record()', () => {
    it('persists an entry to SQLite via dbHelper.run', async () => {
      const entry = makeEntry();
      llmAuditLogService.record(entry);

      // Wait for async persist
      await new Promise((r) => setTimeout(r, 100));

      // ensureTable (CREATE TABLE) + indexes + INSERT
      expect(mockRun).toHaveBeenCalled();

      // Verify INSERT was called — drizzle sql objects serialize with values in them
      expect(findCallContaining(mockRun, 'req-001')).toBe(true);
    });

    it('does not write when LLM_LOGS_ENABLED=false', async () => {
      process.env.LLM_LOGS_ENABLED = 'false';
      await reimportService();

      llmAuditLogService.record(makeEntry());
      await new Promise((r) => setTimeout(r, 100));

      // Only ensureTable calls (or none) — no INSERT
      const insertCalls = mockRun.mock.calls.filter((c: any) => {
        const sqlStr = String(c[0]?.queryChunks?.[0] ?? c[0]?.sql ?? c[0] ?? '');
        return sqlStr.includes('INSERT INTO');
      });
      expect(insertCalls.length).toBe(0);
    });

    it('records entries with optional fields omitted without breaking', async () => {
      const entry = makeEntry({
        domain: null,
        demandId: null,
      });

      llmAuditLogService.record(entry);
      await new Promise((r) => setTimeout(r, 100));

      // Should not throw
      expect(mockRun).toHaveBeenCalled();
    });
  });

  // ----------------------------------------
  // Buffer
  // ----------------------------------------
  describe('buffer resilience', () => {
    it('buffers entries when DB write fails', async () => {
      mockRun
        .mockResolvedValueOnce(undefined) // ensureTable CREATE
        .mockRejectedValue(new Error('DB unavailable'));

      // Force table ready by calling ensureTable first
      await llmAuditLogService['ensureTable']();
      mockRun.mockRejectedValue(new Error('DB unavailable'));

      llmAuditLogService.record(makeEntry());
      await new Promise((r) => setTimeout(r, 200));

      expect(llmAuditLogService.getBufferSize()).toBeGreaterThanOrEqual(1);
    });

    it('respects buffer max size of 100', async () => {
      // Directly test buffer logic
      for (let i = 0; i < 120; i++) {
        llmAuditLogService['addToBuffer'](makeEntry({ requestId: `req-${i}` }));
      }
      expect(llmAuditLogService.getBufferSize()).toBe(100);
    });

    it('flushBuffer() persists buffered entries', async () => {
      // Add items to buffer directly
      llmAuditLogService['addToBuffer'](makeEntry({ requestId: 'buffered-1' }));
      llmAuditLogService['addToBuffer'](makeEntry({ requestId: 'buffered-2' }));
      llmAuditLogService['tableReady'] = true;

      expect(llmAuditLogService.getBufferSize()).toBe(2);

      mockRun.mockResolvedValue(undefined);
      const flushed = await llmAuditLogService.flushBuffer();

      expect(flushed).toBe(2);
      expect(llmAuditLogService.getBufferSize()).toBe(0);
    });
  });

  // ----------------------------------------
  // Query
  // ----------------------------------------
  describe('queryLogs()', () => {
    it('returns logs with pagination', async () => {
      mockGet.mockResolvedValue({ cnt: 2 });
      mockAll.mockResolvedValue([
        {
          id: 1,
          request_id: 'req-001',
          user_id: null,
          user_name: null,
          prompt: 'test prompt',
          response: 'test response',
          model: 'gpt-4',
          provider: 'openai',
          operation: 'chat',
          agent_name: null,
          latency_ms: 500,
          status_code: 200,
          error_message: null,
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          estimated_cost_usd: 0.01,
          domain: 'padrao',
          demand_id: 1,
          feedback: null,
          feedback_comment: null,
          feedback_at: null,
          created_at: 1700000000,
        },
      ]);

      const result = await llmAuditLogService.queryLogs({ limit: 10, offset: 0 });

      expect(result.total).toBe(2);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0].requestId).toBe('req-001');
      expect(result.logs[0].domain).toBe('padrao');
    });

    it('applies date range filter', async () => {
      mockGet.mockResolvedValue({ cnt: 0 });
      mockAll.mockResolvedValue([]);

      await llmAuditLogService.queryLogs({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      });

      // Verify both get (COUNT) and all (SELECT) were called with filter
      expect(findCallContaining(mockGet, 'created_at')).toBe(true);
    });
  });

  // ----------------------------------------
  // Feedback
  // ----------------------------------------
  describe('recordFeedback()', () => {
    it('updates feedback for a given requestId', async () => {
      const success = await llmAuditLogService.recordFeedback('req-001', 'negative', 'Wrong NCM');

      expect(success).toBe(true);
      // Verify the UPDATE was called with requestId and feedback values
      expect(findCallContaining(mockRun, 'req-001')).toBe(true);
      expect(findCallContaining(mockRun, 'negative')).toBe(true);
    });

    it('records positive feedback', async () => {
      const success = await llmAuditLogService.recordFeedback('req-002', 'positive');
      expect(success).toBe(true);
    });
  });

  // ----------------------------------------
  // Quality Metrics
  // ----------------------------------------
  describe('getQualityMetrics()', () => {
    it('returns quality metrics with feedback rates', async () => {
      mockGet.mockResolvedValue({
        total: 100,
        with_feedback: 40,
        positive: 30,
        negative: 10,
      });
      mockAll.mockResolvedValue([
        { operation: 'agent_execution:tech_lead', negative_count: 5, total_count: 20 },
        { operation: 'chat_completion', negative_count: 3, total_count: 50 },
      ]);

      const metrics = await llmAuditLogService.getQualityMetrics();

      expect(metrics.totalInteractions).toBe(100);
      expect(metrics.totalWithFeedback).toBe(40);
      expect(metrics.positiveFeedbackCount).toBe(30);
      expect(metrics.negativeFeedbackCount).toBe(10);
      expect(metrics.negativeFeedbackRate).toBe(0.25);
      expect(metrics.feedbackAdoptionRate).toBe(0.4);
      expect(metrics.topProblematicPrompts).toHaveLength(2);
      expect(metrics.topProblematicPrompts[0].operation).toBe('agent_execution:tech_lead');
      expect(metrics.topProblematicPrompts[0].negativeRate).toBe(0.25);
    });

    it('handles zero interactions gracefully', async () => {
      mockGet.mockResolvedValue({
        total: 0,
        with_feedback: 0,
        positive: 0,
        negative: 0,
      });
      mockAll.mockResolvedValue([]);

      const metrics = await llmAuditLogService.getQualityMetrics();

      expect(metrics.totalInteractions).toBe(0);
      expect(metrics.negativeFeedbackRate).toBe(0);
      expect(metrics.feedbackAdoptionRate).toBe(0);
      expect(metrics.topProblematicPrompts).toHaveLength(0);
    });
  });

  // ----------------------------------------
  // CSV Export
  // ----------------------------------------
  describe('exportCsv()', () => {
    it('generates valid CSV with headers', async () => {
      mockGet.mockResolvedValue({ cnt: 1 });
      mockAll.mockResolvedValue([
        {
          id: 1,
          request_id: 'req-001',
          created_at: 1700000000,
          user_id: 'user-1',
          user_name: 'Alice',
          model: 'gpt-4',
          provider: 'openai',
          operation: 'chat',
          agent_name: 'tech_lead',
          latency_ms: 500,
          status_code: 200,
          error_message: null,
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          estimated_cost_usd: 0.01,
          domain: 'padrao',
          demand_id: 42,
          feedback: 'positive',
          feedback_comment: 'Good answer',
          prompt: 'What is a helper?',
          response: 'A reusable function...',
        },
      ]);

      const csv = await llmAuditLogService.exportCsv();

      expect(csv).toContain('id,request_id,created_at');
      expect(csv).toContain('domain,demand_id');
      expect(csv).toContain('tech_lead');
      expect(csv).toContain('padrao');
      // Contains at least 2 lines (header + 1 row)
      expect(csv.split('\n').length).toBeGreaterThanOrEqual(2);
    });

    it('escapes CSV values with commas and quotes', async () => {
      mockGet.mockResolvedValue({ cnt: 1 });
      mockAll.mockResolvedValue([
        {
          id: 1,
          request_id: 'req-001',
          created_at: 1700000000,
          user_id: null,
          user_name: null,
          model: 'gpt-4',
          provider: 'openai',
          operation: 'chat',
          agent_name: null,
          latency_ms: 500,
          status_code: 200,
          error_message: null,
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          estimated_cost_usd: 0.01,
          domain: 'geral',
          demand_id: null,
          feedback: null,
          feedback_comment: null,
          prompt: 'A prompt with "quotes" and, commas',
          response: 'A response',
        },
      ]);

      const csv = await llmAuditLogService.exportCsv();
      // Should contain escaped quotes
      expect(csv).toContain('""quotes""');
    });
  });

  // ----------------------------------------
  // Async / non-blocking behavior
  // ----------------------------------------
  describe('async non-blocking behavior', () => {
    it('record() returns immediately (does not block)', () => {
      const start = Date.now();
      llmAuditLogService.record(makeEntry());
      const elapsed = Date.now() - start;

      // Should return in < 10ms (fire-and-forget)
      expect(elapsed).toBeLessThan(50);
    });

    it('record() does not throw on DB error', () => {
      mockRun.mockRejectedValue(new Error('DB crash'));

      expect(() => {
        llmAuditLogService.record(makeEntry());
      }).not.toThrow();
    });
  });

  // ----------------------------------------
  // getDemandUsage — fonte durável de custo (spec 10056)
  // ----------------------------------------
  describe('getDemandUsage()', () => {
    it('agrega custo/tokens durável de llm_audit_logs por demanda', async () => {
      mockAll.mockResolvedValue([
        {
          model: 'openrouter:deepseek-v4-flash',
          operation: 'roundtable:product_owner:turn1',
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
          estimated_cost_usd: 0.012,
        },
        {
          model: 'xiaomi:mimo-v2.5-pro',
          operation: 'roundtable:tech_lead:turn2',
          prompt_tokens: 800,
          completion_tokens: 200,
          total_tokens: 1000,
          estimated_cost_usd: 0.01,
        },
      ]);

      const usage = await llmAuditLogService.getDemandUsage(10062);

      expect(usage.totalCost).toBeCloseTo(0.022, 6);
      expect(usage.tokensIn).toBe(1800);
      expect(usage.tokensOut).toBe(700);
      expect(usage.records).toHaveLength(2);
      expect(usage.records[0]).toMatchObject({
        model: 'openrouter:deepseek-v4-flash',
        operation: 'roundtable:product_owner:turn1',
        estimatedCostUsd: 0.012,
        totalTokens: 1500,
      });
      expect(usage.unpricedCount).toBe(0);
      // Filtra pela demanda solicitada.
      expect(findCallContaining(mockAll, '10062')).toBe(true);
    });

    it('faz flush do buffer antes de ler (não perde chamadas recém-gravadas)', async () => {
      const flushSpy = vi.spyOn(llmAuditLogService, 'flushBuffer');
      mockAll.mockResolvedValue([]);
      await llmAuditLogService.getDemandUsage(1);
      expect(flushSpy).toHaveBeenCalled();
      flushSpy.mockRestore();
    });

    it('reporta chamadas sem preço (unpriced) e não as soma ao custo', async () => {
      mockAll.mockResolvedValue([
        {
          model: 'openrouter:deepseek-v4-flash',
          operation: 'roundtable:qa:turn1',
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          estimated_cost_usd: 0.005,
        },
        {
          model: 'bedrock:kimi-k2.5',
          operation: 'roundtable:moderator',
          prompt_tokens: 400,
          completion_tokens: 100,
          total_tokens: 500,
          estimated_cost_usd: null,
        },
      ]);

      const usage = await llmAuditLogService.getDemandUsage(7);

      expect(usage.totalCost).toBeCloseTo(0.005, 6);
      expect(usage.unpricedCount).toBe(1);
      expect(usage.unpricedTokens).toBe(500);
    });
  });

  // ----------------------------------------
  // Audit trail
  // ----------------------------------------
  describe('audit trail', () => {
    it('stores full prompt and response for audit trail', async () => {
      const longPrompt = 'A'.repeat(5000);
      const longResponse = 'B'.repeat(5000);
      const entry = makeEntry({ prompt: longPrompt, response: longResponse });

      llmAuditLogService.record(entry);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('detectSensitiveDataLeaks', () => {
    it('detecta vazamentos em error_message, prompt, response e metadata', async () => {
      const now = Math.floor(Date.now() / 1000);
      mockGet.mockResolvedValue({ cnt: 2 });
      mockAll.mockResolvedValue([
        {
          id: 1,
          request_id: 'req-001',
          user_id: null,
          user_name: null,
          prompt: 'prompt clean',
          response: 'response clean',
          model: 'test',
          provider: 'openai',
          operation: 'test',
          agent_name: null,
          latency_ms: 100,
          status_code: 500,
          error_message: 'Auth failed: Bearer sk-leaked1234567890abcdefghij',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: null,
          domain: 'geral',
          demand_id: null,
          metadata: JSON.stringify({ path: '/Users/dev/secret' }),
          feedback: null,
          feedback_comment: null,
          feedback_at: null,
          created_at: now,
        },
        {
          id: 2,
          request_id: 'req-002',
          user_id: null,
          user_name: null,
          prompt: 'ok',
          response: 'ok',
          model: 'test',
          provider: 'openai',
          operation: 'test',
          agent_name: null,
          latency_ms: 100,
          status_code: 200,
          error_message: null,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: null,
          domain: 'geral',
          demand_id: null,
          metadata: null,
          feedback: null,
          feedback_comment: null,
          feedback_at: null,
          created_at: now,
        },
      ]);

      const result = await llmAuditLogService.detectSensitiveDataLeaks();

      expect(result.total).toBe(1);
      expect(result.matches[0].requestId).toBe('req-001');
      expect(result.matches[0].patterns).toContain('bearer_token');
      expect(result.matches[0].patterns).toContain('macos_path');
    });

    it('retorna total 0 quando não há logs', async () => {
      mockGet.mockResolvedValue({ cnt: 0 });
      mockAll.mockResolvedValue([]);

      const result = await llmAuditLogService.detectSensitiveDataLeaks();

      expect(result.total).toBe(0);
      expect(result.matches).toHaveLength(0);
    });
  });
});
