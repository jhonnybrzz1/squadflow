import type { Demand, WireDemand } from './schema';

/**
 * Campos removidos por toRestSafeDemand no GET /api/demands/:id.
 * Tupla exportada para manutenção e para derivar o tipo RestSafeDemand.
 */
export const REST_SAFE_REMOVED_FIELDS = [
  'reviewSnapshotId',
  'approvedSnapshotId',
  'approvedSnapshotHash',
  'finalSnapshotId',
  'finalizedFromHash',
  'approvalSessionId',
  'reviewRequestedAt',
  'approvedAt',
  'approvedBy',
  'rejectedAt',
  'rejectionReason',
  'returnedToDraftAt',
  'overrideJustification',
  'overrideBy',
  'maxEffortOverrideDias',
  'maxEffortOverrideBy',
  'maxEffortOverrideJustification',
  'runId',
  'promptTokens',
  'completionTokens',
  'custoEstimado',
  'learningLog',
  'qaEvidence',
  'skillRawUrl',
  'originalDescription',
  'finalDocHash',
] as const;

/**
 * Contrato REAL de `GET /api/demands/:id` após sanitização por toRestSafeDemand.
 * Baseado em WireDemand (timestamps serializáveis) sem os campos internos.
 */
export type RestSafeDemand = Omit<WireDemand, (typeof REST_SAFE_REMOVED_FIELDS)[number]>;

/**
 * Projeção leve da listagem de demandas (spec 014 S4 / auditoria M-03).
 * Contrato REAL de `GET /api/demands`: sem `chatMessages`, com contadores
 * e métricas derivadas. `Demand` completo (DemandDetail) só existe no
 * detalhe (`GET /api/demands/:id`).
 */
export type DemandListItem = Omit<
  Demand,
  | 'chatMessages'
  | 'learningLog'
  | 'qaEvidence'
  | 'originalDescription'
  | 'maxEffortOverrideDias'
  | 'maxEffortOverrideBy'
  | 'maxEffortOverrideJustification'
  | 'classification'
  | 'orchestration'
  | 'refinementInteractions'
  | 'sectionChecklist'
  | 'coverageAnalysis'
  | 'documentVersions'
> & {
  chatMessageCount: number;
  completedMessageCount: number;
  /** Tamanho do plano de execução (agentExecutionOrder) usado para calcular progresso. */
  executionPlanSize: number;
  /** Tempo em ms da criação até a aprovação (null se ainda não aprovada). */
  timeToAcceptMs: number | null;
  /** Tempo em ms aguardando revisão (null se não está em revisão). */
  timeWaitingReviewMs: number | null;
};

/** Entidade hidratada usada na conversa e nos documentos. */
export type DemandDetail = Demand;
