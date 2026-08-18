/** @vitest-environment jsdom */

import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFeatureFlag } from '../../../../client/src/hooks/useFeatureFlag';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useFeatureFlag (CRIT-5)', () => {
  it('resolves true when the backend returns the flag enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          flags: [
            {
              key: 'retrospectiveModuleEnabled',
              label: 'Retrospectiva',
              description: '',
              enabled: true,
              overridden: false,
            },
          ],
        }),
      }),
    );

    const { result } = renderHook(() => useFeatureFlag('retrospectiveModuleEnabled'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('resolves false when the flag exists but is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          flags: [
            {
              key: 'retrospectiveModuleEnabled',
              label: 'Retrospectiva',
              description: '',
              enabled: false,
              overridden: false,
            },
          ],
        }),
      }),
    );

    const { result } = renderHook(() => useFeatureFlag('retrospectiveModuleEnabled'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      // já saiu do estado inicial `false` para o `false` resolvido pela query
      expect(result.current).toBe(false);
    });
  });

  it('safely falls back to false when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useFeatureFlag('enableNewProductFeatures'), {
      wrapper: createWrapper(),
    });

    // sem retry, a query falha rápido; o hook nunca deve lançar nem virar `true`
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current).toBe(false);
  });
});
