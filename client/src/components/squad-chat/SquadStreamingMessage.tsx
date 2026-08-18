/**
 * SquadStreamingMessage - Mensagem em streaming
 *
 * Mostra o conteúdo sendo gerado em tempo real com:
 * - Cursor piscando
 * - Bloco de "pensamento" expansível
 * - Indicador visual de que está em progresso
 */

import { useState, memo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, ChevronUp, Brain } from 'lucide-react';
import type { AgentState } from '@/hooks/useSquadChat';
import ReactMarkdown from 'react-markdown';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SquadStreamingMessageProps {
  agent: AgentState;
  content: string | null;
  thinking: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SquadStreamingMessage = memo(function SquadStreamingMessage({
  agent,
  content,
  thinking,
}: SquadStreamingMessageProps) {
  const [showThinking, setShowThinking] = useState(true);
  const shouldReduceMotion = useReducedMotion();

  const hasContent = content && content.length > 0;
  const hasThinking = thinking && thinking.length > 0;

  if (!hasContent && !hasThinking) {
    return null;
  }

  return (
    <div className="squad-message squad-message-streaming" aria-busy="true">
      {/* Agent Header */}
      <div className="squad-message-header">
        <div className="squad-message-agent">
          <span className="squad-message-agent-icon" aria-hidden="true">
            {agent.icon}
          </span>
          <span className="squad-message-agent-name" style={{ color: agent.color }}>
            {agent.name}
          </span>
          <span className="squad-streaming-indicator" aria-hidden="true">
            <span className="squad-streaming-dot" />
            <span className="squad-streaming-dot" />
            <span className="squad-streaming-dot" />
          </span>
        </div>
      </div>

      {/* Thinking Block */}
      {hasThinking && (
        <div className="squad-streaming-thinking">
          <button
            onClick={() => setShowThinking(!showThinking)}
            className="squad-streaming-thinking-toggle"
            aria-expanded={showThinking}
            aria-controls="squad-streaming-thinking-content"
          >
            <Brain className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>Pensando...</span>
            {showThinking ? (
              <ChevronUp className="w-3 h-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3 h-3" aria-hidden="true" />
            )}
          </button>

          {showThinking &&
            (shouldReduceMotion ? (
              <div
                id="squad-streaming-thinking-content"
                className="squad-streaming-thinking-content"
              >
                {thinking}
                <span className="squad-streaming-cursor" aria-hidden="true" />
              </div>
            ) : (
              <motion.div
                id="squad-streaming-thinking-content"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                className="squad-streaming-thinking-content"
              >
                {thinking}
                <span className="squad-streaming-cursor" aria-hidden="true" />
              </motion.div>
            ))}
        </div>
      )}

      {/* Content */}
      {hasContent && (
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
                <pre className="bg-black/30 p-3 rounded overflow-x-auto my-2 text-sm">
                  {children}
                </pre>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
          <span className="squad-streaming-cursor" aria-hidden="true" />
        </div>
      )}
    </div>
  );
});
