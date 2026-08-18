/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistorySidebar } from '../../../../client/src/components/history-sidebar';

const toast = vi.fn();
const getAll = vi.fn();

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  api: {
    demands: {
      clearHistory: vi.fn().mockResolvedValue({ deleted: 0 }),
      getAll: (...args: unknown[]) => getAll(...args),
    },
  },
}));

const demand = {
  id: 7,
  title: 'Demanda de teste',
  description: 'Descrição',
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

let queryClient: QueryClient;

function renderSidebar() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HistorySidebar demands={[demand]} />
    </QueryClientProvider>,
  );
}

describe('HistorySidebar refresh sem reload (spec 008 / US2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ online: false }),
    })) as unknown as typeof fetch;
  });

  it('não faz reload completo da página ao atualizar (busca em background)', async () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    getAll.mockResolvedValue([demand]);

    renderSidebar();
    const buttons = screen.getAllByRole('button', { name: 'Atualizar lista de demandas' });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(getAll).toHaveBeenCalledTimes(1));
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['/api/demands'])).toEqual([demand]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('exibe toast amigável PT-BR quando a atualização falha por rede (offline)', async () => {
    getAll.mockRejectedValue(new TypeError('Failed to fetch'));

    renderSidebar();
    const buttons = screen.getAllByRole('button', { name: 'Atualizar lista de demandas' });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const call = toast.mock.calls[0][0];
    expect(call.title).toBe('Sem conexão');
    expect(call.description).toBe(
      'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
    );
    expect(call.variant).toBe('destructive');
    // A página permanece no SPA — o botão continua presente e reabilitado
    await waitFor(() => {
      const button = screen.getAllByRole('button', {
        name: 'Atualizar lista de demandas',
      })[0] as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });
});
