/** @vitest-environment jsdom */
/**
 * Spec 008 / US6: /admin/cost-quality deve ser autoexplicativo — legenda de
 * unidade (mUSD), tooltips por métrica e ação do kill-switch (QA 006-04).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CostQualityDashboard, {
  describeKillSwitchAction,
} from '../../../../client/src/pages/cost-quality';

const metrics = {
  timestamp: '2026-07-16T00:00:00Z',
  window: { start: '', end: '', durationMs: 900000 },
  baseline: { period: '7d', avgCostPerRequest: 0.001, totalRequests: 100 },
  current: {
    avgCostPerRequest: 0.0011419,
    totalRequests: 13,
    changeFromBaseline: 0.00014,
    changePercent: 14.2,
  },
  routing: { economicRate: 0, safeRate: 0, fallbackRate: 0, economicCount: 0, safeCount: 0 },
  cache: { hitRate: 0, totalHits: 0, totalMisses: 4, estimatedCostSaved: 0 },
  quality: { errorRate: 0, timeoutRate: 0, emptyResponseRate: 0 },
  latency: { avgMs: 35814, p50Ms: 30598, p95Ms: 98574, p99Ms: 0 },
  killSwitch: {
    active: true,
    disabledComponent: 'routing',
    triggerReason: 'cost_spike_1.14x_baseline',
    triggeredAt: '2026-07-16T00:00:00Z',
  },
};

function renderDashboard() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CostQualityDashboard />
    </QueryClientProvider>,
  );
}

describe('CostQualityDashboard — clareza para não-técnicos (spec 008 / US6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => metrics,
    })) as unknown as typeof fetch;
  });

  it('exibe legenda explicando a unidade mUSD e a janela temporal', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/mUSD = milésimos de dólar/)).toBeTruthy());
    expect(screen.getByText(/últimos 15 minutos/)).toBeTruthy();
  });

  it('cada métrica de custo/routing/cache/latência tem tooltip de ajuda', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Custo medio')).toBeTruthy());

    const helps = screen.getAllByLabelText(/^Ajuda: /);
    const labels = helps.map((el) => el.getAttribute('aria-label') ?? '');

    // Unidade explicada onde o valor aparece
    expect(labels.some((l) => l.includes('milésimos de dólar'))).toBe(true);
    // Routing explicado sem jargão cru
    expect(labels.some((l) => l.includes('roteamento econômico'))).toBe(true);
    expect(labels.some((l) => l.includes('modelo reserva'))).toBe(true);
    // Cache e latência
    expect(labels.some((l) => l.includes('direto do cache'))).toBe(true);
    expect(labels.some((l) => l.includes('p95'))).toBe(true);
    // Cobertura mínima de tooltips no dashboard
    expect(helps.length).toBeGreaterThanOrEqual(8);
  });

  it('kill-switch ativo exibe a ação em curso em linguagem de produto', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/roteamento econômico foi pausado/)).toBeTruthy());
  });
});

describe('describeKillSwitchAction', () => {
  it('descreve a ação por componente conhecido e cai em texto genérico para desconhecidos', () => {
    expect(describeKillSwitchAction('routing')).toContain('roteamento econômico foi pausado');
    expect(describeKillSwitchAction('cache')).toContain('cache de respostas foi desativado');
    expect(describeKillSwitchAction('outro')).toContain('"outro" foi desativado automaticamente');
  });
});
