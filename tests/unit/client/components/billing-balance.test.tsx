// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BillingBalanceView } from '../../../../client/src/components/admin/BillingBalance';
import type { BalanceResponse } from '../../../../shared/billing-balance';

const base: BalanceResponse = {
  balance: 10,
  usage: 1,
  limit: 11,
  currency: 'USD',
  stale: false,
  cachedAt: '2026-07-16T12:00:00.000Z',
  status: 'ok',
};

describe('BillingBalanceView', () => {
  afterEach(cleanup);

  it('renderiza loading e indisponibilidade acessíveis', () => {
    const { rerender } = render(<BillingBalanceView loading unavailable={false} />);
    expect(screen.getByRole('status').textContent).toContain('Consultando saldo');
    rerender(<BillingBalanceView loading={false} unavailable />);
    expect(screen.getByRole('status').textContent).toContain('Não foi possível carregar');
  });

  it.each([
    [{ ...base }, 'OK', '$10.00'],
    [{ ...base, balance: 0.5, status: 'low' as const }, 'BAIXO', '$0.50'],
    [{ ...base, balance: 0, status: 'empty' as const }, 'ESGOTADO', '$0.00'],
    [{ ...base, balance: null, limit: null }, 'OK', 'Plano ilimitado'],
    [{ ...base, stale: true, status: 'error' as const }, 'STALE', '$10.00'],
  ])('renderiza estado %s', (data, badge, value) => {
    render(<BillingBalanceView data={data} loading={false} unavailable={false} />);
    expect(screen.getByText(badge)).toBeTruthy();
    expect(screen.getByText(value)).toBeTruthy();
  });
});
