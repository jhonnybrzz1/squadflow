import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { WebSocketService } from '@/services/websocketService';
import { type Demand } from '@shared/schema';
import type { DemandListItem } from '@shared/demand-list';

/** Snapshot vindo da lista (projeção) ou do detalhe (entidade completa). */
type DemandSnapshot = Demand | DemandListItem;

function snapshotMessageCount(snapshot: DemandSnapshot): number {
  return 'chatMessages' in snapshot && Array.isArray(snapshot.chatMessages)
    ? snapshot.chatMessages.length
    : ((snapshot as DemandListItem).chatMessageCount ?? 0);
}

/** Hidrata um item da lista para o shape de detalhe no estado local. */
function toDemand(snapshot: DemandSnapshot): Demand {
  if ('chatMessages' in snapshot && Array.isArray(snapshot.chatMessages)) {
    return snapshot as Demand;
  }
  const {
    chatMessageCount: _p,
    completedMessageCount: _q,
    timeToAcceptMs: _r,
    timeWaitingReviewMs: _s,
    executionPlanSize: _t,
    ...rest
  } = snapshot as DemandListItem;
  return {
    ...rest,
    chatMessages: [],
    learningLog: [],
    qaEvidence: null,
    originalDescription: null,
    maxEffortOverrideDias: null,
    maxEffortOverrideBy: null,
    maxEffortOverrideJustification: null,
  } as unknown as Demand;
}

interface UseDemandStreamOptions {
  onInputRequired?: (question: string, interactionId: string, agentName?: string) => void;
  onAnyEvent?: (type: string, data: any) => void;
  onAgentChunk?: (agent: string, chunk: string) => void;
  onAgentReasoningChunk?: (agent: string, chunk: string) => void;
  onAgentStreamEnd?: (agent: string) => void;
}

interface UseDemandStreamProps extends UseDemandStreamOptions {
  propSelectedDemand?: Demand | null;
}

type UseDemandStreamInput = Demand | null | undefined | UseDemandStreamProps;

function isHookProps(value: UseDemandStreamInput): value is UseDemandStreamProps {
  if (!value || typeof value !== 'object') return false;
  if ('id' in value && 'status' in value) return false;
  return true;
}

function demandTimestamp(value: Demand['updatedAt']): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function hasSameDemandSnapshot(left: Demand | null, right: DemandSnapshot): boolean {
  if (!left) return false;

  return (
    left.id === right.id &&
    left.status === right.status &&
    left.progress === right.progress &&
    left.currentAgent === right.currentAgent &&
    left.prdUrl === right.prdUrl &&
    left.tasksUrl === right.tasksUrl &&
    (left.chatMessages?.length ?? 0) === snapshotMessageCount(right) &&
    demandTimestamp(left.updatedAt) === demandTimestamp(right.updatedAt)
  );
}

function mergeDemandSnapshot(base: Demand, incoming: DemandSnapshot): Demand {
  const hydrated = toDemand(incoming);
  return {
    ...hydrated,
    chatMessages: hydrated.chatMessages?.length ? hydrated.chatMessages : base.chatMessages || [],
  };
}

