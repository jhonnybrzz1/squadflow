import { describe, expect, it, vi } from 'vitest';
import { parseAgentMessageWithRetry } from '../../server/services/ai-squad/roundtable-orchestrator';

describe('roundtable structured agent response', () => {
  it('accepts a valid fenced response without retrying', async () => {
    const retry = vi.fn();
    const result = await parseAgentMessageWithRetry(
      '```json\n{"type":"support","content":"Contribuição válida"}\n```',
      retry,
    );

    expect(result.message).toMatchObject({ type: 'response', content: 'Contribuição válida' });
    expect(result.retried).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries once when the provider returns empty content', async () => {
    const retry = vi.fn().mockResolvedValue('{"type":"response","content":"Recuperado no retry"}');
    const result = await parseAgentMessageWithRetry('', retry);

    expect(result.message.content).toBe('Recuperado no retry');
    expect(result.retried).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('retries a truncated JSON response', async () => {
    const retry = vi.fn().mockResolvedValue('{"type":"question","content":"Qual é a evidência?"}');
    const result = await parseAgentMessageWithRetry('{"type":"response","content":"cortado', retry);

    expect(result.message.type).toBe('question');
    expect(result.retried).toBe(true);
  });

  it('retries valid JSON whose contribution content is empty', async () => {
    const retry = vi.fn().mockResolvedValue('{"type":"response","content":"Conteúdo recuperado"}');
    const result = await parseAgentMessageWithRetry('{"type":"response","content":"   "}', retry);

    expect(result.message.content).toBe('Conteúdo recuperado');
    expect(result.retried).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('fails after one retry when both responses are invalid', async () => {
    const retry = vi.fn().mockResolvedValue('');

    await expect(parseAgentMessageWithRetry('', retry)).rejects.toThrow(
      'Invalid agent JSON response after structured retry',
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
