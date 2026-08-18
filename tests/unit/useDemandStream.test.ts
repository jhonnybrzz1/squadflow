/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDemandStream } from '@/hooks/useDemandStream';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({ data: [] })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock('@/lib/api', () => ({
  api: {
    demands: {
      getAll: vi.fn(),
      subscribeToUpdates: vi.fn(),
    },
  },
}));

describe('useDemandStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default states', () => {
    const { result } = renderHook(() => useDemandStream({}));
    expect(result.current.selectedDemand).toBeNull();
    expect(result.current.streamingText).toBeNull();
    expect(result.current.isPaused).toBe(false);
  });

  it('should handle input_required event', () => {
    let subscriptionOptions: any;
    (api.demands.subscribeToUpdates as any).mockImplementation(
      (id: number, onUpdate: any, options: any) => {
        subscriptionOptions = options;
        return () => {};
      },
    );

    // Mock processing demand to trigger subscribe
    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: 1, status: 'processing' }],
    } as any);

    const mockOnInputRequired = vi.fn();
    const { result } = renderHook(() => useDemandStream({ onInputRequired: mockOnInputRequired }));

    act(() => {
      if (subscriptionOptions?.onInputRequired) {
        subscriptionOptions.onInputRequired('Need info?', 'inter-123');
      }
    });

    expect(result.current.isPaused).toBe(true);
    expect(result.current.pendingInteraction?.question).toBe('Need info?');
    expect(mockOnInputRequired).toHaveBeenCalledWith('Need info?', 'inter-123', 'assistente');
  });

  it('should handle AbortController and connection timeouts', () => {
    vi.useFakeTimers();
    let subscriptionOptions: any;
    (api.demands.subscribeToUpdates as any).mockImplementation(
      (id: number, onUpdate: any, options: any) => {
        subscriptionOptions = options;
        return () => {};
      },
    );

    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: 1, status: 'processing' }],
    } as any);

    const { result, unmount } = renderHook(() => useDemandStream({}));

    // Initially stable
    expect(result.current.connectionStatus).toBe('stable');

    // Fast-forward 120 seconds to trigger unstable connection status
    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(result.current.connectionStatus).toBe('unstable');

    // Fast-forward another 120 seconds to trigger failed connection status
    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(result.current.connectionStatus).toBe('failed');

    // Verify signal is passed
    expect(subscriptionOptions?.signal).toBeInstanceOf(AbortSignal);
    const abortSpy = vi.fn();
    subscriptionOptions.signal.addEventListener('abort', abortSpy);

    unmount();
    expect(abortSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('should track connection errors to trigger failure after 3', () => {
    let subscriptionOptions: any;
    (api.demands.subscribeToUpdates as any).mockImplementation(
      (id: number, onUpdate: any, options: any) => {
        subscriptionOptions = options;
        return () => {};
      },
    );

    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: 1, status: 'processing' }],
    } as any);

    const { result } = renderHook(() => useDemandStream({}));

    act(() => {
      subscriptionOptions.onError();
    });
    expect(result.current.connectionStatus).toBe('unstable');
    expect(result.current.errorCount).toBe(1);

    act(() => {
      subscriptionOptions.onError();
      subscriptionOptions.onError();
    });
    expect(result.current.connectionStatus).toBe('failed');
    expect(result.current.errorCount).toBe(3);
  });

  it('should invalidate queries when demand completes or urls change', () => {
    const mockInvalidate = vi.fn();
    vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: mockInvalidate } as any);

    // Initial fetch
    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: 1, status: 'processing', prdUrl: null, tasksUrl: null }],
    } as any);

    const { rerender } = renderHook(() =>
      useDemandStream({
        propSelectedDemand: { id: 1, status: 'processing', prdUrl: null, tasksUrl: null } as any,
      }),
    );

    // Now it updates
    vi.mocked(useQuery).mockReturnValue({
      data: [
        {
          id: 1,
          status: 'completed',
          prdUrl: 'new-prd',
          tasksUrl: 'new-tasks',
          updatedAt: '2026-05-31T00:00:00Z',
        },
      ],
    } as any);

    rerender();

    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['/api/demands/1/documents/prd'] });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['/api/demands/1/documents/tasks'] });
  });

  it('should clear streaming text when final message arrives', () => {
    let subscriptionOptions: any;
    (api.demands.subscribeToUpdates as any).mockImplementation(
      (id: number, onUpdate: any, options: any) => {
        subscriptionOptions = options;
        return () => {};
      },
    );

    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: 1, status: 'processing' }],
    } as any);

    const { result, rerender } = renderHook(() => useDemandStream({}));

    act(() => {
      subscriptionOptions.onAgentChunk('test-agent', 'Hello');
      subscriptionOptions.onAgentStreamEnd('test-agent');
    });

    expect(result.current.streamingText).toEqual({ agent: 'test-agent', content: 'Hello' });

    // Simulate new message arriving from query
    vi.mocked(useQuery).mockReturnValue({
      data: [
        {
          id: 1,
          status: 'processing',
          chatMessages: [
            { agent: 'test-agent', type: 'completed', timestamp: new Date().toISOString() },
          ],
        },
      ],
    } as any);

    rerender();

    // Stream should be cleared
    expect(result.current.streamingText).toBeNull();
  });
});
