/** @vitest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { Breadcrumbs } from '../../../../client/src/components/Breadcrumbs/Breadcrumbs';

const apiMocks = vi.hoisted(() => ({
  getPolicies: vi.fn(),
  getLogs: vi.fn(),
  getDbMetrics: vi.fn(),
  getSchedulerStatus: vi.fn(),
  simulateAll: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    admin: {
      retention: {
        getPolicies: apiMocks.getPolicies,
        getLogs: apiMocks.getLogs,
        getDbMetrics: apiMocks.getDbMetrics,
        getSchedulerStatus: apiMocks.getSchedulerStatus,
        simulateAll: apiMocks.simulateAll,
        createPolicy: vi.fn(),
        updatePolicy: vi.fn(),
        deletePolicy: vi.fn(),
        runCleanup: vi.fn(),
        setSchedulerInterval: vi.fn(),
      },
    },
  },
}));

const renderWithQueryClient = (children: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {children}
    </QueryClientProvider>,
  );

describe('admin navigation accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getPolicies.mockResolvedValue([
      {
        id: 1,
        dataType: 'chat_messages',
        ttlDays: 30,
        action: 'delete',
        isActive: true,
        description: 'Mensagens antigas',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    apiMocks.getLogs.mockResolvedValue([]);
    apiMocks.getDbMetrics.mockResolvedValue({ totalSizeBytes: 0, tableCount: 0 });
    apiMocks.getSchedulerStatus.mockResolvedValue({ isRunning: false, intervalHours: 24 });
    apiMocks.simulateAll.mockResolvedValue([]);
  });

  it('renders clickable admin breadcrumbs with a non-clickable current page', () => {
    render(<Breadcrumbs path="/admin/retention" />);

    const breadcrumb = screen.getByRole('navigation', { name: /navegação hierárquica/i });
    expect(within(breadcrumb).getByRole('link', { name: 'Admin' }).getAttribute('href')).toBe(
      '/admin/dashboard',
    );
    expect(
      within(breadcrumb).getByText('Retenção de Dados').closest('[aria-current="page"]'),
    ).toBeTruthy();
    expect(within(breadcrumb).queryByRole('link', { name: 'Retenção de Dados' })).toBeNull();
  });

  it('does not render breadcrumbs outside admin routes', () => {
    render(<Breadcrumbs path="/" />);

    expect(screen.queryByRole('navigation', { name: /navegação hierárquica/i })).toBeNull();
  });

  it('renders a recoverable unavailable item for unmapped admin routes', () => {
    render(<Breadcrumbs path="/admin/configuracoes" />);

    const breadcrumb = screen.getByRole('navigation', { name: /navegação hierárquica/i });
    expect(within(breadcrumb).getByText('?').getAttribute('title')).toBe(
      'Página temporariamente indisponível',
    );
  });

  it('adds an explicit close button to the admin retention modal', async () => {
    const { default: AdminRetentionPage } =
      await import('../../../../client/src/pages/admin-retention');

    renderWithQueryClient(<AdminRetentionPage />);

    fireEvent.click(await screen.findByRole('button', { name: /nova política/i }));

    const dialog = screen.getByRole('dialog', { name: /nova política/i });
    const closeButton = within(dialog).getByRole('button', {
      name: /fechar modal de criação de política de retenção/i,
    });

    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);
    expect(screen.queryByRole('dialog', { name: /nova política/i })).toBeNull();
  });
});
