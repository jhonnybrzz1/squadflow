import { describe, expect, it, vi } from 'vitest';
import { CodeAgentRouter } from '../../server/services/code-agents/router';
import type {
  CodeAgent,
  CodeAgentExecuteResult,
  CodeAgentSpecWithLifecycle,
} from '../../server/services/code-agents/types';

const spec: CodeAgentSpecWithLifecycle = {
  demandId: 10074,
  speckitPath: 'specs/10074-handoff/spec.md',
  prompt: 'implemente o roteador',
  cwd: process.cwd(),
  timeoutMs: 1000,
};

function agent(name: 'claude' | 'codex', result: CodeAgentExecuteResult): CodeAgent {
  return { name, execute: vi.fn(async () => result) };
}

describe('CodeAgentRouter — demanda 10074', () => {
  it('com multi_agent_routing desligada preserva o resultado bruto do Claude', async () => {
    const raw = { outcome: 'succeeded' as const, exitCode: 0, stdout: 'bytes\n', stderr: '' };
    const claude = agent('claude', { success: true, output: 'bytes\n', raw });
    const codex = agent('codex', { success: true, output: 'não deve executar' });
    const router = new CodeAgentRouter(
      { claude, codex },
      { isEnabled: () => false, circuitBreaker: { execute: async (_s, fn) => fn() } },
    );

    const result = await router.execute(spec, 'execution-1');

    expect(result.raw).toBe(raw);
    expect(claude.execute).toHaveBeenCalledOnce();
    expect(codex.execute).not.toHaveBeenCalled();
  });

  it('em round robin alterna Claude e Codex', async () => {
    const claude = agent('claude', { success: true, output: 'claude' });
    const codex = agent('codex', { success: true, output: 'codex' });
    const router = new CodeAgentRouter(
      { claude, codex },
      { isEnabled: () => true, circuitBreaker: { execute: async (_s, fn) => fn() } },
    );

    expect((await router.execute(spec, 'one')).output).toBe('claude');
    expect((await router.execute(spec, 'two')).output).toBe('codex');
  });

  it('falha ou timeout do Codex aciona Claude e registra a execução de fallback', async () => {
    const claude = agent('claude', { success: true, output: 'fallback claude' });
    const codex = agent('codex', { success: false, output: '', error: '5xx do bridge' });
    const router = new CodeAgentRouter(
      { claude, codex },
      {
        isEnabled: () => true,
        override: () => 'codex',
        circuitBreaker: { execute: async (_s, fn) => fn() },
      },
    );

    const result = await router.execute(spec, 'fallback');

    expect(result.output).toBe('fallback claude');
    expect(codex.execute).toHaveBeenCalledOnce();
    expect(claude.execute).toHaveBeenCalledOnce();
  });

  it('circuito aberto do Codex aciona Claude sem chamar o adapter', async () => {
    const claude = agent('claude', { success: true, output: 'fallback claude' });
    const codex = agent('codex', { success: true, output: 'codex' });
    const router = new CodeAgentRouter(
      { claude, codex },
      {
        isEnabled: () => true,
        override: () => 'codex',
        circuitBreaker: {
          execute: async () => {
            throw new Error('Circuit breaker is OPEN for Codex.');
          },
        },
      },
    );

    expect((await router.execute(spec, 'open-circuit')).output).toBe('fallback claude');
    expect(codex.execute).not.toHaveBeenCalled();
    expect(claude.execute).toHaveBeenCalledOnce();
  });

  it('timeout do bridge do Codex aciona Claude', async () => {
    const claude = agent('claude', { success: true, output: 'fallback claude' });
    const codex = agent('codex', { success: true, output: 'codex' });
    const router = new CodeAgentRouter(
      { claude, codex },
      {
        isEnabled: () => true,
        override: () => 'codex',
        circuitBreaker: {
          execute: async () => {
            throw new Error('Request to code-agent:codex timed out after 1000ms');
          },
        },
      },
    );

    expect((await router.execute(spec, 'timeout')).output).toBe('fallback claude');
    expect(codex.execute).not.toHaveBeenCalled();
    expect(claude.execute).toHaveBeenCalledOnce();
  });
});
