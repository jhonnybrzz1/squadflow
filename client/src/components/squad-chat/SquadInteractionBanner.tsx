/**
 * SquadInteractionBanner - Banner de interação com o usuário
 *
 * Aparece quando um agente precisa de input do usuário para continuar.
 * Design distinto para chamar atenção.
 */

import { useState, memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Send, Loader2 } from 'lucide-react';
import type { AgentState } from '@/hooks/useSquadChat';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SquadInteractionBannerProps {
  agent: string;
  question: string;
  onSubmit: (response: string) => Promise<void>;
  agents: Record<string, AgentState>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SquadInteractionBanner = memo(function SquadInteractionBanner({
  agent,
  question,
  onSubmit,
  agents,
}: SquadInteractionBannerProps) {
  const [response, setResponse] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentInfo = agents[agent] || {
    id: agent,
    name: agent.replace(/_/g, ' '),
    icon: '🤖',
    color: '#64748b',
    status: 'idle' as const,
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!response.trim() || isSubmitting) return;

      setIsSubmitting(true);
      setError(null);

      try {
        await onSubmit(response);
        setResponse('');
      } catch {
        setError('Falha ao enviar resposta. Tente novamente.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [response, isSubmitting, onSubmit],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="squad-interaction-banner"
      role="region"
      aria-live="polite"
      aria-label="Agente solicita resposta do usuário"
    >
      {/* Header */}
      <div className="squad-interaction-header">
        <div className="squad-interaction-icon" aria-hidden="true">
          <MessageSquare className="w-5 h-5" />
        </div>
        <div className="squad-interaction-title">
          <span className="squad-interaction-agent-icon" aria-hidden="true">
            {agentInfo.icon}
          </span>
          <span className="squad-interaction-agent-name" style={{ color: agentInfo.color }}>
            {agentInfo.name}
          </span>
          <span className="squad-interaction-label">precisa de mais informações</span>
        </div>
      </div>

      {/* Question */}
      <div className="squad-interaction-question">{question}</div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="squad-interaction-form">
        <label htmlFor="squad-interaction-response" className="sr-only">
          Sua resposta para o agente
        </label>
        <input
          id="squad-interaction-response"
          name="squad-interaction-response"
          type="text"
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          placeholder="Digite sua resposta..."
          disabled={isSubmitting}
          autoFocus
          className="squad-interaction-input"
          aria-label="Sua resposta para o agente"
        />
        <button
          type="submit"
          disabled={!response.trim() || isSubmitting}
          className="squad-interaction-submit"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="w-4 h-4" aria-hidden="true" />
          )}
          <span>Responder</span>
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="squad-interaction-error" role="alert">
          {error}
        </div>
      )}
    </motion.div>
  );
});
