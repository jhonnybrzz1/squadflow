/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistorySidebar } from '../../../../client/src/components/history-sidebar';

const toast = vi.fn();

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  api: { demands: { clearHistory: vi.fn().mockResolvedValue({ deleted: 0 }) } },
}));

const demand = {
  id: 7,
  title: 'Exportable demand',
  description: 'Description',
  type: 'feature',
  priority: 'high',
  status: 'completed',
  progress: 100,
  chatMessages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  prdUrl: null,
  tasksUrl: null,
} as never;

function renderSidebar() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <HistorySidebar demands={[demand]} />
    </QueryClientProvider>,
  );
}

async function enterSelectionAndExport() {
  await waitFor(() =>
    expect(screen.getAllByTitle('Exportar PRDs para o DocuMente').length).toBeGreaterThan(0),
  );
  const documenteButtons = screen.getAllByTitle('Exportar PRDs para o DocuMente');
  fireEvent.click(documenteButtons[0]);
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'GERAR EPICO/US' })[0]);
}

describe('HistorySidebar DocuMente result UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders safe actionable links returned by the backend', async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/integrations/documente/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ online: true, url: 'https://documente.local' }),
        } as Response;
      }
      const isEpic = String(init?.body).includes('epic');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: 'success',
          externalUrl: isEpic
            ? 'https://documente.local/epic/7'
            : 'https://documente.local/stories/7',
        }),
      } as Response;
    }) as typeof fetch;

    renderSidebar();
    await enterSelectionAndExport();

    const links = await screen.findAllByRole('link', { name: /abrir exportable demand/i });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\/documente\.local\//);
    }
  });

  it('checks DocuMente through the same-origin integration endpoint only', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ online: false, url: null }),
    }));
    global.fetch = fetchMock as typeof fetch;

    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/integrations/documente/status',
    ]);
  });

  it('renders an actionable backend failure instead of relying on console output', async () => {
    global.fetch = vi.fn(async (input) => {
      if (String(input).includes('/api/integrations/documente/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ online: true, url: 'https://documente.local' }),
        } as Response;
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({ ok: false, errorMessage: 'Lease owner unavailable' }),
      } as Response;
    }) as typeof fetch;

    renderSidebar();
    await enterSelectionAndExport();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0].textContent).toContain('Lease owner unavailable');
    expect(alerts[0].textContent).toContain('Tente novamente');
  });
});
