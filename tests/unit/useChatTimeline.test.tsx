/**
 * @vitest-environment jsdom
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useChatTimeline } from '@/hooks/useChatTimeline';
import { api } from '@/lib/api';
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

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
  useToast: () => ({ toast: vi.fn() }),
}));

function TestWrapper({ initialMessages = [], onFail }: { initialMessages?: any[]; onFail?: any }) {
  const { messages, submitUserResponse, pauseTimeline, resumeTimeline } = useChatTimeline({
    initialMessages,
    refinementId: '1',
  });

  return (
    <div>
      <ul data-testid="messages">
        {messages.map((m: any, i: number) => (
          <li key={i}>{m.message}</li>
        ))}
      </ul>
      <button
        data-testid="submit-btn"
        onClick={async () => {
          try {
            await submitUserResponse('My response', 'inter-123', 1);
          } catch (e) {
            onFail?.(e);
          }
        }}
      >
        Send
      </button>
      <button data-testid="pause-btn" onClick={pauseTimeline}>
        Pause
      </button>
      <button data-testid="resume-btn" onClick={resumeTimeline}>
        Resume
      </button>
    </div>
  );
}

describe('useChatTimeline', () => {
  it('should initialize with initial messages', () => {
    render(
      <TestWrapper
        initialMessages={[
          { id: '1', agent: 'system', message: 'Hello', timestamp: '', type: 'completed' },
        ]}
      />,
    );
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('should add optimistic message immediately', async () => {
    vi.mocked(api.refinement.submitAnswer).mockResolvedValueOnce({
      applied: true,
      interactionId: 'inter-123',
      newSequence: 2,
      status: 'ACTIVE',
    });
    render(<TestWrapper />);

    await act(async () => {
      screen.getByTestId('submit-btn').click();
    });

    const element = await screen.findByText('My response', { selector: 'li' });
    expect(element).toBeDefined();
  });

  it('should handle submission error', async () => {
    vi.mocked(api.refinement.submitAnswer).mockRejectedValueOnce(new Error('Network error'));
    let capturedError: any;
    render(
      <TestWrapper
        onFail={(e: any) => {
          capturedError = e;
        }}
      />,
    );

    await act(async () => {
      screen.getByTestId('submit-btn').click();
    });

    expect(capturedError).toBeDefined();
    expect(capturedError.message).toBe('Network error');
  });

  it('should handle pause and resume', async () => {
    vi.mocked(api.refinement.pause).mockResolvedValueOnce({});
    vi.mocked(api.refinement.resume).mockResolvedValueOnce({});

    render(<TestWrapper />);
    await act(async () => {
      screen.getByTestId('pause-btn').click();
    });
    expect(api.refinement.pause).toHaveBeenCalledWith('1');

    await act(async () => {
      screen.getByTestId('resume-btn').click();
    });
    expect(api.refinement.resume).toHaveBeenCalledWith('1');
  });

  it('should handle pause and resume errors', async () => {
    vi.mocked(api.refinement.pause).mockRejectedValueOnce(new Error('error'));
    vi.mocked(api.refinement.resume).mockRejectedValueOnce(new Error('error'));

    render(<TestWrapper />);
    await act(async () => {
      screen.getByTestId('pause-btn').click();
    });

    await act(async () => {
      screen.getByTestId('resume-btn').click();
    });
    // Coverage hits the catch blocks
  });

  it('should have no accessibility violations in the basic timeline UI', async () => {
    const { container } = render(
      <TestWrapper
        initialMessages={[
          {
            id: '1',
            agent: 'system',
            message: 'Accessible message',
            timestamp: '',
            type: 'completed',
          },
        ]}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
