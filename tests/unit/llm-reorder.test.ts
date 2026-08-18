/**
 * Dedicated Cohere rerank through OpenRouter.
 *
 * These tests verify:
 * - requests use POST /api/v1/rerank with cohere/rerank-v3.5
 * - Telemetry records `rerankProvider: 'cohere-openrouter'`
 * - Fallbacks record `rerankProvider: 'none'`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/services/rerank-telemetry', () => ({
  rerankTelemetryService: {
    hashQuery: vi.fn().mockReturnValue('hash123'),
    assignABGroup: vi.fn().mockReturnValue('rerank'),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  },
  RerankTelemetryEvent: {},
}));

vi.mock('../../server/metrics', () => ({
  rerankEffectiveTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  rerankFailureTotal: { inc: vi.fn() },
}));

describe('LlmReorderService — EMB-002 honest naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses Cohere through the dedicated OpenRouter rerank endpoint by default', async () => {
    const originalModel = process.env.RERANK_MODEL;
    const originalEnabled = process.env.RERANK_ENABLED;
    const originalKey = process.env.OPENROUTER_API_KEY;
    delete process.env.RERANK_MODEL;
    process.env.RERANK_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.8 },
            { index: 1, relevance_score: 0.7 },
          ],
          usage: { search_units: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    try {
      const mod = await import('../../server/services/llm-reorder');

      await mod.llmReorderService.rerank(
        'consulta sobre circular normativa compliance',
        [
          { content: 'doc 0', source: 's0', artigo_ou_secao: 'a', score: 0.5 },
          { content: 'doc 1', source: 's1', artigo_ou_secao: 'b', score: 0.6 },
          { content: 'doc 2', source: 's2', artigo_ou_secao: 'c', score: 0.7 },
        ],
        { topK: 3 },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/rerank',
        expect.objectContaining({ method: 'POST' }),
      );
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        model: 'cohere/rerank-v3.5',
        query: 'consulta sobre circular normativa compliance',
        documents: ['doc 0', 'doc 1', 'doc 2'],
        top_n: 3,
      });
    } finally {
      if (originalModel !== undefined) process.env.RERANK_MODEL = originalModel;
      else delete process.env.RERANK_MODEL;
      if (originalEnabled !== undefined) process.env.RERANK_ENABLED = originalEnabled;
      else delete process.env.RERANK_ENABLED;
      if (originalKey !== undefined) process.env.OPENROUTER_API_KEY = originalKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('rerank() direto com RERANK_ENABLED off usa fallback e NUNCA chama a rede', async () => {
    // Defesa em profundidade (auditoria 2026-07-17): chamadas diretas (testes,
    // scripts) não podem gastar dinheiro real com o toggle desligado.
    process.env.RERANK_ENABLED = 'false';
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    vi.resetModules();
    const freshMod = await import('../../server/services/llm-reorder');
    const freshTelemetry = await import('../../server/services/rerank-telemetry');
    freshTelemetry.rerankTelemetryService.assignABGroup = vi.fn().mockReturnValue('rerank');
    freshTelemetry.rerankTelemetryService.hashQuery = vi.fn().mockReturnValue('h0');
    freshTelemetry.rerankTelemetryService.recordEvent = vi.fn().mockResolvedValue(undefined);

    const result = await freshMod.llmReorderService.rerank(
      'consulta sobre circular normativa compliance',
      [{ content: 'doc 0', source: 's0', artigo_ou_secao: 'a', score: 0.5 }],
      { topK: 1 },
    );

    expect(result.fallbackUsed).toBe(true);
    expect(result.rerankCostUsd).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.RERANK_ENABLED;
  });

  it('records rerankProvider=cohere-openrouter and preserves relevance scores', async () => {
    const { llmReorderService } = await import('../../server/services/llm-reorder');
    const { rerankTelemetryService } = await import('../../server/services/rerank-telemetry');

    // Force the service to be available
    process.env.RERANK_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { index: 2, relevance_score: 0.97 },
              { index: 0, relevance_score: 0.81 },
              { index: 1, relevance_score: 0.62 },
            ],
            usage: { search_units: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    // Reset to pick up env
    vi.resetModules();
    const freshMod = await import('../../server/services/llm-reorder');
    const freshTelemetry = await import('../../server/services/rerank-telemetry');

    freshTelemetry.rerankTelemetryService.assignABGroup = vi.fn().mockReturnValue('rerank');
    freshTelemetry.rerankTelemetryService.hashQuery = vi.fn().mockReturnValue('h1');
    freshTelemetry.rerankTelemetryService.recordEvent = vi.fn().mockResolvedValue(undefined);

    const result = await freshMod.llmReorderService.rerank(
      'consulta sobre circular normativa compliance',
      [
        { content: 'doc 0', source: 's0', artigo_ou_secao: 'a', score: 0.5 },
        { content: 'doc 1', source: 's1', artigo_ou_secao: 'b', score: 0.6 },
        { content: 'doc 2', source: 's2', artigo_ou_secao: 'c', score: 0.7 },
      ],
      { topK: 3 },
    );

    expect(result.fallbackUsed).toBe(false);
    expect(result.results.map((item) => [item.index, item.rerankScore])).toEqual([
      [2, 0.97],
      [0, 0.81],
      [1, 0.62],
    ]);
    expect(freshTelemetry.rerankTelemetryService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ rerankProvider: 'cohere-openrouter', rerankCostUsd: 0.002 }),
    );

    delete process.env.RERANK_ENABLED;
    delete process.env.OPENROUTER_API_KEY;
    void rerankTelemetryService;
    void llmReorderService;
  });

  it('records rerankProvider=none on bypass (short query, no keywords)', async () => {
    const { llmReorderService } = await import('../../server/services/llm-reorder');
    const { rerankTelemetryService } = await import('../../server/services/rerank-telemetry');

    (rerankTelemetryService.assignABGroup as any).mockReturnValue('rerank');

    const result = await llmReorderService.rerank(
      'olá', // short query, no retrieval keywords
      [{ content: 'doc 0', source: 's0', artigo_ou_secao: 'a', score: 0.5 }],
      { topK: 1 },
    );

    expect(result.fallbackUsed).toBe(false);
    expect(rerankTelemetryService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ rerankProvider: 'none' }),
    );
  });

  it('EMB-002: rerankFailureTotal is incremented once per failure (not double-counted)', async () => {
    process.env.RERANK_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.resetModules();

    // Track inc calls on rerankFailureTotal
    let failureIncCount = 0;
    vi.doMock('../../server/metrics', () => ({
      rerankEffectiveTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
      rerankFailureTotal: {
        inc: vi.fn(() => {
          failureIncCount++;
        }),
      },
    }));

    const mod = await import('../../server/services/llm-reorder');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await mod.llmReorderService.rerank(
      'consulta sobre circular normativa compliance',
      [
        { content: 'doc 0', source: 's0', artigo_ou_secao: 'a', score: 0.5 },
        { content: 'doc 1', source: 's1', artigo_ou_secao: 'b', score: 0.6 },
      ],
      { topK: 2 },
    );

    // EMB-002: The failure should be counted exactly once. Previously the
    // catch block incremented rerankFailureTotal AND fallback() incremented
    // it again, double-counting a single failure.
    expect(failureIncCount).toBe(1);

    delete process.env.RERANK_ENABLED;
    delete process.env.OPENROUTER_API_KEY;
    vi.doUnmock('../../server/metrics');
  });

  describe('cache key (auditoria 2026-07-21: assinatura sem hash de conteúdo)', () => {
    it('conteúdo diferente sob o MESMO source id não reaproveita o cache (chama a rede de novo)', async () => {
      process.env.RERANK_ENABLED = 'true';
      process.env.OPENROUTER_API_KEY = 'test-key';
      vi.resetModules();
      // Re-mocka explicitamente (não depende do vi.mock estático do topo do
      // arquivo, que um teste anterior pode ter removido via vi.doUnmock).
      vi.doMock('../../server/metrics', () => ({
        rerankEffectiveTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
        rerankFailureTotal: { inc: vi.fn() },
      }));

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ index: 0, relevance_score: 0.9 }],
            usage: { search_units: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import('../../server/services/llm-reorder');
      const query = 'consulta sobre circular normativa compliance';

      await mod.llmReorderService.rerank(
        query,
        [
          {
            content: 'versão antiga do documento',
            source: 'chunk-1',
            artigo_ou_secao: 'a',
            score: 0.5,
          },
        ],
        { topK: 1 },
      );
      // Mesmo source id, conteúdo diferente — se a chave usasse só o source,
      // isto seria um cache hit indevido (rerankScore calculado sobre texto
      // que não existe mais para este chunk).
      await mod.llmReorderService.rerank(
        query,
        [
          {
            content: 'versão nova do documento',
            source: 'chunk-1',
            artigo_ou_secao: 'a',
            score: 0.5,
          },
        ],
        { topK: 1 },
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);

      delete process.env.RERANK_ENABLED;
      delete process.env.OPENROUTER_API_KEY;
      vi.doUnmock('../../server/metrics');
    });

    it('mesma query + mesmo conteúdo reaproveita o cache (não chama a rede de novo)', async () => {
      process.env.RERANK_ENABLED = 'true';
      process.env.OPENROUTER_API_KEY = 'test-key';
      vi.resetModules();
      vi.doMock('../../server/metrics', () => ({
        rerankEffectiveTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
        rerankFailureTotal: { inc: vi.fn() },
      }));

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ index: 0, relevance_score: 0.9 }],
            usage: { search_units: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import('../../server/services/llm-reorder');
      const query = 'consulta sobre circular normativa compliance';
      const docs = [
        { content: 'mesmo conteúdo', source: 'chunk-1', artigo_ou_secao: 'a', score: 0.5 },
      ];

      await mod.llmReorderService.rerank(query, docs, { topK: 1 });
      await mod.llmReorderService.rerank(query, docs, { topK: 1 });

      expect(fetchMock).toHaveBeenCalledTimes(1);

      delete process.env.RERANK_ENABLED;
      delete process.env.OPENROUTER_API_KEY;
      vi.doUnmock('../../server/metrics');
    });
  });
});
