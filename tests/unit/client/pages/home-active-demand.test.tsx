/** @vitest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Demand } from '@shared/schema';
import Home from '../../../../client/src/pages/home';
import { api } from '@/lib/api';

vi.mock('@/components/demand-form', () => ({
  DemandForm: () => <div>Demand form</div>,
}));

vi.mock('@/components/history-sidebar', () => ({
  HistorySidebar: ({
    demands,
    onSelectDemand,
  }: {
    demands: Demand[];
    onSelectDemand?: (demand: Demand) => void;
  }) => (
    <button onClick={() => onSelectDemand?.(demands.find((demand) => demand.id === 7)!)}>
      Abrir histórico
    </button>
  ),
}));

vi.mock('@/components/squad-members', () => ({ SquadMembers: () => null }));
vi.mock('@/components/priority-matrix', () => ({ PriorityMatrix: () => null }));
vi.mock('@/components/prompt-template-library', () => ({ PromptTemplateLibrary: () => null }));
vi.mock('@/components/squad-chat', () => ({
  ChatAreaV2: ({ selectedDemand }: { selectedDemand?: Demand | null }) => (
    <div data-testid="chat-demand">
      {selectedDemand ? `${selectedDemand.id}:${selectedDemand.status}` : 'none'}
    </div>
  ),
}));
vi.mock('@/components/ui/theme-provider', () => ({
  useEnhancedTheme: () => ({ toggleTheme: vi.fn(), isDarkMode: true }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    demands: {
      getAll: vi.fn(),
      getMessages: vi.fn(),
    },
  },
}));

const active = {
  id: 42,
  title: 'Refinamento ativo',
  status: 'processing',
  updatedAt: new Date('2026-07-14T22:00:00Z'),
} as Demand;
const history = {
  id: 7,
  title: 'Refinamento concluído',
  status: 'completed',
  updatedAt: new Date('2026-07-14T21:00:00Z'),
} as Demand;

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Home />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('Home active refinement selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.demands.getAll).mockResolvedValue([history, active]);
    vi.mocked(api.demands.getMessages).mockResolvedValue([]);
  });

  it('shows an active refinement in ChatArea without requiring a click', async () => {
    const queryClient = renderHome();

    expect(await screen.findByText('42:processing')).toBeTruthy();

    queryClient.setQueryData(['/api/demands'], [{ ...active, status: 'completed' }, history]);
    await waitFor(() => expect(screen.getByTestId('chat-demand').textContent).toBe('42:completed'));
  });

  it('allows an explicit click to inspect a historical refinement', async () => {
    renderHome();
    expect(await screen.findByText('42:processing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir histórico' }));

    await waitFor(() => expect(screen.getByTestId('chat-demand').textContent).toBe('7:completed'));
  });
});
