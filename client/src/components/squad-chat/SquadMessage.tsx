/**
 * SquadMessage - Componente de mensagem individual
 *
 * Renderiza mensagens com suporte a:
 * - Tipos: response, divergence, question
 * - Threads de resposta (replyTo)
 * - Referências a arquivos
 * - Expansão de conteúdo longo
 */

import { useState, memo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  AlertTriangle,
  HelpCircle,
  FileCode,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SquadMessage as SquadMessageType, AgentState, ChatMode } from '@/hooks/useSquadChat';
import ReactMarkdown from 'react-markdown';
import { safeSerialize } from '@/lib/safe-serialize';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SquadMessageProps {
  message: SquadMessageType;
  mode: ChatMode;
  agents: Record<string, AgentState>;
  isLast?: boolean;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SquadMessage = memo(function SquadMessage({
  message,
  mode,
  agents,
  isLast = false,
}: SquadMessageProps) {
  const [isExpanded, setIsExpanded] = useState(isLast);
  const [showReasoning, setShowReasoning] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  // Sanitiza o conteúdo da mensagem para evitar objetos não serializáveis
  const safeMessage = {
    ...message,
    content: typeof message.content === 'string' ? message.content : safeSerialize(message.content),
    thinking: message.thinking
      ? typeof message.thinking === 'string'
        ? message.thinking
        : safeSerialize(message.thinking)
      : undefined,
    references: message.references ? safeSerialize(message.references) : undefined,
  };

  const agent = agents[safeMessage.agent] || {
    id: safeMessage.agent,
    name: safeMessage.agent.replace(/_/g, ' '),
    icon: '🤖',
    color: '#64748b',
    status: 'done' as const,
  };

  const replyToAgent = safeMessage.replyTo ? agents[safeMessage.replyTo] : null;

  const isDivergence = safeMessage.type === 'divergence';
  const isQuestion = safeMessage.type === 'question';
  const isSystem = safeMessage.agent === 'system' || safeMessage.agent === 'coordinator';

  // Truncar mensagens longas
  const contentLength = String(safeMessage.content).length;
  const shouldTruncate = contentLength > 500 && !isExpanded && !isLast;
  const displayContent = shouldTruncate
    ? String(safeMessage.content).slice(0, 500) + '...'
    : String(safeMessage.content);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (isSystem) {
    return (
      <div className="squad-message squad-message-system">
        <div className="squad-message-system-content">
          <span className="squad-message-system-icon" aria-hidden="true">
            {agent.icon}
          </span>
          <span className="squad-message-system-text">{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <article
      className={cn(
        'squad-message',
        isDivergence && 'squad-message-divergence',
        isQuestion && 'squad-message-question',
      )}
      aria-label={`Mensagem de ${agent.name}`}
    >
      {/* Agent Header */}
      <div className="squad-message-header">
        <div className="squad-message-agent">
          <span className="squad-message-agent-icon" aria-hidden="true">
            {agent.icon}
          </span>
          <h3 className="squad-message-agent-name" style={{ color: agent.color }}>
            {agent.name}
          </h3>
        </div>

        <div className="squad-message-meta">
          {/* Type Badge */}
          {isDivergence && (
            <span className="squad-message-badge squad-message-badge-divergence">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              Divergência
            </span>
          )}
          {isQuestion && (
            <span className="squad-message-badge squad-message-badge-question">
              <HelpCircle className="w-3 h-3" aria-hidden="true" />
              Pergunta
            </span>
          )}

          {/* Round Badge */}
          {mode === 'roundtable' && safeMessage.round && (
            <span className="squad-message-round">R{safeMessage.round}</span>
          )}

          {/* Timestamp */}
          <span className="squad-message-time">
            <Clock className="w-3 h-3" aria-hidden="true" />
            {formatTime(safeMessage.timestamp)}
          </span>
        </div>
      </div>

      {/* Reply Context */}
      {replyToAgent && (
        <div className="squad-message-reply-context">
          <MessageSquare className="w-3 h-3" aria-hidden="true" />
          <span>Respondendo a</span>
          <span style={{ color: replyToAgent.color }}>
            <span aria-hidden="true">{replyToAgent.icon}</span> {replyToAgent.name}
          </span>
        </div>
      )}

      {/* Content */}
      <div className="squad-message-content">
        <ReactMarkdown
          components={{
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
            li: ({ children }) => <li className="mb-1">{children}</li>,
            strong: ({ children }) => <strong className="font-bold">{children}</strong>,
            code: ({ children }) => (
              <code className="bg-black/30 px-1 py-0.5 rounded text-[0.9em] font-mono">
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="bg-black/30 p-3 rounded overflow-x-auto my-2 text-sm">{children}</pre>
            ),
          }}
        >
          {displayContent}
        </ReactMarkdown>
      </div>

      {/* Expand/Collapse */}
      {shouldTruncate && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="squad-message-expand-btn min-w-[44px] min-h-[44px] items-center justify-center"
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3 h-3" aria-hidden="true" />
              Mostrar menos
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" aria-hidden="true" />
              Mostrar mais ({Math.round(contentLength / 100) * 100}+ caracteres)
            </>
          )}
        </button>
      )}

      {/* Reasoning (Thinking) */}
      {safeMessage.thinking && (
        <div className="squad-message-reasoning">
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="squad-message-reasoning-toggle min-w-[44px] min-h-[44px] items-center justify-center px-2"
            aria-expanded={showReasoning}
            aria-controls="squad-message-reasoning-content"
          >
            <span className="squad-message-reasoning-icon" aria-hidden="true">
              🧠
            </span>
            <span>Raciocínio do agente</span>
            {showReasoning ? (
              <ChevronUp className="w-3 h-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3 h-3" aria-hidden="true" />
            )}
          </button>

          {showReasoning &&
            (shouldReduceMotion ? (
              <div id="squad-message-reasoning-content" className="squad-message-reasoning-content">
                {String(safeMessage.thinking)}
              </div>
            ) : (
              <motion.div
                id="squad-message-reasoning-content"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="squad-message-reasoning-content"
              >
                {String(safeMessage.thinking)}
              </motion.div>
            ))}
        </div>
      )}

      {/* References */}
      {safeMessage.references &&
        Array.isArray(safeMessage.references) &&
        safeMessage.references.length > 0 && (
          <div className="squad-message-references">
            <span className="squad-message-references-label">
              <FileCode className="w-3 h-3" aria-hidden="true" />
              Referências:
            </span>
            {(safeMessage.references as string[]).map((ref, i) => (
              <span key={i} className="squad-message-reference">
                {String(ref)}
              </span>
            ))}
          </div>
        )}

      {/* Dialogue Move (for roundtable) */}
      {mode === 'roundtable' && safeMessage.dialogueMove && (
        <div className="squad-message-dialogue-move">{String(safeMessage.dialogueMove)}</div>
      )}
    </article>
  );
});
