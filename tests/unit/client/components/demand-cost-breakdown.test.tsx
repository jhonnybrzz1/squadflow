// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CostBreakdownResponse } from '@shared/cost-breakdown';
import { isCostReconciled } from '@shared/cost-breakdown';
import { DemandCostBreakdown } from '../../../../client/src/components/governance/DemandCostBreakdown';

function fixture(overrides: Partial<CostBreakdownResponse> = {}): CostBreakdownResponse {
  return {
    demandId: 1,
    totalCost: 0.1,
    tokensIn: 1000,
    tokensOut: 500,
    totalRecords: 3,
    byAgent: { pm: { cost: 0.05, tokens: 800, count: 2 } },
    byTool: { github: { cost: 0.02, tokens: 200, count: 1 } },
    byModel: { deepseek: { cost: 0.07, tokens: 1000, count: 3 } },
    unattributed: { cost: 0.03, tokens: 500, count: 1 },
    ...overrides,
  };
}

function renderWithData(data: CostBreakdownResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <DemandCostBreakdown demandId={1} />
    </QueryClientProvider>,
  );
  // O card inicia colapsado; expandir para carregar e renderizar as seções.
  fireEvent.click(screen.getByRole('button', { name: /CUSTO DA DEMANDA/i }));
  return utils;
}

describe('DemandCostBreakdown (spec 014 S2 / H-09)', () => {
  it('exibe a categoria NÃO ATRIBUÍDO quando o custo é maior que zero (SC-002)', async () => {
    renderWithData(fixture());
    expect(await screen.findByText('NÃO ATRIBUÍDO')).toBeTruthy();
    expect(screen.getByTestId('cost-reconciliation').textContent).toContain('= total ✓');
  });

  it('oculta a categoria quando não há custo não atribuído', async () => {
    renderWithData(fixture({ unattributed: { cost: 0, tokens: 0, count: 0 }, totalCost: 0.07 }));
    expect(await screen.findByText('POR AGENTE')).toBeTruthy();
    expect(screen.queryByText('NÃO ATRIBUÍDO')).toBeNull();
  });

  it('sinaliza quando a soma NÃO reconcilia com o total', async () => {
    renderWithData(fixture({ totalCost: 0.5 }));
    const line = await screen.findByTestId('cost-reconciliation');
    expect(line.textContent).toContain('difere do total');
  });
});

describe('isCostReconciled (tolerância documentada)', () => {
  it('reconcilia dentro da tolerância de 0,5%', () => {
    expect(isCostReconciled(fixture({ totalCost: 0.1000004 }))).toBe(true);
  });

  it('rejeita divergência acima da tolerância', () => {
    expect(isCostReconciled(fixture({ totalCost: 0.2 }))).toBe(false);
  });
});
