/** @vitest-environment jsdom */
import { renderHook, act } from '@testing-library/react';
import { useChatTimeline } from '@/hooks/useChatTimeline';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ChatMessage } from '@shared/schema';
import * as api from '@/lib/api';
import * as React from 'react';

// Mock useOptimistic for React 19 compatibility in jsdom
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return {
    ...actual,
    useOptimistic: (init: any, updateFn: any) => {
      const [state, setState] = actual.useState(init);
      return [state, (newVal: any) => setState(updateFn(state, newVal))];
    },
  };
});

vi.mock('@/lib/api', () => ({
  api: {
    refinement: {
      submitAnswer: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

vi.mock('@/lib/refinement-telemetry', () => ({
  trackRefinementEvent: vi.fn(),
}));

describe('Chat Hooks Refactoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useChatTimeline', () => {
    const mockInitialMessages: ChatMessage[] = [
      {
        id: '1',
        agent: 'system',
        message: 'Hello',
        timestamp: '2023-01-01',
        type: 'completed',
      } as ChatMessage,
    ];

    it('should initialize with initial messages', () => {
      const { result } = renderHook(() =>
        useChatTimeline({ initialMessages: mockInitialMessages }),
      );
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].message).toBe('Hello');
    });

    it('should optimistically add user response and call API', async () => {
      const { result } = renderHook(() =>
        useChatTimeline({
          initialMessages: mockInitialMessages,
          refinementId: '123',
        }),
      );

      (api.api.refinement.submitAnswer as any).mockResolvedValueOnce({
        applied: true,
        interactionId: 'inter-1',
        newSequence: 2,
        status: 'ACTIVE',
      });

      await act(async () => {
        await result.current.submitUserResponse('My input', 'inter-1', 0);
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[1].agent).toBe('user');
      expect(result.current.messages[1].message).toBe('My input');
      expect(api.api.refinement.submitAnswer).toHaveBeenCalledWith('123', 'inter-1', 0, 'My input');
    });

    it('should handle pause and resume timeline', async () => {
      const { result } = renderHook(() =>
        useChatTimeline({ initialMessages: mockInitialMessages, refinementId: '123' }),
      );

      (api.api.refinement.pause as any).mockResolvedValueOnce({ success: true });
      (api.api.refinement.resume as any).mockResolvedValueOnce({ success: true });

      await act(async () => {
        await result.current.pauseTimeline();
      });
      expect(result.current.isPaused).toBe(true);
      expect(api.api.refinement.pause).toHaveBeenCalledWith('123');

      await act(async () => {
        await result.current.resumeTimeline();
      });
      expect(result.current.isPaused).toBe(false);
      expect(api.api.refinement.resume).toHaveBeenCalledWith('123');
    });
  });

  describe('useAutoScroll', () => {
    let mockContainer: HTMLDivElement;

    beforeEach(() => {
      mockContainer = document.createElement('div');
      Object.defineProperty(mockContainer, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(mockContainer, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(mockContainer, 'clientHeight', { value: 500, writable: true });
    });

    it('should auto-scroll to bottom when new messages arrive and user is at bottom', () => {
      const { result, rerender } = renderHook((props) => useAutoScroll(props), {
        initialProps: { chatMessagesLength: 0, streamingTextLength: 0, demandId: 1 },
      });

      act(() => {
        (result.current.chatContainerRef as any).current = mockContainer;
        mockContainer.scrollTop = 500;
        const event = { currentTarget: mockContainer } as unknown as React.UIEvent<HTMLDivElement>;
        result.current.handleMessageScroll(event);
      });

      rerender({ chatMessagesLength: 1, streamingTextLength: 0, demandId: 1 });
      expect(mockContainer.scrollTop).toBe(1000);
    });

    it('should NOT auto-scroll to bottom if user scrolled up', () => {
      const { result, rerender } = renderHook((props) => useAutoScroll(props), {
        initialProps: { chatMessagesLength: 0, streamingTextLength: 0, demandId: 1 },
      });

      act(() => {
        (result.current.chatContainerRef as any).current = mockContainer;
        mockContainer.scrollTop = 0;
        const event = { currentTarget: mockContainer } as unknown as React.UIEvent<HTMLDivElement>;
        result.current.handleMessageScroll(event);
      });

      rerender({ chatMessagesLength: 1, streamingTextLength: 0, demandId: 1 });
      expect(mockContainer.scrollTop).toBe(0);
    });
  });
});
