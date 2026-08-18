/** @vitest-environment jsdom */

import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatModelName, useModelNames } from '../../../../client/src/hooks/use-model-names';

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

describe('useModelNames', () => {
  it('maps backend aliases and active model ids to the backend-derived label', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            alias: 'technical',
            family: 'coding',
            provider: 'openrouter',
            activeModelId: 'provider/new-model-v2',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useModelNames(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/model-names');
    expect(result.current.isFallback).toBe(false);
    expect(result.current.modelNames.technical).toBe('Technical');
    expect(result.current.modelNames['provider/new-model-v2']).toBe('Technical');
  });

  it('keeps a minimal fallback when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const { result } = renderHook(() => useModelNames(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isFallback).toBe(true);
    expect(result.current.modelNames).toEqual({ 'openrouter/auto': 'Auto Router' });
  });

  it('keeps a minimal fallback when the API response is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }),
    );

    const { result } = renderHook(() => useModelNames(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isFallback).toBe(true);
    expect(result.current.modelNames).toEqual({ 'openrouter/auto': 'Auto Router' });
  });

  it('formats an unknown model without requiring a hardcoded catalog entry', () => {
    expect(formatModelName('new-provider/super_model-v3:free', {})).toBe('Super Model V3');
  });
});
