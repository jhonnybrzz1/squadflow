/** @vitest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../../../client/src/components/app-shell/AppShell';
import { Tabs, TabsList, TabsTrigger } from '../../../../client/src/components/ui/tabs';

vi.mock('@/components/demand-form', () => ({
  DemandForm: () => <div>Demand form</div>,
}));

vi.mock('@/components/history-sidebar', () => ({
  HistorySidebar: () => <div>History</div>,
}));

vi.mock('@/components/squad-members', () => ({
  SquadMembers: () => <div>Squad</div>,
}));

vi.mock('@/components/priority-matrix', () => ({
  PriorityMatrix: () => <div>Priority</div>,
}));

vi.mock('@/components/prompt-template-library', () => ({
  PromptTemplateLibrary: () => <div>Prompt library</div>,
}));

vi.mock('@/components/squad-chat', () => ({
  ChatAreaV2: () => <div>Chat area v2</div>,
}));

vi.mock('@/components/ui/theme-provider', () => ({
  useEnhancedTheme: () => ({
    toggleTheme: vi.fn(),
    isDarkMode: true,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    demands: {
      getAll: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
    },
    billing: {
      getBalance: vi.fn().mockResolvedValue({ balance: 10, status: 'ok', stale: false }),
    },
  },
}));

describe('safe-area layout hooks', () => {
  // Demanda 10024: o header global mudou da Home para a Topbar do AppShell.
  it('applies the dedicated safe-area class to the shell topbar', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AppShell>
          <div>content</div>
        </AppShell>
      </QueryClientProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.className).toContain('safe-area-header');
  });

  it('keeps tabs horizontally scrollable for narrow layouts', () => {
    render(
      <Tabs defaultValue="one">
        <TabsList aria-label="Example tabs">
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
          <TabsTrigger value="three">Three</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const tabsList = screen.getByRole('tablist');
    expect(tabsList.className).toContain('safe-area-tabs');
    expect(tabsList.className).toContain('scrollbar-hide');
  });
});
