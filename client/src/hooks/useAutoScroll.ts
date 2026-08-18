import { useRef, useEffect, useCallback, useState, type UIEvent } from 'react';
import { trackRefinementEvent } from '@/lib/refinement-telemetry';

interface UseAutoScrollProps {
  chatMessagesLength: number;
  streamingTextLength: number;
  demandId?: number | null;
  isHistoryMode?: boolean;
  isReadingMode?: boolean;
  lastAgentMessage?: { id: string; agent: string };
}

export function useAutoScroll({
  chatMessagesLength,
  streamingTextLength,
  demandId,
  isHistoryMode = false,
  isReadingMode = false,
  lastAgentMessage,
}: UseAutoScrollProps) {
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastDemandIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const isUserActivelyScrollingRef = useRef(false);
  const scrollDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const lastAgentRenderRef = useRef<{
    messageId: string;
    stageId: string;
    renderedAt: number;
    scrollTracked: boolean;
    messageOffsetTop?: number;
  } | null>(null);

  // Detect active user scrolling via wheel, touchmove, and keyboard arrow events
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const markActiveScroll = () => {
      isUserActivelyScrollingRef.current = true;
      if (scrollDebounceTimerRef.current) {
        clearTimeout(scrollDebounceTimerRef.current);
      }
      scrollDebounceTimerRef.current = setTimeout(() => {
        isUserActivelyScrollingRef.current = false;
      }, 300);
    };

    const handleWheel = () => markActiveScroll();
    const handleTouchMove = () => markActiveScroll();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        markActiveScroll();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('keydown', handleKeyDown);
      if (scrollDebounceTimerRef.current) {
        clearTimeout(scrollDebounceTimerRef.current);
      }
    };
  }, []);

  // Update auto-scroll on new messages or stream chunks
  useEffect(() => {
    const demandChanged = lastDemandIdRef.current !== demandId;
    lastDemandIdRef.current = demandId ?? null;

    if (isReadingMode && !demandChanged) return;
    if (!shouldAutoScrollRef.current && !demandChanged) return;
    if (isUserActivelyScrollingRef.current && !demandChanged) return;
    if (isHistoryMode && !demandChanged) return;

    const container = chatContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      shouldAutoScrollRef.current = true;
      setIsAtBottom(true);
    }
  }, [demandId, chatMessagesLength, streamingTextLength, isReadingMode, isHistoryMode]);

  // Track the latest agent message to emit analytics on scroll up
  useEffect(() => {
    if (!demandId || !lastAgentMessage) return;

    // Only reset tracking when the actual latest message changes
    if (lastAgentRenderRef.current?.messageId === lastAgentMessage.id) return;

    const renderedAt = Date.now();
    lastAgentRenderRef.current = {
      messageId: lastAgentMessage.id,
      stageId: `${demandId}:${lastAgentMessage.agent}`,
      renderedAt,
      scrollTracked: false,
    };
  }, [chatMessagesLength, demandId, lastAgentMessage?.id, lastAgentMessage?.agent]);

  const handleMessageScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const currentScrollTop = container.scrollTop;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    const atBottom = distanceToBottom <= 48;
    shouldAutoScrollRef.current = atBottom;
    setIsAtBottom(atBottom);
    const scrollDeltaPx = lastScrollTopRef.current - currentScrollTop;
    const activeMessage = lastAgentRenderRef.current;

    if (
      activeMessage &&
      !activeMessage.scrollTracked &&
      isUserActivelyScrollingRef.current &&
      scrollDeltaPx >= 80 &&
      Date.now() - activeMessage.renderedAt <= 60_000
    ) {
      activeMessage.scrollTracked = true;
      const occurredAt = Date.now();
      const msFromResponseToScrollUp = occurredAt - activeMessage.renderedAt;

      const messageOffsetTop = activeMessage.messageOffsetTop ?? 0;
      const scrollExceededResponseStart = currentScrollTop < messageOffsetTop;

      trackRefinementEvent('refinement_scroll_up_after_agent', {
        messageId: activeMessage.messageId,
        stageId: activeMessage.stageId,
        occurred: true,
        occurredAt,
        scrollDeltaPx,
        scrollY: currentScrollTop,
        qualityFlags: ['real_scroll_up_delta_met'],
      });

      trackRefinementEvent('refinement_scroll_up_timing_measured', {
        messageId: activeMessage.messageId,
        stageId: activeMessage.stageId,
        occurredAt,
        msFromResponseToScrollUp,
        qualityFlags: ['timing_measured'],
      });

      if (scrollExceededResponseStart) {
        trackRefinementEvent('refinement_scroll_exceeded_response_start', {
          messageId: activeMessage.messageId,
          stageId: activeMessage.stageId,
          occurredAt,
          scrollY: currentScrollTop,
          scrollExceededResponseStart: true,
          qualityFlags: ['exceeded_response_start'],
        });
      }
    }

    lastScrollTopRef.current = currentScrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = chatContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      shouldAutoScrollRef.current = true;
      setIsAtBottom(true);
    }
  }, []);

  return {
    chatContainerRef,
    handleMessageScroll,
    scrollToBottom,
    isAtBottom,
  };
}
