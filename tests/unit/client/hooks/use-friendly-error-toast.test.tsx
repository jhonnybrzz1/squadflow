/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFriendlyErrorToast } from '../../../../client/src/hooks/use-friendly-error-toast';

const toast = vi.fn();

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

describe('useFriendlyErrorToast (spec 008 / US1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mostra toast amigável PT-BR quando a query de demanda falha por rede', () => {
    const networkError = new TypeError('Failed to fetch');

    renderHook(() => useFriendlyErrorToast(networkError));

    expect(toast).toHaveBeenCalledTimes(1);
    const call = toast.mock.calls[0][0];
    expect(call.title).toBe('Sem conexão');
    expect(call.description).toBe(
      'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
    );
    expect(call.variant).toBe('destructive');
    // Nunca vaza o texto técnico cru
    expect(JSON.stringify(call)).not.toMatch(/failed to fetch/i);
  });

  it('permite título customizado mantendo a mensagem do mapa central', () => {
    renderHook(() =>
      useFriendlyErrorToast(new TypeError('Failed to fetch'), {
        title: 'Não foi possível carregar a demanda',
      }),
    );

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Não foi possível carregar a demanda',
        description:
          'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
      }),
    );
  });

  it('notifica apenas uma vez por episódio de erro (sem spam em retries/polling)', () => {
    const { rerender } = renderHook(
      ({ error }: { error: unknown }) => useFriendlyErrorToast(error),
      {
        initialProps: { error: new TypeError('Failed to fetch') as unknown },
      },
    );

    // Retries do React Query produzem novas instâncias do mesmo episódio
    rerender({ error: new TypeError('Failed to fetch') });
    rerender({ error: new TypeError('Failed to fetch') });

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('reseta o guard quando o erro é limpo e notifica novo episódio', () => {
    const { rerender } = renderHook(
      ({ error }: { error: unknown }) => useFriendlyErrorToast(error),
      {
        initialProps: { error: new TypeError('Failed to fetch') as unknown },
      },
    );

    rerender({ error: null });
    rerender({ error: new TypeError('Failed to fetch') });

    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('não notifica quando não há erro', () => {
    renderHook(() => useFriendlyErrorToast(undefined));
    expect(toast).not.toHaveBeenCalled();
  });
});
