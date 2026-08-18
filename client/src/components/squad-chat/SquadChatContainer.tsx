/**
 * SquadChatContainer - Container principal do chat de refinamento
 *
 * Renderiza o chat completo com suporte a:
 * - Modo Sequencial (waterfall)
 * - Modo Mesa Redonda (roundtable com threads)
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageCircle,
  StopCircle,
  Loader2,
  CheckCircle,
  XCircle,
  Maximize2,
  Minimize2,
  Copy,
  FileJson,
  FileText,
  ChevronDown,
  Wifi,
  WifiOff,
  AlertTriangle,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { safeWindowOpen } from '@/lib/safe-window-open';
import { useSquadChat } from '@/hooks/useSquadChat';
import { SquadMessage as MessageBubble } from './SquadMessage';
import { SquadAgentPanel } from './SquadAgentPanel';
import { SquadStreamingMessage } from './SquadStreamingMessage';
import { SquadInteractionBanner } from './SquadInteractionBanner';
import type { Demand } from '@shared/schema';
import { SquadChatErrorBoundary } from '../error-boundary';

import './squad-chat.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SquadChatContainerProps {
  demand: Demand | null;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SquadChatContainer({ demand, className }: SquadChatContainerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);

  const chat = useSquadChat(demand);

  // ─── Auto-scroll ────────────────────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    if (chatContainerRef.current && !isUserScrolling) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [isUserScrolling]);

  useEffect(() => {
    scrollToBottom();
  }, [chat.messages.length, chat.streamingContent, scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setIsUserScrolling(!isAtBottom);
  }, []);

  // ─── Actions ────────────────────────────────────────────────────────────────

  const stopMutation = useMutation({
    mutationFn: async (demandId: number) => {
      return await apiRequest('POST', `/api/demands/${demandId}/stop`);
    },
    onSuccess: () => {
      toast({
        title: 'Parada solicitada',
        description: 'Concluindo a etapa atual antes de interromper.',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/demands'] });
    },
    onError: (error) => {
      console.error('Erro ao solicitar parada da demanda:', error);
      const friendly = getFriendlyErrorFromException(error);
      toast({
        title: 'Não foi possível parar agora',
        description: friendly.message,
        variant: 'destructive',
      });
    },
  });

  const handleCopyChat = async () => {
    if (!demand || chat.messages.length === 0) return;

    const content = chat.messages.map((m) => `[${m.agent}]: ${m.content}`).join('\n\n');

    await navigator.clipboard.writeText(content);
    toast({ title: 'Chat copiado!' });
  };

  const handleExportJSON = () => {
    if (!demand) return;
    safeWindowOpen(`/api/demands/${demand.id}/export/json`);
  };

  const handleExportTXT = () => {
    if (!demand) return;
    safeWindowOpen(`/api/demands/${demand.id}/export/txt`);
  };

  // ─── Fullscreen ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isFullscreen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isFullscreen]);

  // ─── Status Config ──────────────────────────────────────────────────────────

  const statusConfig = {
    processing: {
      label: 'PROCESSANDO',
      bgClass: 'bg-[var(--accent-cyan)]',
      textClass: 'text-[var(--accent-cyan)]',
      Icon: Loader2,
      animate: true,
    },
    completed: {
      label: 'COMPLETO',
      bgClass: 'bg-[var(--success)]',
      textClass: 'text-[var(--success)]',
      Icon: CheckCircle,
      animate: false,
    },
    stopped: {
      label: 'INTERROMPIDO',
      bgClass: 'bg-[var(--warning)]',
      textClass: 'text-[var(--warning)]',
      Icon: StopCircle,
      animate: false,
    },
    error: {
      label: 'ERRO',
      bgClass: 'bg-[var(--destructive)]',
      textClass: 'text-[var(--destructive)]',
      Icon: XCircle,
      animate: false,
    },
    pending: {
      label: 'AGUARDANDO',
      bgClass: 'bg-[var(--foreground-muted)]',
      textClass: 'text-[var(--foreground-muted)]',
      Icon: MessageCircle,
      animate: false,
    },
  }[demand?.status || 'pending'] || {
    label: 'AGUARDANDO',
    bgClass: 'bg-[var(--foreground-muted)]',
    textClass: 'text-[var(--foreground-muted)]',
    Icon: MessageCircle,
    animate: false,
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={cn('squad-chat-container', isFullscreen && 'squad-chat-fullscreen', className)}>
      {/* Header */}
      <header className="squad-chat-header">
        <div className="squad-chat-header-left">
          <div className={cn('squad-chat-status-icon', statusConfig.bgClass)} aria-hidden="true">
            <statusConfig.Icon className={cn('w-4 h-4', statusConfig.animate && 'animate-spin')} />
          </div>
          <div className="squad-chat-header-info">
            <h2 className="squad-chat-title">MESA REDONDA</h2>
            <div className={cn('squad-chat-status', statusConfig.textClass)}>
              <span>{statusConfig.label}</span>
              {chat.totalRounds > 0 && (
                <span className="squad-chat-round-badge">
                  R{chat.round}/{chat.totalRounds}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="squad-chat-header-actions">
          {/* Connection Status */}
          <div
            className={cn('squad-chat-connection', `connection-${chat.connectionStatus}`)}
            role="status"
            aria-label={`Conexão: ${chat.connectionStatus === 'connected' ? 'conectado' : chat.connectionStatus === 'reconnecting' ? 'reconectando' : 'desconectado'}`}
          >
            {chat.connectionStatus === 'connected' ? (
              <Wifi className="w-3 h-3" aria-hidden="true" />
            ) : chat.connectionStatus === 'reconnecting' ? (
              <AlertTriangle className="w-3 h-3 animate-pulse" aria-hidden="true" />
            ) : (
              <WifiOff className="w-3 h-3" aria-hidden="true" />
            )}
          </div>

          {/* Export Actions */}
          {demand && chat.messages.length > 0 && (
            <>
              <button
                onClick={handleCopyChat}
                className="squad-chat-action-btn"
                title="Copiar"
                aria-label="Copiar conversa"
              >
                <Copy className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                onClick={handleExportJSON}
                className="squad-chat-action-btn"
                title="JSON"
                aria-label="Exportar conversa como JSON"
              >
                <FileJson className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                onClick={handleExportTXT}
                className="squad-chat-action-btn"
                title="TXT"
                aria-label="Exportar conversa como TXT"
              >
                <FileText className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="squad-chat-action-btn"
                title={isFullscreen ? 'Minimizar' : 'Expandir'}
                aria-label={isFullscreen ? 'Minimizar chat' : 'Expandir chat para tela cheia'}
                aria-pressed={isFullscreen}
              >
                {isFullscreen ? (
                  <Minimize2 className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </>
          )}

          {/* Stop Button */}
          {chat.isProcessing && (
            <>
              {chat.isPaused ? (
                <button
                  onClick={() => void chat.resumeRefinement()}
                  className="squad-chat-action-btn"
                  title="Retomar"
                  aria-label="Retomar refinamento"
                >
                  <PlayCircle className="w-4 h-4" aria-hidden="true" />
                </button>
              ) : (
                <button
                  onClick={() => void chat.pauseRefinement('Pausa solicitada pela UI da squad')}
                  className="squad-chat-action-btn"
                  title="Pausar"
                  aria-label="Pausar refinamento"
                >
                  <PauseCircle className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
              {/* Spec 10013 US1: feedback visual imediato (idle/loading/success/error);
                  disabled durante loading evita re-clique (FR-001..003). */}
              <button
                onClick={() => demand && stopMutation.mutate(demand.id)}
                disabled={stopMutation.isPending}
                className="squad-chat-stop-btn"
                aria-busy={stopMutation.isPending}
                title={
                  stopMutation.isPending
                    ? 'Interrompendo…'
                    : stopMutation.isError
                      ? 'Não foi possível parar — tente novamente'
                      : 'Interromper refinamento'
                }
              >
                {stopMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                ) : stopMutation.isSuccess ? (
                  <CheckCircle className="w-3 h-3" aria-hidden="true" />
                ) : stopMutation.isError ? (
                  <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                ) : (
                  <StopCircle className="w-3 h-3" aria-hidden="true" />
                )}
                {stopMutation.isPending
                  ? 'INTERROMPENDO…'
                  : stopMutation.isSuccess
                    ? 'INTERROMPIDO'
                    : stopMutation.isError
                      ? 'TENTAR NOVAMENTE'
                      : 'PARAR'}
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="squad-chat-body">
        {/* Agent Panel */}
        {Object.keys(chat.agents).length > 0 && (
          <SquadAgentPanel
            agents={chat.agents}
            currentSpeaker={chat.currentSpeaker}
            divergenceCount={chat.divergenceCount}
            round={chat.round}
            totalRounds={chat.totalRounds}
            isComplete={chat.isComplete}
          />
        )}

        {/* Messages */}
        <div
          ref={chatContainerRef}
          className="squad-chat-messages"
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="Mensagens do squad de refinamento"
        >
          {chat.messages.length === 0 && !chat.streamingContent ? (
            <div className="squad-chat-empty">
              <div className="squad-chat-empty-icon" aria-hidden="true">
                <MessageCircle className="w-8 h-8" />
              </div>
              <p className="squad-chat-empty-title">Nenhuma mensagem ainda</p>
              <p className="squad-chat-empty-subtitle">
                As contribuições dos agentes aparecerão aqui
              </p>
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              {chat.messages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2, delay: index * 0.02 }}
                >
                  <MessageBubble
                    message={message}
                    mode={chat.mode}
                    agents={chat.agents}
                    isLast={index === chat.messages.length - 1}
                  />
                </motion.div>
              ))}

              {/* Streaming Message */}
              {(chat.streamingContent || chat.streamingThinking) && chat.currentSpeaker && (
                <motion.div
                  key="streaming"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <SquadStreamingMessage
                    agent={
                      chat.agents[chat.currentSpeaker] || {
                        id: chat.currentSpeaker,
                        name: chat.currentSpeaker,
                        icon: '🤖',
                        color: '#64748b',
                        status: 'speaking',
                      }
                    }
                    content={chat.streamingContent}
                    thinking={chat.streamingThinking}
                  />
                </motion.div>
              )}

              {/* Thinking Indicator (no content yet) */}
              {chat.speakingAgent?.status === 'thinking' &&
                !chat.streamingContent &&
                !chat.streamingThinking && (
                  <motion.div
                    key="thinking"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="squad-thinking-indicator"
                    aria-label={`${chat.speakingAgent.name} está pensando`}
                  >
                    <span className="squad-thinking-icon" aria-hidden="true">
                      {chat.speakingAgent.icon}
                    </span>
                    <span className="squad-thinking-name">{chat.speakingAgent.name}</span>
                    <span className="squad-thinking-dots" aria-hidden="true">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  </motion.div>
                )}
            </AnimatePresence>
          )}

          {/* Scroll anchor */}
          <div className="h-4" />
        </div>
      </div>

      {/* Interaction Banner */}
      {chat.isPaused && chat.pendingQuestion && (
        <SquadInteractionBanner
          agent={chat.pendingQuestion.agent}
          question={chat.pendingQuestion.question}
          onSubmit={chat.submitResponse}
          agents={chat.agents}
        />
      )}

      {/* Scroll to Bottom Button */}
      <AnimatePresence>
        {isUserScrolling && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => {
              setIsUserScrolling(false);
              scrollToBottom();
            }}
            className="squad-scroll-btn"
            aria-label="Rolar para o final"
          >
            <ChevronDown className="w-5 h-5" aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

// Wrapper com ErrorBoundary para captura de erros
export function SquadChatContainerWithErrorBoundary(props: SquadChatContainerProps) {
  return (
    <SquadChatErrorBoundary>
      <SquadChatContainer {...props} />
    </SquadChatErrorBoundary>
  );
}