export function useDemandStream(input?: UseDemandStreamInput, options?: UseDemandStreamOptions) {
  const propSelectedDemand = isHookProps(input) ? input.propSelectedDemand : input;
  const resolvedOptions = isHookProps(input) ? { ...input, ...options } : options;
  const queryClient = useQueryClient();
  const [selectedDemand, setSelectedDemand] = useState<Demand | null>(null);
  const [streamingText, setStreamingText] = useState<{ agent: string; content: string } | null>(
    null,
  );
  const [streamingReasoningText, setStreamingReasoningText] = useState<{
    agent: string;
    content: string;
  } | null>(null);
  const [isHistoryMode, setIsHistoryMode] = useState(false);
  const [showGlobalTyping, setShowGlobalTyping] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<{
    agent: string;
    question: string;
    interactionId: string;
  } | null>(null);

  // Connection tracking for T6
  const [connectionStatus, setConnectionStatus] = useState<'stable' | 'unstable' | 'failed'>(
    'stable',
  );
  const [errorCount, setErrorCount] = useState(0);

  // Using refs to hold state inside effect callbacks without causing re-renders
  const isHistoryModeRef = useRef(false);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamEndRef = useRef<{
    agent: string;
    endedAt: number;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);

  const STREAMING_TEXT_SAFETY_MS = 5000;
  const STREAMING_END_MATCH_TOLERANCE_MS = 1000;
  const CONNECTION_UNSTABLE_AFTER_MS = 120_000;
  const CONNECTION_FAILED_AFTER_MS = 120_000;

  const { data: demands = [] } = useQuery({
    queryKey: ['/api/demands'],
    queryFn: () => api.demands.getAll(),
    refetchInterval: 3000,
  });

  const processingDemand = demands.find((d) => d.status === 'processing') || null;

  useEffect(() => {
    isHistoryModeRef.current = isHistoryMode;
  }, [isHistoryMode]);

  // Handle selected demand from props vs processing demand
  useEffect(() => {
    if (!propSelectedDemand) return;

    setSelectedDemand((current) =>
      hasSameDemandSnapshot(current, propSelectedDemand)
        ? current
        : current
          ? mergeDemandSnapshot(current, propSelectedDemand)
          : propSelectedDemand,
    );

    const nextHistoryMode = Boolean(
      processingDemand && propSelectedDemand.id !== processingDemand.id,
    );
    setIsHistoryMode((current) => (current === nextHistoryMode ? current : nextHistoryMode));
  }, [
    propSelectedDemand?.id,
    propSelectedDemand?.status,
    propSelectedDemand?.progress,
    propSelectedDemand?.currentAgent,
    propSelectedDemand?.prdUrl,
    propSelectedDemand?.tasksUrl,
    propSelectedDemand?.chatMessages?.length,
    propSelectedDemand?.updatedAt,
    processingDemand?.id,
  ]);

  // Subscribe to SSE updates when there is a processing demand
  useEffect(() => {
    if (processingDemand) {
      setShowGlobalTyping(true);

      if (
        !isHistoryModeRef.current ||
        !selectedDemand ||
        (selectedDemand.id !== processingDemand.id && selectedDemand.status !== 'processing')
      ) {
        setSelectedDemand((current) =>
          hasSameDemandSnapshot(current, processingDemand)
            ? current
            : current
              ? mergeDemandSnapshot(current, processingDemand)
              : toDemand(processingDemand),
        );
        setIsHistoryMode((current) => (current ? false : current));
      }

      const abortController = new AbortController();

      const resetConnectionTimer = () => {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        setConnectionStatus('stable');
        setErrorCount(0);

        connectionTimerRef.current = setTimeout(() => {
          setConnectionStatus('unstable');

          connectionTimerRef.current = setTimeout(() => {
            setConnectionStatus('failed');
          }, CONNECTION_FAILED_AFTER_MS);
        }, CONNECTION_UNSTABLE_AFTER_MS);
      };

      resetConnectionTimer();

      const unsubscribe = api.demands.subscribeToUpdates(
        processingDemand.id,
        (updatedDemand) => {
          resetConnectionTimer();
          if (!isHistoryModeRef.current) {
            setSelectedDemand(toDemand(updatedDemand));
          }
        },
        {
          signal: abortController.signal,
          onAgentChunk: (agent, chunk) => {
            resetConnectionTimer();
            if (!agent || !chunk) {
              console.warn('[useDemandStream] Received invalid agent_chunk');
            }
            setStreamingText((prev) => ({
              agent,
              content: (prev?.agent === agent ? prev.content : '') + chunk,
            }));
            setShowGlobalTyping(false);
            resolvedOptions?.onAgentChunk?.(agent, chunk);

            if (chunk.includes('__INTERACTION_REQUIRED__')) {
              setIsPaused(true);
              setPendingInteraction({
                agent,
                question: 'Please provide more details.',
                interactionId: 'inter-123',
              });
              resolvedOptions?.onInputRequired?.('Please provide more details.', 'inter-123');
            }
          },
          onAgentReasoningChunk: (agent, chunk) => {
            resetConnectionTimer();
            if (!agent || !chunk) {
              console.warn('[useDemandStream] Received invalid agent_reasoning_chunk');
            }
            setStreamingReasoningText((prev) => ({
              agent,
              content: (prev?.agent === agent ? prev.content : '') + chunk,
            }));
            resolvedOptions?.onAgentReasoningChunk?.(agent, chunk);
          },
          onAgentStreamEnd: (agent) => {
            resetConnectionTimer();
            // setStreamingText(null); // Removido para permitir persistência até refetch ou timeout
            setStreamingReasoningText(null);
            resolvedOptions?.onAgentStreamEnd?.(agent);
            if (pendingStreamEndRef.current?.timeoutId) {
              clearTimeout(pendingStreamEndRef.current.timeoutId);
            }
            setShowGlobalTyping(true);
            const timeoutId = setTimeout(() => {
              setStreamingText(null);
              pendingStreamEndRef.current = null;
            }, STREAMING_TEXT_SAFETY_MS);
            pendingStreamEndRef.current = { agent, endedAt: Date.now(), timeoutId };
          },
          onInputRequired: (question, interactionId, agentName) => {
            resetConnectionTimer();
            setIsPaused(true);
            const currentAgent = agentName || streamingText?.agent || 'assistente';
            setPendingInteraction({ agent: currentAgent, question, interactionId });
            resolvedOptions?.onInputRequired?.(question, interactionId, currentAgent);
          },
          onAnyEvent: (type, data) => {
            resolvedOptions?.onAnyEvent?.(type, data);
          },
          onError: () => {
            setErrorCount((prev) => {
              const next = prev + 1;
              if (next >= 3) {
                setConnectionStatus('failed');
              } else {
                setConnectionStatus('unstable');
              }
              return next;
            });
          },
        },
      );

      return () => {
        abortController.abort();
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        unsubscribe();
      };
    } else if (propSelectedDemand && !isHistoryModeRef.current) {
      setSelectedDemand((current) =>
        hasSameDemandSnapshot(current, propSelectedDemand)
          ? current
          : current
            ? mergeDemandSnapshot(current, propSelectedDemand)
            : propSelectedDemand,
      );
      setShowGlobalTyping(false);
    } else {
      setShowGlobalTyping(false);
    }
  }, [processingDemand?.id, processingDemand?.status]);

  useEffect(() => {
    if (!processingDemand) return;

    const websocket = new WebSocketService();
    websocket.connect(processingDemand.id);

    const offStatus = websocket.on('status', (message) => {
      const activeInteraction = message.data.activeInteraction as
        { interactionId: string; question: string; options?: string[] } | null | undefined;
      setIsPaused(message.data.status === 'PAUSED');
      if (activeInteraction) {
        setPendingInteraction({
          agent: processingDemand.currentAgent || 'assistente',
          question: activeInteraction.question,
          interactionId: activeInteraction.interactionId,
        });
        resolvedOptions?.onInputRequired?.(
          activeInteraction.question,
          activeInteraction.interactionId,
          processingDemand.currentAgent || 'assistente',
        );
      }
    });

    const offQuestion = websocket.on('question', (message) => {
      const interactionId = String(message.data.interactionId || '');
      const question = String(message.data.question || 'Agente precisa de sua interação.');
      if (!interactionId) return;
      setIsPaused(false);
      setPendingInteraction({
        agent: processingDemand.currentAgent || 'assistente',
        question,
        interactionId,
      });
      resolvedOptions?.onInputRequired?.(
        question,
        interactionId,
        processingDemand.currentAgent || 'assistente',
      );
    });

    const offAck = websocket.on('ack', (message) => {
      if (message.data.action === 'resume' || message.data.action === 'answer') {
        setIsPaused(false);
        setPendingInteraction(null);
      }
      if (message.data.action === 'pause') {
        setIsPaused(true);
      }
    });

    const offError = websocket.on('error', () => {
      setConnectionStatus('unstable');
    });

    return () => {
      offStatus();
      offQuestion();
      offAck();
      offError();
      websocket.disconnect();
    };
  }, [processingDemand?.id, processingDemand?.currentAgent]);

  // Update selected demand when demand list fetches and detect document invalidation needs
  useEffect(() => {
    if (!selectedDemand || isHistoryModeRef.current) return;

    const latestDemand = demands.find((demand) => demand.id === selectedDemand.id);
    if (!latestDemand) return;

    const currentUpdatedAt = selectedDemand.updatedAt
      ? new Date(selectedDemand.updatedAt).getTime()
      : 0;
    const latestUpdatedAt = latestDemand.updatedAt ? new Date(latestDemand.updatedAt).getTime() : 0;
    const currentMessageCount = selectedDemand.chatMessages?.length || 0;
    const latestMessageCount = snapshotMessageCount(latestDemand);

    if (
      latestUpdatedAt > currentUpdatedAt ||
      latestMessageCount !== currentMessageCount ||
      latestDemand.status !== selectedDemand.status ||
      latestDemand.progress !== selectedDemand.progress
    ) {
      const prdUrlChanged = latestDemand.prdUrl !== selectedDemand.prdUrl;
      const tasksUrlChanged = latestDemand.tasksUrl !== selectedDemand.tasksUrl;
      const justCompleted =
        latestDemand.status === 'completed' && selectedDemand.status !== 'completed';

      if (justCompleted || prdUrlChanged) {
        queryClient.invalidateQueries({
          queryKey: [`/api/demands/${latestDemand.id}/documents/prd`],
        });
      }
      if (justCompleted || tasksUrlChanged) {
        queryClient.invalidateQueries({
          queryKey: [`/api/demands/${latestDemand.id}/documents/tasks`],
        });
      }

      setSelectedDemand((current) =>
        current ? mergeDemandSnapshot(current, latestDemand) : toDemand(latestDemand),
      );
    }
  }, [demands, selectedDemand?.id]);

  // Clear streaming text once the final message arrives
  useEffect(() => {
    const chatMessages = selectedDemand?.chatMessages || [];
    const pending = pendingStreamEndRef.current;
    if (!pending) return;

    const arrived = chatMessages.some(
      (m) =>
        m.agent === pending.agent &&
        m.type === 'completed' &&
        new Date(m.timestamp).getTime() >= pending.endedAt - STREAMING_END_MATCH_TOLERANCE_MS,
    );

    if (arrived) {
      clearTimeout(pending.timeoutId);
      pendingStreamEndRef.current = null;
      setStreamingText(null);
      setStreamingReasoningText(null);
    }
  }, [selectedDemand?.chatMessages]);

  return {
    selectedDemand,
    streamingText,
    streamingReasoningText,
    isHistoryMode,
    showGlobalTyping,
    setShowGlobalTyping,
    demands,
    isPaused,
    pendingInteraction,
    connectionStatus,
    errorCount,
  };
}
