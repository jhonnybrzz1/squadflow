/**
 * Spec 015 B3 (auditoria M-07): perdas de escrita de auditoria/segurança
 * deixam de ser silenciosas — cada perda gera métrica, log de erro e estado
 * degradado consumível pelo health-check (FR-011/SC-004).
 */
import { auditWriteLossTotal } from '../metrics';
import { logger } from '../utils/logger';

export type AuditSink = 'guardrail_log' | 'safety_log' | 'llm_audit_log' | 'demand_error_state';

const DEGRADED_WINDOW_MS = 15 * 60 * 1000;

interface AuditLossState {
  lastLossAt: number | null;
  lastSink: AuditSink | null;
  totalLosses: number;
}

const state: AuditLossState = { lastLossAt: null, lastSink: null, totalLosses: 0 };

export function recordAuditLoss(sink: AuditSink, error?: unknown): void {
  state.lastLossAt = Date.now();
  state.lastSink = sink;
  state.totalLosses += 1;
  auditWriteLossTotal.inc({ sink });
  logger.error('Perda de escrita de auditoria detectada', {
    error: error instanceof Error ? error : undefined,
    context: { sink, totalLosses: state.totalLosses },
  });
}

/** Consumido pelo health-check: degradado enquanto houver perda recente. */
export function getAuditLossState(): Readonly<AuditLossState> & { degraded: boolean } {
  return {
    ...state,
    degraded: state.lastLossAt !== null && Date.now() - state.lastLossAt < DEGRADED_WINDOW_MS,
  };
}

/** Reset interno (testes). */
export function resetAuditLossState(): void {
  state.lastLossAt = null;
  state.lastSink = null;
  state.totalLosses = 0;
}
