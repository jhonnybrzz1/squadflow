/**
 * useSquadChat - Hook unificado para chat de refinamento
 *
 * Consolida a lógica de:
 * - useDemandStream (conexão SSE)
 * - useRoundtableStream (estado roundtable)
 * - useChatTimeline (histórico de mensagens)
 *
 * Em uma única fonte de verdade para o estado do chat.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { WebSocketService } from '@/services/websocketService';
import type { Demand } from '@shared/schema';
import type { DemandListItem } from '@shared/demand-list';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'thinking' | 'speaking' | 'done' | 'failed';
export type ChatMode = 'roundtable';
export type MessageType = 'response' | 'divergence' | 'question' | 'system';
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface AgentState {
  id: string;
  name: string;
  icon: string;
  color: string;
  status: AgentStatus;
  lastActivity?: number;
}

export interface SquadMessage {
  id: string;
  agent: string;
  content: string;
  timestamp: string;
  type: MessageType;
  isStreaming?: boolean;
  thinking?: string;
  replyTo?: string;
  references?: string[];
  round?: number;
  turn?: number;
  dialogueMove?: string;
  metadata?: Record<string, unknown>;
}

export interface SquadChatState {
  mode: ChatMode;
  messages: SquadMessage[];
  agents: Record<string, AgentState>;
  currentSpeaker: string | null;
  streamingContent: string | null;
  streamingThinking: string | null;
  round: number;
  totalRounds: number;
  divergenceCount: number;
  isComplete: boolean;
  isPaused: boolean;
  pendingQuestion: {
    agent: string;
    question: string;
    interactionId: string;
    sequence: number;
  } | null;
  connectionStatus: ConnectionStatus;
}

// ─── Agent Config ─────────────────────────────────────────────────────────────

const AGENT_CONFIG: Record<string, Omit<AgentState, 'status' | 'lastActivity'>> = {
  product_owner: { id: 'product_owner', name: 'Product Owner', icon: '👑', color: '#8b5cf6' },
  scrum_master: { id: 'scrum_master', name: 'Scrum Master', icon: '🧝', color: '#84cc16' },
  qa: { id: 'qa', name: 'QA', icon: '✅', color: '#22c55e' },
  // UX Designer: canonical ID is 'ux', alias 'ux_designer' for backward compatibility
  ux: { id: 'ux', name: 'UX Designer', icon: '🎨', color: '#ec4899' },
  ux_designer: { id: 'ux', name: 'UX Designer', icon: '🎨', color: '#ec4899' },
  tech_lead: { id: 'tech_lead', name: 'Tech Lead', icon: '💧', color: '#06b6d4' },
  // Data Analyst: canonical ID is 'analista_de_dados', alias 'data_analyst' for backward compat
  analista_de_dados: {
    id: 'analista_de_dados',
    name: 'Analista de Dados',
    icon: '📈',
    color: '#f97316',
  },
  data_analyst: {
    id: 'analista_de_dados',
    name: 'Analista de Dados',
    icon: '📈',
    color: '#f97316',
  },
  product_manager: { id: 'product_manager', name: 'Product Manager', icon: '📋', color: '#eab308' },
  pm_innovation: { id: 'pm_innovation', name: 'PM Inovação', icon: '💡', color: '#fbbf24' },
  coordinator: { id: 'coordinator', name: 'Coordenador', icon: '🎯', color: '#84cc16' },
  system: { id: 'system', name: 'Sistema', icon: '⚙️', color: '#64748b' },
};

function getAgentConfig(agentId: string): Omit<AgentState, 'status' | 'lastActivity'> {
  return (
    AGENT_CONFIG[agentId] || {
      id: agentId,
      name: agentId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      icon: '🤖',
      color: '#64748b',
    }
  );
}

// ─── Initial State ────────────────────────────────────────────────────────────

const INITIAL_STATE: SquadChatState = {
  mode: 'roundtable',
  messages: [],
  agents: {},
  currentSpeaker: null,
  streamingContent: null,
  streamingThinking: null,
  round: 0,
  totalRounds: 0,
  divergenceCount: 0,
  isComplete: false,
  isPaused: false,
  pendingQuestion: null,
  connectionStatus: 'disconnected',
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSquadChatOptions {
  demandId?: number;
  onMessageComplete?: (message: SquadMessage) => void;
  onRoundComplete?: (round: number) => void;
  onDivergence?: (agent: string, content: string) => void;
}

export function useSquadChat(demand: Demand | null, options: UseSquadChatOptions = {}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SquadChatState>(INITIAL_STATE);

  // Refs para evitar re-renders
  const stateRef = useRef(state);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const interactiveSocketRef = useRef<WebSocketService | null>(null);
  const optionsRef = useRef(options);

  stateRef.current = state;
  optionsRef.current = options;

  // ─── Derivações ───────────────────────────────────────────────────────────

  const isProcessing = demand?.status === 'processing';
  // Spec 10146: modo sequential removido — sempre roundtable.
  const mode: ChatMode = 'roundtable';

  // ─── Actions ──────────────────────────────────────────────────────────────

  const setAgentStatus = useCallback((agentId: string, status: AgentStatus) => {
    setState((prev) => ({
      ...prev,
      agents: {
        ...prev.agents,
        [agentId]: {
          ...getAgentConfig(agentId),
          ...prev.agents[agentId],
          status,
          lastActivity: Date.now(),
        },
      },
      currentSpeaker:
        status === 'speaking' || status === 'thinking' ? agentId : prev.currentSpeaker,
    }));
  }, []);

  const addMessage = useCallback((message: Omit<SquadMessage, 'id'> & { id?: string }) => {
    const fullMessage: SquadMessage = {
      ...message,
      id: message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };

    setState((prev) => {
      // Dedup por ID
      const exists = prev.messages.some((m) => m.id === fullMessage.id);
      if (exists) return prev;

      const newMessages = [...prev.messages, fullMessage];
      const divergenceCount =
        fullMessage.type === 'divergence' ? prev.divergenceCount + 1 : prev.divergenceCount;

      return {
        ...prev,
        messages: newMessages,
        divergenceCount,
        streamingContent: null, // Limpa streaming quando mensagem completa
      };
    });

    optionsRef.current.onMessageComplete?.(fullMessage);

    if (fullMessage.type === 'divergence') {
      optionsRef.current.onDivergence?.(fullMessage.agent, fullMessage.content);
    }
  }, []);

  const updateStreamingContent = useCallback((agent: string, chunk: string) => {
    setState((prev) => ({
      ...prev,
      currentSpeaker: agent,
      streamingContent: (prev.currentSpeaker === agent ? prev.streamingContent || '' : '') + chunk,
    }));
  }, []);

  const updateStreamingThinking = useCallback((agent: string, chunk: string) => {
    setState((prev) => ({
      ...prev,
      currentSpeaker: agent,
      streamingThinking:
        (prev.currentSpeaker === agent ? prev.streamingThinking || '' : '') + chunk,
    }));
  }, []);

  const clearStreaming = useCallback(() => {
    setState((prev) => ({
      ...prev,
      streamingContent: null,
      streamingThinking: null,
    }));
  }, []);

  const setRoundInfo = useCallback((round: number, totalRounds: number) => {
    setState((prev) => ({ ...prev, round, totalRounds }));
  }, []);

  const initializeAgents = useCallback((agentIds: string[]) => {
    const agents: Record<string, AgentState> = {};
    agentIds.forEach((id) => {
      agents[id] = { ...getAgentConfig(id), status: 'idle' };
    });
    setState((prev) => ({ ...prev, agents }));
  }, []);

  const setComplete = useCallback((complete: boolean) => {
    setState((prev) => ({ ...prev, isComplete: complete }));
  }, []);

  const setPaused = useCallback(
    (
      paused: boolean,
      question?: { agent: string; question: string; interactionId: string; sequence: number },
    ) => {
      setState((prev) => ({
        ...prev,
        isPaused: paused,
        pendingQuestion: question || null,
      }));
    },
    [],
  );

  const setConnectionStatus = useCallback((status: ConnectionStatus) => {
    setState((prev) => ({ ...prev, connectionStatus: status }));
  }, []);

  // ─── SSE Event Handlers ───────────────────────────────────────────────────

  const handleSSEEvent = useCallback(
    (eventType: string, data: Record<string, unknown>) => {
      setConnectionStatus('connected');
      // Reset heartbeat on any event
      if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = setTimeout(() => {
        setConnectionStatus('reconnecting');
      }, 120000);

      switch (eventType) {
        // ─── Sequential Events ─────────────────────────────────────────────
        case 'agent_chunk': {
          const agent = data.agent as string;
          const chunk = data.chunk as string;
          if (agent && chunk) {
            setAgentStatus(agent, 'speaking');
            updateStreamingContent(agent, chunk);
          }
          break;
        }

        case 'agent_reasoning_chunk': {
          const agent = data.agent as string;
          const chunk = data.chunk as string;
          if (agent && chunk) {
            setAgentStatus(agent, 'thinking');
            updateStreamingThinking(agent, chunk);
          }
          break;
        }

        case 'agent_stream_end': {
          const agent = data.agent as string;
          if (agent) {
            setAgentStatus(agent, 'done');
            clearStreaming();
          }
          break;
        }

        // ─── Roundtable Events ─────────────────────────────────────────────
        case 'roundtable_round_start': {
          const round = (data.round as number) || 1;
          const totalRounds = (data.totalRounds as number) || 1;
          const agents = (data.agents as string[]) || [];

          setRoundInfo(round, totalRounds);
          initializeAgents(agents);
          optionsRef.current.onRoundComplete?.(round);
          break;
        }

        case 'roundtable_agent_start': {
          const agent = data.agent as string;
          if (agent) {
            setAgentStatus(agent, 'thinking');
          }
          break;
        }

        // Spec 014 S3 (M-01): chunks de streaming da mesa redonda.
        // Payload do servidor: { agent, round, chunk }.
        case 'roundtable_agent_token': {
          const agent = data.agent as string;
          const chunk = data.chunk as string;
          if (agent && chunk) {
            setAgentStatus(agent, 'speaking');
            updateStreamingContent(agent, chunk);
          }
          break;
        }

        case 'roundtable_agent_message': {
          const agentId = data.agent_id as string;
          const content = data.content as string;
          const round = data.round as number;
          const msgType = data.type as string;
          const responseTo = data.response_to as string | undefined;
          const references = data.references as string[] | undefined;
          const dialogueMove = data.dialogue_move as string | undefined;

          if (agentId && content) {
            setAgentStatus(agentId, 'speaking');
            // Mensagem final substitui o buffer de streaming — sem duplicação
            // quando roundtable_agent_token está ativo (spec 014 US3-AS2).
            clearStreaming();

            addMessage({
              id: `rt-${agentId}-${round}-${Date.now()}`,
              agent: agentId,
              content,
              timestamp: new Date().toISOString(),
              type: (msgType as MessageType) || 'response',
              replyTo: responseTo,
              references,
              round,
              dialogueMove,
            });

            // Marca como done após adicionar
            setTimeout(() => setAgentStatus(agentId, 'done'), 100);
          }
          break;
        }

        case 'roundtable_agent_done': {
          const agent = data.agent as string;
          if (agent) {
            setAgentStatus(agent, 'done');
          }
          break;
        }

        case 'roundtable_divergence': {
          const agent = data.agent as string;
          const text = data.text as string;
          if (agent && text) {
            optionsRef.current.onDivergence?.(agent, text);
          }
          break;
        }

        case 'roundtable_complete': {
          setComplete(true);
          break;
        }

        case 'agent_failed': {
          const agent = data.agent as string;
          if (agent) {
            setAgentStatus(agent, 'failed');
          }
          break;
        }

        // ─── Interaction Events ────────────────────────────────────────────
        case 'input_required': {
          const question = data.question as string;
          const interactionId = data.interactionId as string;
          const sequence = Number(data.sequence ?? 0);
          const agent = (data.agent as string) || stateRef.current.currentSpeaker || 'system';

          setPaused(true, { agent, question, interactionId, sequence });
          break;
        }

        // ─── Terminal Events ───────────────────────────────────────────────
        case 'completed': {
          setComplete(true);
          break;
        }

        case 'error': {
          setConnectionStatus('disconnected');
          break;
        }
      }
    },
    [
      setAgentStatus,
      updateStreamingContent,
      updateStreamingThinking,
      clearStreaming,
      setRoundInfo,
      initializeAgents,
      setComplete,
      setPaused,
      setConnectionStatus,
      addMessage,
    ],
  );

  // ─── Initialize from History ──────────────────────────────────────────────

  useEffect(() => {
    if (!demand?.chatMessages) return;

    const messages: SquadMessage[] = demand.chatMessages.map((msg) => {
      const rtMeta = msg.metadata?.roundtable as Record<string, unknown> | undefined;

      return {
        id: msg.id,
        agent: msg.agent,
        content: msg.message,
        timestamp: msg.timestamp,
        type:
          (rtMeta?.msgType as MessageType) ||
          (msg.category === 'question' ? 'question' : 'response'),
        thinking: msg.thinking,
        replyTo: rtMeta?.responseTo as string | undefined,
        references: rtMeta?.references as string[] | undefined,
        round: rtMeta?.round as number | undefined,
        turn: rtMeta?.turn as number | undefined,
        dialogueMove: rtMeta?.dialogueMove as string | undefined,
        metadata: msg.metadata,
      };
    });

    // Extrair agentes únicos
    const agentIds = [...new Set(messages.map((m) => m.agent))];
    const agents: Record<string, AgentState> = {};
    agentIds.forEach((id) => {
      if (id !== 'system' && id !== 'user') {
        agents[id] = { ...getAgentConfig(id), status: 'done' };
      }
    });

    // Contar divergências
    const divergenceCount = messages.filter((m) => m.type === 'divergence').length;

    // Detectar rodada máxima
    const maxRound = Math.max(0, ...messages.map((m) => m.round || 0));

    setState((prev) => ({
      ...prev,
      mode,
      messages,
      agents,
      divergenceCount,
      round: maxRound,
      totalRounds: maxRound,
      isComplete: demand.status === 'completed' || demand.status === 'stopped',
    }));
  }, [demand?.id, demand?.chatMessages?.length, demand?.status, mode]);

  // ─── SSE Subscription ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!demand?.id || !isProcessing) {
      setConnectionStatus('disconnected');
      return;
    }

    setConnectionStatus('connected');
    setState((prev) => ({ ...prev, mode, isComplete: false }));

    const abortController = new AbortController();

    const unsubscribe = api.demands.subscribeToUpdates(
      demand.id,
      (updatedDemand: DemandListItem) => {
        // SSE sends DemandListItem snapshots (status/progress/URLs). Full
        // messages are fetched via GET /api/demands/:id/messages or assembled
        // from agent_chunk / roundtable_agent_message events.
        queryClient.setQueryData(['/api/demands'], (old: DemandListItem[] | undefined) => {
          if (!old) return [updatedDemand];
          return old.map((d) => (d.id === updatedDemand.id ? updatedDemand : d));
        });
      },
      {
        signal: abortController.signal,
        onAgentChunk: (agent, chunk) => handleSSEEvent('agent_chunk', { agent, chunk }),
        onAgentReasoningChunk: (agent, chunk) =>
          handleSSEEvent('agent_reasoning_chunk', { agent, chunk }),
        onAgentStreamEnd: (agent) => handleSSEEvent('agent_stream_end', { agent }),
        onInputRequired: (question, interactionId, agent) => {
          handleSSEEvent('input_required', { question, interactionId, agent });
        },
        onAnyEvent: handleSSEEvent,
        onError: () => {
          setConnectionStatus('reconnecting');
          // Auto-retry logic
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            setConnectionStatus('disconnected');
          }, 120000);
        },
      },
    );

    return () => {
      abortController.abort();
      unsubscribe();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
    };
  }, [demand?.id, isProcessing, mode, handleSSEEvent, queryClient]);

  // ─── Interactive WebSocket ────────────────────────────────────────────────

  useEffect(() => {
    if (!demand?.id || !isProcessing) {
      interactiveSocketRef.current?.disconnect();
      interactiveSocketRef.current = null;
      return;
    }

    const socket = new WebSocketService();
    interactiveSocketRef.current = socket;

    const offStatus = socket.on('status', (message) => {
      const data = message.data as {
        status?: string;
        activeInteraction?: {
          interactionId?: string;
          question?: string;
          sequence?: number;
          agent?: string;
        };
      };
      const active = data.activeInteraction;
      if (active?.interactionId && active.question) {
        setPaused(true, {
          agent: active.agent || stateRef.current.currentSpeaker || 'system',
          question: active.question,
          interactionId: active.interactionId,
          sequence: Number(active.sequence ?? 0),
        });
        return;
      }
      if (data.status !== 'PAUSED') {
        setPaused(false);
      }
    });

    const offQuestion = socket.on('question', (message) => {
      const data = message.data as {
        interactionId?: string;
        question?: string;
        sequence?: number;
        agent?: string;
      };
      if (!data.interactionId || !data.question) return;
      setPaused(true, {
        agent: data.agent || stateRef.current.currentSpeaker || 'system',
        question: data.question,
        interactionId: data.interactionId,
        sequence: Number(data.sequence ?? 0),
      });
    });

    const offAck = socket.on('ack', (message) => {
      const data = message.data as { action?: string; status?: string };
      if (data.action === 'answer' || data.action === 'resume') {
        setPaused(false);
      } else if (data.action === 'pause' || data.status === 'PAUSED') {
        setPaused(true, stateRef.current.pendingQuestion || undefined);
      }
    });

    const offError = socket.on('error', () => setConnectionStatus('reconnecting'));

    socket.connect(demand.id);

    return () => {
      offStatus();
      offQuestion();
      offAck();
      offError();
      socket.disconnect();
      if (interactiveSocketRef.current === socket) {
        interactiveSocketRef.current = null;
      }
    };
  }, [demand?.id, isProcessing, setPaused, setConnectionStatus]);

  // ─── Computed Values ──────────────────────────────────────────────────────

  const activeAgents = useMemo(
    () => Object.values(state.agents).filter((a) => a.status !== 'idle'),
    [state.agents],
  );

  const speakingAgent = useMemo(
    () => (state.currentSpeaker ? state.agents[state.currentSpeaker] : null),
    [state.currentSpeaker, state.agents],
  );

  const threadedMessages = useMemo(() => {
    // Agrupa mensagens por thread (para roundtable com replies)
    const threads: Map<string, SquadMessage[]> = new Map();
    const rootMessages: SquadMessage[] = [];

    state.messages.forEach((msg) => {
      if (msg.replyTo) {
        const thread = threads.get(msg.replyTo) || [];
        thread.push(msg);
        threads.set(msg.replyTo, thread);
      } else {
        rootMessages.push(msg);
      }
    });

    return { rootMessages, threads };
  }, [state.messages]);

  // ─── API ──────────────────────────────────────────────────────────────────

  const submitResponse = useCallback(
    async (text: string) => {
      if (!demand?.id || !state.pendingQuestion) return;

      try {
        const sent = interactiveSocketRef.current?.sendAnswer(
          state.pendingQuestion.interactionId,
          state.pendingQuestion.sequence,
          text,
        );
        if (!sent) {
          await api.demands.submitInteraction(
            demand.id,
            state.pendingQuestion.interactionId,
            text,
            state.pendingQuestion.sequence,
          );
        }
        setPaused(false);
      } catch (error) {
        console.error('[useSquadChat] Failed to submit response:', error);
        throw error;
      }
    },
    [demand?.id, state.pendingQuestion, setPaused],
  );

  const pauseRefinement = useCallback(
    async (reason?: string) => {
      if (!demand?.id) return;
      const sent = interactiveSocketRef.current?.sendPause(reason);
      if (!sent) {
        await api.refinement.pause(String(demand.id));
      }
      setPaused(true, stateRef.current.pendingQuestion || undefined);
    },
    [demand?.id, setPaused],
  );

  const resumeRefinement = useCallback(async () => {
    if (!demand?.id) return;
    const sent = interactiveSocketRef.current?.sendResume();
    if (!sent) {
      await api.refinement.resume(String(demand.id));
    }
    setPaused(false);
  }, [demand?.id, setPaused]);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    // State
    ...state,

    // Computed
    activeAgents,
    speakingAgent,
    threadedMessages,
    isProcessing,

    // Actions
    submitResponse,
    pauseRefinement,
    resumeRefinement,
    reset,

    // Raw access (for debugging)
    _setState: setState,
  };
}

export type SquadChatReturn = ReturnType<typeof useSquadChat>;
