import { z } from 'zod';

/**
 * Union fechado de status de demanda (spec 014 S4 / auditoria M-04).
 * Fonte única compartilhada entre backend e frontend — `routed` é um estado
 * ATIVO (demanda roteada aguardando/iniciando processamento), não "pendente".
 */
export const demandStatusSchema = z.enum([
  'processing',
  'routed',
  'completed',
  'error',
  'stopped',
  'validation_failed',
]);

export type DemandStatus = z.infer<typeof demandStatusSchema>;

/** Estados em que a demanda está viva/em andamento na perspectiva do usuário. */
export const ACTIVE_DEMAND_STATUSES: ReadonlySet<DemandStatus> = new Set(['processing', 'routed']);

export function isActiveDemandStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_DEMAND_STATUSES.has(status as DemandStatus);
}

/** Rótulos de exibição em pt-BR para o frontend. */
export const DEMAND_STATUS_LABELS: Record<DemandStatus, string> = {
  processing: 'PROCESSANDO',
  routed: 'ROTEADA',
  completed: 'CONCLUÍDA',
  error: 'ERRO',
  stopped: 'INTERROMPIDA',
  validation_failed: 'VALIDAÇÃO FALHOU',
};
