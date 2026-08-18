export type RefinementMessageLengthBucket = 'short' | 'medium' | 'long';

export type RefinementAgentTextBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

export type RefinementTelemetryEventName =
  | 'markdown_visible_duration_ms'
  | 'thinking_time_ms'
  | 'message_abandoned'
  | 'refinement_agent_message_rendered'
  | 'refinement_next_action_clicked'
  | 'refinement_chat_fullscreen_toggled'
  | 'refinement_scroll_up_after_agent'
  | 'refinement_clarity_prompt_answered'
  // Diagnóstico adicional (PRD: Redução de Scroll Manual)
  | 'refinement_agent_message_height_measured'
  | 'refinement_scroll_up_timing_measured'
  | 'refinement_scroll_exceeded_response_start';

export type RefinementTelemetryPayload = {
  messageId: string;
  stageId?: string;
  mode?: 'refinement' | string;
  role?: 'agent' | 'user' | string;
  messageLengthBucket?: RefinementMessageLengthBucket;
  renderedAt?: number;
  clickedAt?: number;
  demandId?: number;
  agent?: string;
  isFullscreen?: boolean;
  occurred?: boolean;
  occurredAt?: number;
  abandonedAt?: number;
  reason?: string;
  streamStartedAt?: number;
  firstChunkAt?: number;
  parseCompletedAt?: number;
  markdownVisibleDurationMs?: number;
  thinkingTimeMs?: number;
  contentLength?: number;
  rawMarkdownDetected?: boolean;
  scrollDeltaPx?: number;
  scrollY?: number;
  clarityValue?: string | number | boolean;
  answeredAt?: number;
  correlationValid?: boolean;
  qualityFlags?: string[];
  // Diagnóstico adicional (PRD: Redução de Scroll Manual)
  /** Altura em pixels do elemento da mensagem do agente */
  messageHeightPx?: number;
  /** true se a mensagem tem markdown/tabelas complexas */
  hasComplexFormatting?: boolean;
  /** Tempo em ms entre término da resposta e o primeiro scroll_up */
  msFromResponseToScrollUp?: number;
  /** true se o scroll_up ultrapassou o início da resposta atual */
  scrollExceededResponseStart?: boolean;
};

declare global {
  interface Window {
    __AICHATFLOW_REFINEMENT_EVENTS__?: Array<{
      eventName: RefinementTelemetryEventName;
      payload: RefinementTelemetryPayload;
    }>;
  }
}

const BASELINE_TELEMETRY_EVENTS: RefinementTelemetryEventName[] = [
  'markdown_visible_duration_ms',
  'thinking_time_ms',
  'message_abandoned',
];

const RAW_MARKDOWN_PATTERN =
  /(^|\s)(#{1,6}\s+|\*\*[^*]+\*\*|__[^_]+__|`{1,3}[^`]+`{1,3}|\[[^\]]+\]\([^)]+\)|^\s*[-*+]\s+|^\s*\d+\.\s+|\|[^|\n]+\|[^|\n]+|>\s+)/m;

export function getClientPerfNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

export function normalizeRefinementAgentText(content: string): string {
  return content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

export function containsMarkdownSyntax(content: string): boolean {
  return RAW_MARKDOWN_PATTERN.test(normalizeRefinementAgentText(content));
}

export function parseRefinementAgentText(content: string): RefinementAgentTextBlock[] {
  const normalizedContent = normalizeRefinementAgentText(content);
  const lines = normalizedContent.split('\n');
  const blocks: RefinementAgentTextBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    const text = paragraphLines.join('\n').trim();
    if (text) {
      blocks.push({ type: 'paragraph', text });
    }
    paragraphLines = [];
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: 'list', items: listItems });
    }
    listItems = [];
  };

  for (const line of lines) {
    const listMatch = line.match(/^\s*\*\s+(.+)$/);

    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1].trim());
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();

  return blocks;
}

export function shouldUseRefinementPlainTextRenderer(mode: string, role: string): boolean {
  return mode === 'refinement' && role === 'agent';
}

export function getMessageLengthBucket(content: string): RefinementMessageLengthBucket {
  const length = normalizeRefinementAgentText(content).length;

  if (length < 280) return 'short';
  if (length < 900) return 'medium';
  return 'long';
}

export function trackRefinementEvent(
  eventName: RefinementTelemetryEventName,
  payload: RefinementTelemetryPayload,
): void {
  if (typeof window === 'undefined') return;

  window.__AICHATFLOW_REFINEMENT_EVENTS__ = window.__AICHATFLOW_REFINEMENT_EVENTS__ || [];
  const payloadWithDefaults: RefinementTelemetryPayload = {
    mode: 'refinement',
    role: 'agent',
    correlationValid: Boolean(payload.messageId && payload.stageId),
    qualityFlags: payload.qualityFlags ?? [],
    ...payload,
  };

  window.__AICHATFLOW_REFINEMENT_EVENTS__.push({ eventName, payload: payloadWithDefaults });
  forwardBaselineTelemetry(eventName, payloadWithDefaults);

  window.dispatchEvent(
    new CustomEvent('aichatflow:refinement-telemetry', {
      detail: { eventName, payload: payloadWithDefaults },
    }),
  );

  if (import.meta.env.DEV) {
    console.debug('[refinement-telemetry]', eventName, payloadWithDefaults);
  }
}

function forwardBaselineTelemetry(
  eventName: RefinementTelemetryEventName,
  payload: RefinementTelemetryPayload,
): void {
  if (!BASELINE_TELEMETRY_EVENTS.includes(eventName)) return;
  if (typeof window === 'undefined') return;

  const body = JSON.stringify({
    eventName,
    payload,
    clientTimestamp: new Date().toISOString(),
  });

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon('/api/refinement/telemetry', blob)) {
      return;
    }
  }

  if (typeof fetch === 'function') {
    fetch('/api/refinement/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'include',
      keepalive: true,
    }).catch(() => {
      // Telemetry must not affect the refinement flow.
    });
  }
}
