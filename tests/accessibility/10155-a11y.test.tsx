/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { configureAxe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SquadMessage } from '../../client/src/components/squad-chat/SquadMessage';
import { HistorySidebar } from '../../client/src/components/history-sidebar';
import type {
  SquadMessage as SquadMessageType,
  AgentState,
  ChatMode,
} from '../../client/src/hooks/useSquadChat';
import type { DemandListItem } from '../../shared/demand-list';

expect.extend(toHaveNoViolations);

const axe = configureAxe({
  rules: {
    // Disable rules that require a full page context or color contrast tools
    'color-contrast': { enabled: false },
  },
});

const mockMessage: SquadMessageType = {
  id: 'msg-1',
  agent: 'tech_lead',
  content: 'Test message content',
  timestamp: new Date().toISOString(),
  type: 'response',
  round: 1,
};

const mockAgents: Record<string, AgentState> = {
  tech_lead: {
    id: 'tech_lead',
    name: 'Tech Lead',
    icon: '👨‍💻',
    color: '#3b82f6',
    status: 'done',
  },
};

const mockDemands: DemandListItem[] = [
  {
    id: 1,
    title: 'Test demand',
    description: 'Test description',
    status: 'pending',
    progress: 0,
    type: 'analise_exploratoria',
    priority: 'media',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe('Accessibility validation — #10155', () => {
  it('SquadMessage should have zero critical axe violations', async () => {
    const { container } = render(
      <SquadMessage message={mockMessage} mode={'roundtable' as ChatMode} agents={mockAgents} />,
    );
    const results = await axe(container);
    expect(results.violations.filter((v) => v.impact === 'critical')).toHaveLength(0);
  });

  it('HistorySidebar should have zero critical axe violations', async () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <HistorySidebar demands={mockDemands} />
      </QueryClientProvider>,
    );
    const results = await axe(container);
    expect(results.violations.filter((v) => v.impact === 'critical')).toHaveLength(0);
  });
});
