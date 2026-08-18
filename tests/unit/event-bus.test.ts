import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const mockInsert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../server/services/dead-letter-service', () => ({
  deadLetterService: {
    insert: mockInsert,
  },
}));

import { eventBus, type DomainEvent } from '../../server/events/event-bus';

describe('M-2: SystemEventBus DLQ', () => {
  beforeEach(() => {
    eventBus.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    eventBus.reset();
  });

  it('evento sem subscriber cai na DLQ', () => {
    eventBus.publish('AGENT_FAILED' as DomainEvent, { demandId: 1 });
    expect(mockInsert).toHaveBeenCalledOnce();
    const call = mockInsert.mock.calls[0][0];
    expect(call.eventType).toBe('AGENT_FAILED');
    expect(call.error.message).toContain('no registered subscriber');
  });

  it('handler síncrono que lança erro é capturado e armazenado', () => {
    eventBus.subscribe('AGENT_FAILED' as DomainEvent, () => {
      throw new Error('sync boom');
    });

    eventBus.publish('AGENT_FAILED' as DomainEvent, { demandId: 2 });
    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert.mock.calls[0][0].error.message).toBe('sync boom');
  });

  it('handler assíncrono que rejeita é capturado e armazenado', async () => {
    eventBus.subscribe('AGENT_FAILED' as DomainEvent, async () => {
      throw new Error('async boom');
    });

    eventBus.publish('AGENT_FAILED' as DomainEvent, { demandId: 3 });

    // aguarda microtasks
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert.mock.calls[0][0].error.message).toBe('async boom');
  });

  it('erro não-Error é normalizado', async () => {
    eventBus.subscribe('AGENT_FAILED' as DomainEvent, () => {
      throw 'string error';
    });

    eventBus.publish('AGENT_FAILED' as DomainEvent, { demandId: 4 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert.mock.calls[0][0].error).toBe('string error');
  });

  it('happy path não gera DLQ', async () => {
    const handler = vi.fn();
    eventBus.subscribe('AGENT_FAILED' as DomainEvent, handler);

    eventBus.publish('AGENT_FAILED' as DomainEvent, { demandId: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
