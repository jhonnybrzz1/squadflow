// @vitest-environment jsdom
/**
 * Spec "Ajustes claude" F1 — a saída de prosa do agente Claude (passos
 * `text`/`result`) deve ser renderizada como markdown legível (parágrafos,
 * tabelas GFM, code blocks com highlight), não como texto puro monospace.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentJobSteps } from '../../../../client/src/components/governance/AgentJobSteps';
import type { AgentJobView } from '../../../../shared/agent-job';

function jobWith(steps: AgentJobView['steps']): AgentJobView {
  return {
    id: 'job-1',
    demandId: 42,
    speckitPath: 'specs/42',
    status: 'succeeded',
    filesModified: [],
    typecheckPassed: true,
    apiCostUsd: null,
    humanEditsCount: 0,
    cancelledAt: null,
    errorMessage: null,
    createdAt: '2026-07-22T12:00:00.000Z',
    steps,
  };
}

function renderSteps(job: AgentJobView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([job]), { status: 200 })),
  );
  return render(
    <QueryClientProvider client={client}>
      <AgentJobSteps demandId={42} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AgentJobSteps F1 markdown', () => {
  it('renderiza tabela GFM de um passo de texto', async () => {
    const md = '| Campo | Valor |\n| --- | --- |\n| Tipo | MELHORIA |';
    renderSteps(jobWith([{ kind: 'text', label: md }]));

    const table = await screen.findByRole('table');
    expect(table).toBeTruthy();
    // Célula da tabela existe (prova de que virou <td>, não texto cru).
    expect(within(table).getByText('MELHORIA')).toBeTruthy();
  });

  it('renderiza code block com highlight (hljs) para passo de resultado', async () => {
    const md = 'Concluído:\n\n```ts\nconst x = 1;\n```';
    const { container } = renderSteps(jobWith([{ kind: 'result', label: md }]));

    await waitFor(() => expect(container.querySelector('pre')).toBeTruthy());
    // rehype-highlight aplica a classe `hljs` no <code> do bloco.
    expect(container.querySelector('pre code.hljs')).toBeTruthy();
  });

  it('mantém passos de tool como texto monospace curto (não markdown)', async () => {
    renderSteps(jobWith([{ kind: 'tool', label: 'Edit server/foo.ts' }]));

    const step = await screen.findByText('Edit server/foo.ts');
    expect(step.className).toContain('font-mono');
    // Não deve haver container markdown para um passo de tool.
    expect(step.closest('[data-testid="agent-markdown"]')).toBeNull();
  });

  it('solicita o parecer para a execução do Claude exibida, não para a demanda', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([jobWith([])]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'job-1', demandId: 42, parecer: '## Aprovado' }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AgentJobSteps demandId={42} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByTestId('tech-lead-review-button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith('/api/agent-jobs/job-1/tech-lead-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(await screen.findByText('Aprovado')).toBeTruthy();
  });
});
