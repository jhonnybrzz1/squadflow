/**
 * SquadAgentPanel - Painel lateral de status dos agentes
 *
 * Mostra em tempo real:
 * - Quais agentes participam da mesa redonda
 * - Status de cada agente (idle, thinking, speaking, done, failed)
 * - Contador de divergências
 * - Progresso das rodadas
 */

import { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock,
  Loader2,
  MessageCircle,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentState, AgentStatus } from '@/hooks/useSquadChat';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SquadAgentPanelProps {
  agents: Record<string, AgentState>;
  currentSpeaker: string | null;
  divergenceCount: number;
  round: number;
  totalRounds: number;
  isComplete: boolean;
}

// ─── Status Icons ─────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: AgentStatus }) {
  const iconClass = 'w-3.5 h-3.5';

  switch (status) {
    case 'thinking':
      return (
        <Loader2
          className={cn(iconClass, 'animate-spin text-[var(--accent-violet)]')}
          aria-hidden="true"
        />
      );
    case 'speaking':
      return (
        <MessageCircle
          className={cn(iconClass, 'text-[var(--accent-cyan)] animate-pulse')}
          aria-hidden="true"
        />
      );
    case 'done':
      return <CheckCircle className={cn(iconClass, 'text-[var(--success)]')} aria-hidden="true" />;
    case 'failed':
      return <XCircle className={cn(iconClass, 'text-[var(--destructive)]')} aria-hidden="true" />;
    default:
      return (
        <Clock className={cn(iconClass, 'text-[var(--foreground-muted)]')} aria-hidden="true" />
      );
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SquadAgentPanel = memo(function SquadAgentPanel({
  agents,
  currentSpeaker,
  divergenceCount,
  round,
  totalRounds,
  isComplete,
}: SquadAgentPanelProps) {
  const agentList = Object.values(agents);
  const activeCount = agentList.filter((a) => a.status === 'done').length;
  const failedCount = agentList.filter((a) => a.status === 'failed').length;

  return (
    <aside className="squad-agent-panel" aria-label="Painel de status dos agentes">
      {/* Header */}
      <div className="squad-agent-panel-header">
        <div className="squad-agent-panel-title">
          <Zap className="w-4 h-4 text-[var(--accent-violet)]" aria-hidden="true" />
          <span>Mesa Redonda</span>
        </div>

        {totalRounds > 0 && (
          <div className="squad-agent-panel-round">
            <span className="squad-agent-panel-round-current">R{round}</span>
            <span className="squad-agent-panel-round-sep">/</span>
            <span className="squad-agent-panel-round-total">{totalRounds}</span>
          </div>
        )}
      </div>

      {/* Progress Bar */}
      {totalRounds > 0 && (
        <div
          className="squad-agent-panel-progress"
          role="progressbar"
          aria-valuenow={activeCount}
          aria-valuemin={0}
          aria-valuemax={agentList.length}
          aria-label={`Progresso: ${activeCount} de ${agentList.length} agentes concluídos`}
        >
          <motion.div
            className="squad-agent-panel-progress-fill"
            initial={{ width: 0 }}
            animate={{ width: `${(activeCount / agentList.length) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      )}

      {/* Agent List */}
      <div className="squad-agent-panel-list">
        <AnimatePresence mode="popLayout">
          {agentList.map((agent) => (
            <motion.div
              key={agent.id}
              layout
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              className={cn(
                'squad-agent-panel-item',
                agent.id === currentSpeaker && 'squad-agent-panel-item-active',
                agent.status === 'thinking' && 'squad-agent-panel-item-thinking',
                agent.status === 'speaking' && 'squad-agent-panel-item-speaking',
                agent.status === 'done' && 'squad-agent-panel-item-done',
                agent.status === 'failed' && 'squad-agent-panel-item-failed',
              )}
              style={
                {
                  '--agent-color': agent.color,
                } as React.CSSProperties
              }
            >
              <span className="squad-agent-panel-item-icon" aria-hidden="true">
                {agent.icon}
              </span>
              <span className="squad-agent-panel-item-name">{agent.name}</span>
              <span className="sr-only">
                {agent.status === 'thinking'
                  ? 'pensando'
                  : agent.status === 'speaking'
                    ? 'falando'
                    : agent.status === 'done'
                      ? 'concluído'
                      : agent.status === 'failed'
                        ? 'falhou'
                        : 'aguardando'}
              </span>
              <StatusIcon status={agent.status} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Stats */}
      <div className="squad-agent-panel-stats">
        {/* Divergence Counter */}
        {divergenceCount > 0 && (
          <div className="squad-agent-panel-stat squad-agent-panel-stat-divergence">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {divergenceCount} divergência{divergenceCount > 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Failed Counter */}
        {failedCount > 0 && (
          <div className="squad-agent-panel-stat squad-agent-panel-stat-failed">
            <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {failedCount} falha{failedCount > 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Completion Status */}
        {isComplete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="squad-agent-panel-stat squad-agent-panel-stat-complete"
          >
            <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Concluído</span>
          </motion.div>
        )}
      </div>
    </aside>
  );
});
