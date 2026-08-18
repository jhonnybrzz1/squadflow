// @vitest-environment jsdom
/**
 * Spec 10006 — HandoffMetadataBadge + useHandoffManifest.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffMetadataBadge } from '../../../../client/src/components/handoff-metadata-badge';

function renderBadge(demandId = 10006) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HandoffMetadataBadge demandId={demandId} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('HandoffMetadataBadge (spec 10006)', () => {
  it('mostra id, título e metadados quando o handoff existe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              format: 'aichatflow-handoff/v1',
              demandId: 10006,
              demandTitle: 'Incluir metadados na tela',
              generatedAt: '2026-07-18T12:00:00.000Z',
              documentCount: 4,
              hasSpec: true,
              hasTasks: true,
              hasConstitution: true,
              warnings: [],
            }),
            { status: 200 },
          ),
      ),
    );
    renderBadge();
    expect(await screen.findByText(/#10006 — Incluir metadados na tela/)).toBeTruthy();
    expect(screen.getByText(/4 arquivos/)).toBeTruthy();
    expect(screen.getByText('spec')).toBeTruthy();
    expect(screen.getByText('tasks')).toBeTruthy();
  });

  it('mostra "nenhum handoff" quando a demanda não tem PRD (422)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 422 })),
    );
    renderBadge();
    await waitFor(() =>
      expect(screen.getByTestId('handoff-meta').textContent).toContain(
        'Nenhum handoff gerado ainda',
      ),
    );
  });

  it('não quebra em erro de rede', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('erro', { status: 500 })),
    );
    renderBadge();
    await waitFor(() =>
      expect(screen.getByTestId('handoff-meta').textContent).toContain(
        'Nenhum handoff gerado ainda',
      ),
    );
  });
});
