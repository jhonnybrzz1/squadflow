import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('refinement UX telemetry logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes baseline telemetry as structured server logs', async () => {
    const { logRefinementUxTelemetry } = await import('../server/services/refinement-ux-telemetry');
    const { logger } = await import('../server/utils/logger');

    logRefinementUxTelemetry(
      'markdown_visible_duration_ms',
      {
        messageId: 'msg-1',
        stageId: '7:qa',
        demandId: 7,
        agent: 'qa',
        markdownVisibleDurationMs: 340,
        rawMarkdownDetected: true,
        qualityFlags: ['baseline_only'],
      },
      '2026-05-31T00:00:00.000Z',
    );

    expect(logger.info).toHaveBeenCalledWith(
      'Refinement UX telemetry',
      expect.objectContaining({
        context: expect.objectContaining({
          eventName: 'markdown_visible_duration_ms',
          demandId: 7,
          agent: 'qa',
          markdownVisibleDurationMs: 340,
          rawMarkdownDetected: true,
          qualityFlags: ['baseline_only'],
        }),
      }),
    );
  });
});
