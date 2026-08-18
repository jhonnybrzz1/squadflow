import { useEffect, useRef, useCallback } from 'react';
import {
  containsMarkdownSyntax,
  getClientPerfNow,
  trackRefinementEvent,
} from '@/lib/refinement-telemetry';
import { type Demand, type ChatMessage } from '@shared/schema';

interface UseChatTelemetryProps {
  selectedDemand: Demand | null;
  streamingText: { agent: string; content: string } | null;
  isProcessing: boolean;
  isAgentThinking: boolean;
  chatMessages: ChatMessage[];
}

/**
 * Hook de telemetria para métricas de refinamento.
 * Side-effect only - não retorna valores.
 *
 * Rastreia:
 * - Tempo de "pensamento" do agente (thinking_time_ms)
 * - Duração de markdown visível (markdown_visible_duration_ms)
 * - Abandono de mensagem (message_abandoned)
 */
export function useChatTelemetry({
  selectedDemand,
  streamingText,
  isProcessing,
  isAgentThinking,
  chatMessages,
}: UseChatTelemetryProps): void {
  // Telemetry references
  const thinkingTimerRef = useRef<{
    demandId: number;
    agent: string;
    startedAt: number;
    tracked: boolean;
  } | null>(null);

  const markdownVisibleRef = useRef<{
    demandId: number;
    agent: string;
    messageId: string;
    startedAt: number;
    contentLength: number;
  } | null>(null);

  const pendingMessageRef = useRef<{
    demandId: number;
    agent: string;
    messageId: string;
    startedAt: number;
    contentLength: number;
    abandonedTracked: boolean;
  } | null>(null);

  const trackMessageAbandoned = useCallback((reason: string) => {
    const pending = pendingMessageRef.current;
    if (!pending || pending.abandonedTracked) return;

    pending.abandonedTracked = true;
    const abandonedAt = getClientPerfNow();

    trackRefinementEvent('message_abandoned', {
      messageId: pending.messageId,
      stageId: `${pending.demandId}:${pending.agent}`,
      demandId: pending.demandId,
      agent: pending.agent,
      reason,
      abandonedAt,
      streamStartedAt: pending.startedAt,
      contentLength: pending.contentLength,
      qualityFlags: ['baseline_only', reason],
    });

    if (import.meta.env.DEV) {
      console.warn('[refinement-telemetry] message_abandoned', {
        demandId: pending.demandId,
        agent: pending.agent,
        reason,
      });
    }
  }, []);

  // Track thinking time and pending message state
  useEffect(() => {
    if (!selectedDemand || !isProcessing) {
      thinkingTimerRef.current = null;
      return;
    }

    const agent = streamingText?.agent ?? selectedDemand.currentAgent ?? 'agent';
    const now = getClientPerfNow();

    if (!pendingMessageRef.current || pendingMessageRef.current.demandId !== selectedDemand.id) {
      pendingMessageRef.current = {
        demandId: selectedDemand.id,
        agent,
        messageId: `stream:${selectedDemand.id}:${agent}`,
        startedAt: now,
        contentLength: 0,
        abandonedTracked: false,
      };
    }

    pendingMessageRef.current.agent = agent;
    pendingMessageRef.current.messageId = `stream:${selectedDemand.id}:${agent}`;
    pendingMessageRef.current.contentLength = streamingText?.content.length ?? 0;

    if (isAgentThinking && !thinkingTimerRef.current) {
      thinkingTimerRef.current = {
        demandId: selectedDemand.id,
        agent,
        startedAt: now,
        tracked: false,
      };
    }

    if (streamingText && thinkingTimerRef.current && !thinkingTimerRef.current.tracked) {
      const firstChunkAt = now;
      const startedAt = thinkingTimerRef.current.startedAt;
      thinkingTimerRef.current.tracked = true;

      trackRefinementEvent('thinking_time_ms', {
        messageId: `stream:${selectedDemand.id}:${streamingText.agent}`,
        stageId: `${selectedDemand.id}:${streamingText.agent}`,
        demandId: selectedDemand.id,
        agent: streamingText.agent,
        thinkingTimeMs: Math.max(0, Math.round(firstChunkAt - startedAt)),
        streamStartedAt: startedAt,
        firstChunkAt,
        contentLength: streamingText.content.length,
        qualityFlags: ['baseline_only', 'client_timer', 'first_chunk'],
      });
    }
  }, [
    isAgentThinking,
    isProcessing,
    selectedDemand?.currentAgent,
    selectedDemand?.id,
    streamingText?.agent,
    streamingText?.content.length,
  ]);

  // Track markdown visibility start
  useEffect(() => {
    if (!selectedDemand || !streamingText) return;
    if (markdownVisibleRef.current?.demandId === selectedDemand.id) return;
    if (!containsMarkdownSyntax(streamingText.content)) return;

    markdownVisibleRef.current = {
      demandId: selectedDemand.id,
      agent: streamingText.agent,
      messageId: `stream:${selectedDemand.id}:${streamingText.agent}`,
      startedAt: getClientPerfNow(),
      contentLength: streamingText.content.length,
    };
  }, [selectedDemand?.id, streamingText?.agent, streamingText?.content]);

  // Track markdown visibility duration when stream ends
  useEffect(() => {
    const active = markdownVisibleRef.current;
    if (!active) return;

    const streamStillVisible =
      streamingText?.agent === active.agent && selectedDemand?.id === active.demandId;
    if (streamStillVisible) {
      active.contentLength = streamingText?.content.length ?? active.contentLength;
      return;
    }

    const parsedMessage = [...chatMessages]
      .reverse()
      .find((message) => message.agent === active.agent && message.type === 'completed');

    if (!parsedMessage) return;

    const parseCompletedAt = getClientPerfNow();

    trackRefinementEvent('markdown_visible_duration_ms', {
      messageId: parsedMessage.id || active.messageId,
      stageId: `${active.demandId}:${active.agent}`,
      demandId: active.demandId,
      agent: active.agent,
      markdownVisibleDurationMs: Math.max(0, Math.round(parseCompletedAt - active.startedAt)),
      streamStartedAt: active.startedAt,
      parseCompletedAt,
      contentLength: active.contentLength,
      rawMarkdownDetected: true,
      qualityFlags: ['baseline_only', 'stream_raw_markdown', 'parsed_message_rendered'],
    });

    markdownVisibleRef.current = null;
  }, [chatMessages, selectedDemand?.id, streamingText?.agent, streamingText?.content.length]);

  // Clear pending message when processing stops
  useEffect(() => {
    if (isProcessing || streamingText) return;
    pendingMessageRef.current = null;
  }, [isProcessing, streamingText]);

  // Track message abandonment on page hide or component unmount
  useEffect(() => {
    const handlePageHide = () => trackMessageAbandoned('page_hidden');

    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      trackMessageAbandoned('component_unmounted');
    };
  }, [trackMessageAbandoned]);
}
