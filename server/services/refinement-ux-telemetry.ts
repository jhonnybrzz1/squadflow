import { logger } from '../utils/logger';

export type RefinementUxTelemetryEventName =
  | 'markdown_visible_duration_ms'
  | 'thinking_time_ms'
  | 'message_abandoned';

export interface RefinementUxTelemetryPayload {
  messageId?: string;
  stageId?: string;
  demandId?: number;
  agent?: string;
  markdownVisibleDurationMs?: number;
  thinkingTimeMs?: number;
  contentLength?: number;
  rawMarkdownDetected?: boolean;
  reason?: string;
  streamStartedAt?: number;
  firstChunkAt?: number;
  parseCompletedAt?: number;
  abandonedAt?: number;
  qualityFlags?: string[];
  [key: string]: unknown;
}

export function logRefinementUxTelemetry(
  eventName: RefinementUxTelemetryEventName,
  payload: RefinementUxTelemetryPayload,
  clientTimestamp?: string,
): void {
  logger.info('Refinement UX telemetry', {
    context: {
      eventName,
      clientTimestamp,
      messageId: payload.messageId,
      stageId: payload.stageId,
      demandId: payload.demandId,
      agent: payload.agent,
      markdownVisibleDurationMs: payload.markdownVisibleDurationMs,
      thinkingTimeMs: payload.thinkingTimeMs,
      contentLength: payload.contentLength,
      rawMarkdownDetected: payload.rawMarkdownDetected,
      reason: payload.reason,
      streamStartedAt: payload.streamStartedAt,
      firstChunkAt: payload.firstChunkAt,
      parseCompletedAt: payload.parseCompletedAt,
      abandonedAt: payload.abandonedAt,
      qualityFlags: payload.qualityFlags ?? [],
    },
  });
}
