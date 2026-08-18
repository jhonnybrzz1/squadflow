import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIService,
  resolveRequestBudgetMs,
  type AIChatMessage,
} from '../server/services/openai-ai';
import { fallbackManager } from '../server/services/llm-routing';
import { embeddingsManager } from '../server/services/llm-embeddings-operations';
import { resolveMaxTokens, resolveProvider } from '../server/services/llm-model-router';
import { resolveConcurrency } from '../server/services/llm-utils';
import { canonicalizeText, prepareMessages } from '../server/services/llm-message-preparer';

describe('OpenAIService local behavior', () => {
  it('propaga falha do lote sem fabricar documentos de fallback', async () => {
    const service = new OpenAIService();
    vi.spyOn(service, 'generateChatCompletion').mockRejectedValue(
      new Error('provider indisponível'),
    );
    const prompts = [
      { systemPrompt: 'Gere o PRD', userPrompt: 'demanda' },
      { systemPrompt: 'Gere Tasks', userPrompt: 'demanda' },
    ];

    await expect(service.generateMultipleChatCompletions(prompts)).rejects.toThrow(
      'provider indisponível',
    );
    expect(service.generateChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('retorna apenas as respostas reais quando todas as chamadas do lote passam', async () => {
    const service = new OpenAIService();
    vi.spyOn(service, 'generateChatCompletion')
      .mockResolvedValueOnce('PRD real')
      .mockResolvedValueOnce('Tasks reais');

    await expect(
      service.generateMultipleChatCompletions([
        { systemPrompt: 'PRD', userPrompt: 'a' },
        { systemPrompt: 'Tasks', userPrompt: 'b' },
      ]),
    ).resolves.toEqual(['PRD real', 'Tasks reais']);
  });

  it('applies default max tokens by task type', () => {
    expect(resolveMaxTokens({ taskType: 'classification' } as any)).toBe(300);
    expect(resolveMaxTokens({ taskType: 'json' } as any)).toBe(400);
    expect(resolveMaxTokens({ taskType: 'simple' } as any)).toBe(800);
    expect(resolveMaxTokens({ taskType: 'analysis' } as any)).toBe(1800);
    expect(resolveMaxTokens({ taskType: 'document' } as any)).toBe(2000);
    expect(resolveMaxTokens({ taskType: 'generation' } as any)).toBe(1600);
    expect(resolveMaxTokens({} as any)).toBe(800);
    expect(resolveMaxTokens({ maxTokens: 1234, taskType: 'simple' } as any)).toBe(1234);
  });

  it('trims chat history to the last N user turns and keeps instructions', () => {
    const messages: AIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'developer', content: 'dev' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ];

    const prepared = prepareMessages(messages, {
      maxHistoryTurns: 2,
      summaryMemory: 'summary-state',
    });

    expect(prepared.map((item) => item.content)).toEqual([
      'sys',
      'dev',
      'Resumo persistente da conversa:\nsummary-state',
      'a1',
      'u2',
      'a2',
      'u3',
      'a3',
    ]);
  });

  it('H-13: preserves UUIDs/timestamps, redacts only security-sensitive values', () => {
    const canonical = canonicalizeText(
      'requestId=abc123   at 2026-05-05T12:00:00Z user_id: 99 uuid 123e4567-e89b-12d3-a456-426614174000',
    );

    // Security-sensitive values are still redacted
    expect(canonical).toContain('requestId=<id>');
    expect(canonical).toContain('user_id=<id>');
    expect(canonical).not.toContain('abc123');
    // H-13: UUIDs and timestamps are now PRESERVED (not replaced)
    expect(canonical).toContain('2026-05-05T12:00:00Z');
    expect(canonical).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(canonical).not.toContain('<datetime>');
    expect(canonical).not.toContain('<uuid>');
  });

  it('respects explicit concurrency and clamps invalid values', () => {
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(50)).toBe(10);
    expect(resolveConcurrency(0)).toBe(4);
  });

  it('routes OpenRouter model ids to the OpenRouter provider', () => {
    expect(resolveProvider('inclusionai/ring-2.6-1t:free')).toBe('openrouter');
    expect(resolveProvider('openrouter/free')).toBe('openrouter');
    expect(resolveProvider('gpt-5.4-mini')).toBe('openai');
  });

  it('generates deterministic local 3072d embeddings', () => {
    const generateLocalEmbedding = (embeddingsManager as any).generateLocalEmbedding.bind(
      embeddingsManager,
    ) as (text: string) => number[];

    const first = generateLocalEmbedding('generic sample text');
    const second = generateLocalEmbedding('generic sample text');

    expect(first).toHaveLength(3072);
    expect(second).toEqual(first);
    expect(first.some((value) => value !== 0)).toBe(true);
  });

  it('enforces fallback rate limiting', () => {
    const checkAndRecord = fallbackManager.checkAndRecordFallback.bind(
      fallbackManager,
    ) as () => boolean;

    // Deve permitir até 5 fallbacks seguidos
    expect(checkAndRecord()).toBe(true);
    expect(checkAndRecord()).toBe(true);
    expect(checkAndRecord()).toBe(true);
    expect(checkAndRecord()).toBe(true);
    expect(checkAndRecord()).toBe(true);

    // O sexto deve ser bloqueado por exceder o limite de 5
    expect(checkAndRecord()).toBe(false);

    // Se limparmos os timestamps simulando a passagem do tempo, deve liberar novamente
    (fallbackManager as any).fallbackTimestamps = [];
    expect(checkAndRecord()).toBe(true);
  });
});

/**
 * Auditoria 2026-08-03 — "Failed to parse AI JSON response: Unexpected end of
 * JSON input" na retrospectiva.
 *
 * `generateJSONResponse` força `taskType: 'json'`, cujo default é 400 tokens.
 * O JSON da síntese estourava esse teto e vinha cortado. O caminho de reparo
 * então reenviava o conteúdo TRUNCADO pedindo correção — com o mesmo teto de
 * 400. Ele teria que ecoar tudo e ainda fechar o JSON no mesmo espaço, então
 * truncava de novo e o erro chegava ao usuário. Reparo conserta JSON
 * MALFORMADO; JSON INCOMPLETO só volta inteiro com mais orçamento.
 */
describe('generateJSONResponse — truncamento vs. malformação (auditoria 2026-08-03)', () => {
  it('refaz o pedido ORIGINAL com mais orçamento quando a resposta trunca', async () => {
    const { ResponseTruncatedError } = await import('../server/services/openai-ai/errors');
    const service = new OpenAIService();

    const spy = vi
      .spyOn(service, 'generateChatCompletion')
      .mockRejectedValueOnce(new ResponseTruncatedError('retrospective:synthesis', 400))
      .mockResolvedValueOnce('{"summary":"ok","insights":["a"]}');

    await expect(
      service.generateJSONResponse('sintetize', 'dados', {
        operation: 'retrospective:synthesis',
        maxTokens: 400,
      }),
    ).resolves.toEqual({ summary: 'ok', insights: ['a'] });

    expect(spy).toHaveBeenCalledTimes(2);

    // A 2a chamada é o pedido ORIGINAL de novo (não o prompt de reparo), com
    // orçamento maior — é o que de fato resolve truncamento.
    const [, , retryOptions] = spy.mock.calls[1];
    expect(retryOptions?.maxTokens).toBe(1600);
    expect(retryOptions?.operation).toBe('retrospective:synthesis');
    expect(spy.mock.calls[1][0]).toContain('sintetize');
  });

  it('JSON malformado mas completo continua indo para o reparo', async () => {
    const service = new OpenAIService();

    const spy = vi
      .spyOn(service, 'generateChatCompletion')
      .mockResolvedValueOnce('{summary: "sem aspas"}')
      .mockResolvedValueOnce('{"summary":"consertado"}');

    await expect(service.generateJSONResponse('s', 'u', { operation: 'x' })).resolves.toEqual({
      summary: 'consertado',
    });

    const [, , repairOptions] = spy.mock.calls[1];
    expect(repairOptions?.operation).toBe('x:repair');
  });

  it('o reparo nunca recebe orçamento menor que a resposta que está corrigindo', async () => {
    const service = new OpenAIService();

    const spy = vi
      .spyOn(service, 'generateChatCompletion')
      .mockResolvedValueOnce('{quebrado')
      .mockResolvedValueOnce('{"ok":true}');

    await service.generateJSONResponse('s', 'u', { operation: 'y', maxTokens: 2000 });

    const [, , repairOptions] = spy.mock.calls[1];
    // Antes caía no default de 400 — menor que os 2000 do conteúdo a corrigir.
    expect(repairOptions?.maxTokens).toBeGreaterThanOrEqual(2000);
  });
});

/**
 * Auditoria 2026-08-04 — teto de tokens e prazo wall-clock são acoplados.
 *
 * Subir `document:tasks` de 2000 para 4000 tokens (para parar de truncar) fez a
 * geração passar do budget fixo de 120s. Medido no `llm_audit_logs`: com teto
 * 2000 as gerações levavam 29–90s e devolviam 1538–2000 tokens; com teto 4000,
 * três tentativas seguidas abortaram em 120.013s / 120.019s / 120.021s
 * devolvendo ZERO tokens, e a demanda entrou em cooldown por falha repetida.
 * Trocar "trunca e entrega" por "estoura o prazo e não entrega" não é conserto.
 */
describe('resolveRequestBudgetMs — prazo proporcional ao teto de saída', () => {
  const defaults = { globalMs: 120_000, stageMs: 60_000 };

  it('não altera o comportamento de pedidos pequenos (fica no piso)', () => {
    // JSON (400) e chat curto continuam com o prazo default.
    expect(resolveRequestBudgetMs(400, defaults)).toEqual({ globalMs: 120_000, stageMs: 60_000 });
    expect(resolveRequestBudgetMs(1000, defaults)).toEqual({ globalMs: 120_000, stageMs: 60_000 });
  });

  it('2000 tokens já ganha folga — o pior caso medido foi 90s contra estágio de 60s', () => {
    // Não é regressão: o ajuste só AFROUXA o prazo, nunca aperta. E os 90s
    // observados no audit log mostram que 60s de estágio já era apertado
    // mesmo antes de eu subir o teto para 4000.
    expect(resolveRequestBudgetMs(2000, defaults)).toEqual({ globalMs: 240_000, stageMs: 120_000 });
  });

  it('o prazo nunca encolhe em relação ao default', () => {
    for (const tokens of [100, 400, 800, 2000, 4000, 8000]) {
      const budget = resolveRequestBudgetMs(tokens, defaults);
      expect(budget.stageMs).toBeGreaterThanOrEqual(defaults.stageMs);
      expect(budget.globalMs).toBeGreaterThanOrEqual(defaults.globalMs);
    }
  });

  it('4000 tokens ganha estágio e global maiores — o caso que quebrou', () => {
    const budget = resolveRequestBudgetMs(4000, defaults);
    expect(budget.stageMs).toBe(240_000);
    expect(budget.globalMs).toBe(300_000);
    // Uma tentativa tem que caber num ESTÁGIO: escalar só o global não
    // resolveria, porque o estágio é capado à parte e era ele que abortava.
    expect(budget.stageMs).toBeGreaterThan(defaults.stageMs);
  });

  it('o global comporta a tentativa mais um fallback', () => {
    const budget = resolveRequestBudgetMs(2500, defaults);
    expect(budget.globalMs).toBeGreaterThanOrEqual(budget.stageMs * 2);
  });

  it('nenhum pedido ultrapassa o teto absoluto (sem cascata ilimitada)', () => {
    const budget = resolveRequestBudgetMs(100_000, defaults);
    expect(budget.stageMs).toBeLessThanOrEqual(300_000);
    expect(budget.globalMs).toBeLessThanOrEqual(300_000);
  });
});
