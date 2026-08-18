/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackRefinementEvent } from '@/lib/refinement-telemetry';

describe('refinement baseline telemetry forwarding', () => {
  beforeEach(() => {
    window.__AICHATFLOW_REFINEMENT_EVENTS__ = [];
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: undefined,
    });
  });

  it('forwards baseline telemetry events to the server without blocking UI code', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    trackRefinementEvent('thinking_time_ms', {
      messageId: 'stream:7:qa',
      stageId: '7:qa',
      demandId: 7,
      agent: 'qa',
      thinkingTimeMs: 145,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/refinement/telemetry',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        keepalive: true,
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      eventName: 'thinking_time_ms',
      payload: {
        messageId: 'stream:7:qa',
        demandId: 7,
        agent: 'qa',
        thinkingTimeMs: 145,
      },
    });
  });

  it('does not forward non-baseline refinement events', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    trackRefinementEvent('refinement_next_action_clicked', {
      messageId: 'msg-1',
      stageId: '7:qa',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
