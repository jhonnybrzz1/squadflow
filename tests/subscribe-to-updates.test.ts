import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (event: MessageEvent) => void;

/**
 * Minimal EventSource stub that lets us emit named events synchronously,
 * exposing whether close() was called.
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  closed = false;
  onmessage: Listener | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    const arr = this.listeners.get(type) ?? [];
    for (const fn of arr) fn(event);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).EventSource;
});

/**
 * Re-implementation guard: we want to test the actual function from
 * client/src/lib/api.ts. We dynamically import it after stubbing
 * EventSource so the stub is captured by the closure.
 */
async function loadApi() {
  vi.resetModules();
  const mod = await import('../client/src/lib/api');
  return mod.api;
}

describe('subscribeToUpdates – terminal close delay', () => {
  it('does NOT close the EventSource immediately when a terminal progress event arrives', async () => {
    const api = await loadApi();
    const onUpdate = vi.fn();
    api.demands.subscribeToUpdates(1, onUpdate, { terminalCloseDelayMs: 1000 });
    const es = MockEventSource.instances[0];

    es.emit('progress', { data: { demand: { id: 1, status: 'completed' } } });

    // The terminal close must be deferred, NOT immediate.
    expect(es.closed).toBe(false);

    // Before the delay elapses, the connection is still open and able to
    // deliver in-flight chunks.
    vi.advanceTimersByTime(500);
    expect(es.closed).toBe(false);

    // After the delay, the connection finally closes.
    vi.advanceTimersByTime(600);
    expect(es.closed).toBe(true);
  });

  it('still delivers agent_chunk / agent_stream_end events that arrive AFTER a terminal progress', async () => {
    const api = await loadApi();
    const onUpdate = vi.fn();
    const onAgentChunk = vi.fn();
    const onAgentStreamEnd = vi.fn();
    api.demands.subscribeToUpdates(1, onUpdate, {
      onAgentChunk,
      onAgentStreamEnd,
      terminalCloseDelayMs: 1500,
    });
    const es = MockEventSource.instances[0];

    // Terminal progress arrives first…
    es.emit('progress', { data: { demand: { id: 1, status: 'completed' } } });
    // …then the tail-end streaming events still flush.
    es.emit('agent_chunk', { data: { agent: 'qa', chunk: 'final ' } });
    es.emit('agent_chunk', { data: { agent: 'qa', chunk: 'words' } });
    es.emit('agent_stream_end', { data: { agent: 'qa' } });

    expect(onAgentChunk).toHaveBeenCalledTimes(2);
    expect(onAgentChunk).toHaveBeenNthCalledWith(1, 'qa', 'final ');
    expect(onAgentChunk).toHaveBeenNthCalledWith(2, 'qa', 'words');
    expect(onAgentStreamEnd).toHaveBeenCalledWith('qa');
    expect(es.closed).toBe(false);

    vi.advanceTimersByTime(1500);
    expect(es.closed).toBe(true);
  });

  it('coalesces multiple terminal progress events into a single close timer', async () => {
    const api = await loadApi();
    api.demands.subscribeToUpdates(1, vi.fn(), { terminalCloseDelayMs: 1000 });
    const es = MockEventSource.instances[0];

    es.emit('progress', { data: { demand: { id: 1, status: 'completed' } } });
    // A second terminal-state progress (e.g. periodic poller resending) must
    // not reset / duplicate the close timer.
    es.emit('progress', { data: { demand: { id: 1, status: 'completed' } } });

    vi.advanceTimersByTime(1000);
    expect(es.closed).toBe(true);
  });

  it('manual unsubscribe still closes immediately and clears any pending timer', async () => {
    const api = await loadApi();
    const unsubscribe = api.demands.subscribeToUpdates(1, vi.fn(), {
      terminalCloseDelayMs: 5000,
    });
    const es = MockEventSource.instances[0];

    es.emit('progress', { data: { demand: { id: 1, status: 'completed' } } });
    expect(es.closed).toBe(false);

    unsubscribe();
    expect(es.closed).toBe(true);

    // Advancing past the deferred-close window must not double-close or throw.
    vi.advanceTimersByTime(10_000);
    expect(es.closed).toBe(true);
  });
});
