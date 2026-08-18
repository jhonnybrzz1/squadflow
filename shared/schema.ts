// H-34: shared/ imports Drizzle ORM — this is intentional, not a violation.
// The schema definitions (sqliteTable, pgTable, text, integer, etc.) ARE
// Drizzle builders; you cannot define a Drizzle schema without importing
// Drizzle. The alternative (defining schemas as plain objects and wrapping
// them in Drizzle at the server boundary) would duplicate every table
// definition and lose type inference ($inferSelect, $inferInsert).
//
// What shared/ should NOT do is import server-only or client-only code.
// Drizzle is a shared dependency used by both server (queries) and client
// (type inference via $inferSelect). The imports below are limited to:
//   - drizzle-orm (sql expression builder)
//   - drizzle-orm/sqlite-core (table/column builders)
//   - drizzle-zod (Zod schema generation from Drizzle schema)
// No runtime Drizzle query execution happens in shared/.
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { relations, sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  check,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';
extendZodWithOpenApi(z);
import type { FrameworkExecutionResult } from './framework-types';
import {
  demandTypeSchema,
  prioritySchema,
  type DemandPriority,
  type DemandType,
} from './demand-types';
export type { DemandType, DemandPriority } from './demand-types';

// Tipos de refinamento disponíveis
export type RefinementType = 'technical' | 'business' | null;

// Domínios de negócio
// M-3: domínios são dinamicamente configuráveis via domains.json. O schema
// aceita qualquer string; a validação de domínios especializados fica no RAG.
// Domínios descontinuados: mapeados para 'padrao' (back-compat com demandas e
// entradas antigas). `fintech_cambio` (comex/câmbio) foi removido — o app não é
// mais focado em Comércio Exterior/Câmbio.
const RETIRED_DOMAINS = new Set(['fintech_cambio']);
export const demandDomainSchema = z.preprocess((val) => {
  let first: string | undefined;
  if (Array.isArray(val)) {
    first = val.map((s) => String(s).toLowerCase().trim())[0] || 'padrao';
  } else if (typeof val === 'string') {
    first = val.toLowerCase().split(',')[0]?.trim() || 'padrao';
  } else {
    return val;
  }
  return RETIRED_DOMAINS.has(first) ? 'padrao' : first;
}, z.string());
export type DemandDomain = string;

// Generic validation schemas for routes
export const paramIdSchema = z.object({
  id: z.coerce.number().positive('ID must be a positive number').openapi({
    example: 1,
    description: 'ID numérico único',
  }),
});

// Document Editor (MVP) - per-document version metadata (content stays on disk)
export interface DocumentVersionInfo {
  version: number; // monotonic counter, starts at 1
  hash: string; // sha256 of current content (fingerprint)
  updatedAt: string; // ISO timestamp
  previousVersion?: number; // for "revert to last saved" (1-back history)
  previousHash?: string;
  previousContent?: string; // inline content of previous version (1-back only)
}

export type DocumentType = 'prd' | 'tasks' | 'tdd';

export type DocumentVersionsMap = Partial<Record<DocumentType, DocumentVersionInfo>>;

export const demands = sqliteTable('demands', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  type: text('type').$type<DemandType>().notNull(), // 'nova_funcionalidade', 'melhoria', 'bug', 'discovery', 'analise_exploratoria'
  priority: text('priority').$type<DemandPriority>().notNull(), // 'baixa', 'media', 'alta', 'critica'
  refinementType: text('refinement_type').$type<RefinementType>(), // 'technical', 'business', or null for legacy
  status: text('status').notNull().default('processing'), // 'processing', 'completed', 'error', 'stopped'
  progress: integer('progress').notNull().default(0), // Progress percentage 0-100
  chatMessages: text('chat_messages', { mode: 'json' }).$type<ChatMessage[]>().default([]),
  prdUrl: text('prd_url'),
  tddUrl: text('tdd_url'),
  tasksUrl: text('tasks_url'),
  domain: text('domain').$type<DemandDomain>().default('padrao'),
  classification: text('classification', { mode: 'json' }).$type<any>(), // Cognitive Core classification
  orchestration: text('orchestration', { mode: 'json' }).$type<any>(), // Cognitive Core orchestration
  currentAgent: text('current_agent'), // Current agent being executed
  errorMessage: text('error_message'), // Error message if any
  validationNotes: text('validation_notes'), // Validation notes
  typeAdherence: text('type_adherence', { mode: 'json' }).$type<TypeAdherenceResult>(), // Type contract validation result
  completedAt: integer('completed_at', { mode: 'timestamp' }), // When demand was completed

  // Governance fields (Human Review)
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).default(false),
  requiresHumanReview: integer('requires_human_review', { mode: 'boolean' }).default(false),
  documentState: text('document_state', {
    enum: ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'FINAL', 'APPROVAL_REQUIRED'],
  }).default('DRAFT'),
  reviewSnapshotId: text('review_snapshot_id'),
  approvedSnapshotId: text('approved_snapshot_id'),
  approvedSnapshotHash: text('approved_snapshot_hash'),
  finalSnapshotId: text('final_snapshot_id'),
  finalizedFromHash: text('finalized_from_hash'),
  approvalSessionId: text('approval_session_id'),
  revisionNumber: integer('revision_number').notNull().default(0),
  reviewRequestedAt: integer('review_requested_at', { mode: 'timestamp' }),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
  approvedBy: text('approved_by'),
  rejectedAt: integer('rejected_at', { mode: 'timestamp' }),
  rejectionReason: text('rejection_reason'),
  returnedToDraftAt: integer('returned_to_draft_at', { mode: 'timestamp' }),

  // Advanced Governance & Gating
  sectionChecklist: text('section_checklist', { mode: 'json' })
    .$type<Record<string, boolean>>()
    .default({}),
  refinementInteractions: text('refinement_interactions', { mode: 'json' })
    .$type<RefinementInteraction[]>()
    .default([]),
  coverageAnalysis: text('coverage_analysis', { mode: 'json' }).$type<CoverageAnalysisResult>(),
  learningLog: text('learning_log', { mode: 'json' }).$type<string[]>().default([]),
  // Demanda 10089 (item 4): evidência textual de 1 cenário negativo no fechamento.
  qaEvidence: text('qa_evidence'),
  // Demanda 10089 (item 5): classificação de esforço P/M/G na entrada do refinamento.
  size: text('size', { enum: ['P', 'M', 'G'] }).$type<'P' | 'M' | 'G'>(),
  overrideJustification: text('override_justification'),
  overrideBy: text('override_by'),

  // Performance & Cost Telemetry
  runId: text('run_id'),
  qualityGateStatus: text('quality_gate_status', { enum: ['passed', 'failed', 'warning'] }),
  finalDocHash: text('final_doc_hash'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  custoEstimado: real('custo_estimado').notNull().default(0),

  // Document Editor (MVP) - versioning metadata for editable documents (PRD/Tasks)
  documentVersions: text('document_versions', { mode: 'json' })
    .$type<DocumentVersionsMap>()
    .default({}),

  // Anti-overengineering: PO/TL pode elevar o teto de esforço aprovado
  maxEffortOverrideDias: real('max_effort_override_dias'),
  maxEffortOverrideBy: text('max_effort_override_by'),
  maxEffortOverrideJustification: text('max_effort_override_justification'),

  // Departmentalização do RAG: chave canônica do repositório vinculado à demanda
  // (formato "owner/name"). Quando presente, RAG e contexto filtram artefatos
  // pertencentes apenas a esse repositório, evitando vazamento de informação
  // entre iniciativas. Permanece nullable para permitir demandas sem repo
  // (ex.: discovery puro) e backfill incremental do histórico.
  repoFullName: text('repo_full_name'),

  // Skill externa: URL raw (GitHub) opcional de uma skill a ser injetada no
  // contexto do refinamento. O conteúdo é buscado em tempo de criação e
  // anexado à descrição da demanda antes de ser enviado aos agentes.
  // BAIXO-01: a propriedade foi renomeada para refletir o contrato real (o
  // fetcher só aceita raw.githubusercontent.com), mas a COLUNA segue
  // `skill_sh_url`. Renomear a coluna exigiria migration em banco real por um
  // problema de nomenclatura — o Drizzle desacopla propriedade de coluna
  // justamente para isso. Se um dia houver migration por outro motivo, aproveite.
  skillRawUrl: text('skill_sh_url'),

  // CRIT-16: descrição original do usuário antes do enriquecimento (repo
  // context, demand start contract, skill externa). `description` é mutável e
  // recebe a versão composta que os agentes consomem; este campo preserva
  // o input exato do usuário para auditoria, display e comparação.
  originalDescription: text('original_description'),

  // Mesa Redonda (PRD #5)
  roundtableConfig: text('roundtable_config', { mode: 'json' })
    .$type<{
      agentIds: string[];
      maxRounds: number;
      currentRound?: number;
      /** Demanda 10081 parte A: justificativa da triagem dinâmica, quando usada. */
      triageReasoning?: string;
    }>()
    .default({ agentIds: [], maxRounds: 3 }),
  roundtableSummary: text('roundtable_summary', { mode: 'json' }).$type<{
    totalRounds: number;
    divergences: number;
    agentContributions: Record<string, number>;
    consolidation?: string;
    /** Demanda 10081 parte B: agentes acionados no meio do refinamento. */
    escalations?: Array<{ agent: string; round: number; reason: string }>;
  }>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  // Optional fields used by some routes (matching schema-pg.ts extension type)
  executionId: text('execution_id'),
  executionConfig: text('execution_config', { mode: 'json' }),
  qualityPassed: integer('quality_passed', { mode: 'boolean' }),
  missingSections: text('missing_sections', { mode: 'json' }),
  fallbackUsed: integer('fallback_used', { mode: 'boolean' }).default(false),
  fallbackReason: text('fallback_reason'),
  // Spec 10015: modo go-live (fast-track) opt-in por demanda. Quando true, o
  // pipeline pula etapas NÃO críticas (RAG quality, content guardrails), mantendo
  // as críticas (schema, auth, erros de API). Ver server/services/ai-squad/evaluation-gate.ts.
  goLiveMode: integer('go_live_mode', { mode: 'boolean' }).default(false),

  // Demanda 10196: rastreamento de origem Discovery → Refinement.
  origin: text('origin'),
  originMetadata: text('origin_metadata', { mode: 'json' })
    .$type<{
      frameworkName?: string;
      frameworkId?: string;
      sessionId?: string;
    }>()
    .default({}),

  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Document Snapshots - Immutable versions for review/approval
export const documentSnapshots = sqliteTable(
  'document_snapshots',
  {
    snapshotId: text('snapshot_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id),
    snapshotType: text('snapshot_type', { enum: ['REVIEW', 'APPROVED'] }).notNull(),
    payloadJson: text('payload_json').notNull(), // Immutable rendered content
    snapshotHash: text('snapshot_hash').notNull(), // Deterministic hash
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_document_snapshots_demand_id').on(table.demandId),
  }),
);

// Approval Comments - Feedback linked to snapshots
export const approvalComments = sqliteTable(
  'approval_comments',
  {
    commentId: integer('comment_id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id),
    reviewSnapshotId: text('review_snapshot_id'),
    approvedSnapshotId: text('approved_snapshot_id'),
    author: text('author'),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_approval_comments_demand_id').on(table.demandId),
  }),
);

// Document Lifecycle Events - Metrics and audit trail
export const documentLifecycleEvents = sqliteTable(
  'document_lifecycle_events',
  {
    eventId: integer('event_id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id),
    requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull(),
    approvalSessionId: text('approval_session_id'),
    eventType: text('event_type', {
      enum: [
        'DRAFT_TO_APPROVAL_REQUIRED',
        'APPROVAL_REQUIRED_TO_APPROVED',
        'APPROVED_TO_FINAL',
        'DRAFT_TO_UNDER_REVIEW',
        'UNDER_REVIEW_TO_APPROVED',
        'UNDER_REVIEW_TO_DRAFT',
        'APPROVE_ATTEMPT',
        'FINALIZE_ATTEMPT',
        'SNAPSHOT_OUTDATED',
        'FINALIZE_PAYLOAD_REJECTED',
        'APPROVED',
        'REJECTED',
      ],
    }).notNull(),
    reviewSnapshotId: text('review_snapshot_id'),
    approvedSnapshotId: text('approved_snapshot_id'),
    finalSnapshotId: text('final_snapshot_id'),
    finalizedFromHash: text('finalized_from_hash'),
    resultCode: text('result_code'), // SUCCESS, ERROR, REJECTED
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_document_lifecycle_events_demand_id').on(table.demandId),
  }),
);

export const operationAttempts = sqliteTable(
  'operation_attempts',
  {
    attemptId: text('attempt_id').primaryKey(),
    operationId: text('operation_id').notNull(),
    operationType: text('operation_type').notNull(),
    demandId: integer('demand_id').references(() => demands.id),
    status: text('status', {
      enum: ['blocked', 'processing', 'completed', 'error'],
    }).notNull(),
    gateStatus: text('gate_status', {
      enum: ['ready', 'blocked'],
    }).notNull(),
    missingFields: text('missing_fields', { mode: 'json' }).$type<string[]>().notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => ({
    demandIdx: index('idx_operation_attempts_demand_id').on(table.demandId),
  }),
);

export const modelRoutingStageRuns = sqliteTable(
  'model_routing_stage_runs',
  {
    runId: text('run_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    executionId: text('execution_id'),
    stageName: text('stage_name').notNull(),
    modelUsed: text('model_used').notNull(),
    attemptIndex: integer('attempt_index').notNull(),
    status: text('status', {
      enum: ['processing', 'completed', 'failed', 'fallback_triggered', 'failed_after_retries'],
    }).notNull(),
    validationPassed: integer('validation_passed', { mode: 'boolean' }),
    validationErrorsCount: integer('validation_errors_count'),
    qaPassed: integer('qa_passed', { mode: 'boolean' }),
    qaBlockersCount: integer('qa_blockers_count'),
    failureReason: text('failure_reason', {
      enum: [
        'schema_failed',
        'schema_parse_failed',
        'validation_failed',
        'qa_failed_critical',
        'budget_exhausted',
      ],
    }),
    finalArtifactAccepted: integer('final_artifact_accepted', { mode: 'boolean' }),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_model_routing_stage_runs_demand_id').on(table.demandId),
  }),
);

// Decision Contract — campos mínimos de contexto
export interface RefinementDecisionContext {
  demandType: string;
  taskType: 'tech_task' | 'defined_bug' | 'discovery' | 'unknown';
  problemDefined: boolean | null;
  uiImpactKnown: boolean | 'unknown';
  acceptanceScope: 'technical' | 'business' | 'mixed' | 'unknown';
  confidence: 'high' | 'low';
}

export interface RouterDecision {
  proposedIncludeAgents: string[];
  proposedOmitAgents: string[];
  actualIncludeAgents: string[];
  actualOmitAgents: string[];
  reasonCodes: string[];
  fallbackUsed: boolean;
  shadowMode: boolean;
  decisionLatencyMs: number;
}

export const agentDecisionRecords = sqliteTable(
  'agent_decision_records',
  {
    runId: text('run_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    executionId: text('execution_id'),
    demandType: text('demand_type').notNull(),
    taskType: text('task_type').notNull(),
    problemDefined: integer('problem_defined', { mode: 'boolean' }),
    uiImpactKnown: text('ui_impact_known'), // string para suportar "unknown"
    acceptanceScope: text('acceptance_scope').notNull(),
    confidence: text('confidence').notNull(),
    proposedIncludeAgents: text('proposed_include_agents', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    proposedOmitAgents: text('proposed_omit_agents', { mode: 'json' }).$type<string[]>().notNull(),
    actualIncludeAgents: text('actual_include_agents', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    actualOmitAgents: text('actual_omit_agents', { mode: 'json' }).$type<string[]>().notNull(),
    reasonCodes: text('reason_codes', { mode: 'json' }).$type<string[]>().notNull(),
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull(),
    shadowMode: integer('shadow_mode', { mode: 'boolean' }).notNull(),
    decisionLatencyMs: integer('decision_latency_ms').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_agent_decision_records_demand_id').on(table.demandId),
  }),
);

export const domainExecutionRecords = sqliteTable(
  'domain_execution_records',
  {
    executionId: text('execution_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    domainTriggered: integer('domain_triggered', { mode: 'boolean' }).notNull(),
    domainUsableReturned: integer('domain_usable_returned', { mode: 'boolean' }).notNull(),
    domainUsedInFinal: integer('domain_used_in_final', { mode: 'boolean' }).notNull(),
    outputSource: text('output_source').notNull(),
    fallbackOrReprocess: integer('fallback_or_reprocess', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_domain_execution_records_demand_id').on(table.demandId),
  }),
);

export const progressiveRefinementRecords = sqliteTable(
  'progressive_refinement_records',
  {
    executionId: text('execution_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),

    // Triage info
    complexity: text('complexity').notNull(),
    impact: text('impact').notNull(),
    risk: text('risk').notNull(),
    levelTriaged: integer('level_triaged').notNull(),
    triageConfidence: integer('triage_confidence').notNull().default(100),
    triageReasonCodes: text('triage_reason_codes', { mode: 'json' }).$type<string[]>().default([]),

    // Level enforcement & Execution
    levelExecuted: integer('level_executed').notNull(),
    wasDowngraded: integer('was_downgraded', { mode: 'boolean' }).notNull().default(false),
    agentsUsed: text('agents_used', { mode: 'json' }).$type<string[]>().notNull(),
    modelUsed: text('model_used').notNull(),
    callsCountByStage: text('calls_count_by_stage', { mode: 'json' })
      .$type<Record<string, number>>()
      .default({}),
    contextBudgetProxyByStage: text('context_budget_proxy_by_stage', { mode: 'json' })
      .$type<Record<string, number>>()
      .default({}),

    // Cost tracking
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costEstimated: real('cost_estimated').notNull().default(0.0),
    costReal: real('cost_real').notNull().default(0.0),

    // Flags & Quality
    reworkFlag: integer('rework_flag', { mode: 'boolean' }).notNull().default(false),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    incomplete: integer('incomplete', { mode: 'boolean' }).notNull().default(false),
    artifactValidation: integer('artifact_validation', { mode: 'boolean' }).notNull().default(true),
    gateStatus: text('gate_status').notNull(),
    endedReason: text('ended_reason').notNull().default('completed_successfully'),

    // Policy & Experiment Tracking
    experimentBucket: text('experiment_bucket').notNull().default('baseline'),
    triagePolicyVersion: text('triage_policy_version').notNull().default('1.0.0'),
    executionPolicyVersion: text('execution_policy_version').notNull().default('1.0.0'),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_progressive_refinement_records_demand_id').on(table.demandId),
  }),
);

// ============================================================================
// Orchestration Runtime Persistence (trilha de auditoria multiagente)
// Registra cada execução (run), turno de agente, tool call e evento de ciclo
// de vida da orquestração, com campos de conformidade regulatória.
// ============================================================================

export const ORCHESTRATION_RUN_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const;
export type OrchestrationRunStatus = (typeof ORCHESTRATION_RUN_STATUSES)[number];

export const AGENT_TURN_STATUSES = ['running', 'completed', 'failed'] as const;
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];

export const ORCHESTRATION_EVENT_TYPES = [
  'ORCHESTRATION_STARTED',
  'AGENT_STARTED',
  'AGENT_COMPLETED',
  'AGENT_FAILED',
  'TOOL_CALL_COMPLETED',
  'TOOL_CALL_FAILED',
  'ROUNDTABLE_DIVERGENCE_RECORDED',
  'ORCHESTRATION_COMPLETED',
  'ORCHESTRATION_FAILED',
] as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

export const orchestrationRuns = sqliteTable(
  'orchestration_runs',
  {
    runId: text('run_id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    pipelineId: text('pipeline_id'),
    mode: text('mode').notNull().default('roundtable'),
    status: text('status', { enum: ORCHESTRATION_RUN_STATUSES }).notNull(),
    agentOrder: text('agent_order', { mode: 'json' }).$type<string[]>(),
    errorMessage: text('error_message'),
    // Conformidade regulatória (obrigatório)
    regulatoryContext: text('regulatory_context'),
    sensitivityLevel: text('sensitivity_level'),
    normaReferencia: text('norma_referencia'),
    // Token / custo (nullable)
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costEstimated: real('cost_estimated'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => ({
    demandIdx: index('idx_orchestration_runs_demand_id').on(table.demandId),
  }),
);

export const agentTurns = sqliteTable(
  'agent_turns',
  {
    turnId: text('turn_id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => orchestrationRuns.runId, { onDelete: 'cascade' }),
    demandId: integer('demand_id').notNull(),
    agentName: text('agent_name').notNull(),
    turnIndex: integer('turn_index').notNull(),
    status: text('status', { enum: AGENT_TURN_STATUSES }).notNull(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costEstimated: real('cost_estimated'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => ({
    demandIdx: index('idx_agent_turns_demand_id').on(table.demandId),
    runIdx: index('idx_agent_turns_run_id').on(table.runId),
  }),
);

export const agentToolCalls = sqliteTable(
  'agent_tool_calls',
  {
    toolCallId: text('tool_call_id').primaryKey(),
    turnId: text('turn_id')
      .notNull()
      .references(() => agentTurns.turnId, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    toolName: text('tool_name').notNull(),
    status: text('status', { enum: AGENT_TURN_STATUSES }).notNull(),
    argsJson: text('args_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    resultJson: text('result_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    turnIdx: index('idx_agent_tool_calls_turn_id').on(table.turnId),
  }),
);

export const orchestrationEvents = sqliteTable(
  'orchestration_events',
  {
    eventId: text('event_id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => orchestrationRuns.runId, { onDelete: 'cascade' }),
    demandId: integer('demand_id').notNull(),
    eventType: text('event_type', { enum: ORCHESTRATION_EVENT_TYPES }).notNull(),
    agentName: text('agent_name'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_orchestration_events_demand_id').on(table.demandId),
    runIdx: index('idx_orchestration_events_run_id').on(table.runId),
  }),
);

export type OrchestrationRun = typeof orchestrationRuns.$inferSelect;
export type InsertOrchestrationRun = typeof orchestrationRuns.$inferInsert;
export type AgentTurn = typeof agentTurns.$inferSelect;
export type InsertAgentTurn = typeof agentTurns.$inferInsert;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type InsertAgentToolCall = typeof agentToolCalls.$inferInsert;
export type OrchestrationEventRecord = typeof orchestrationEvents.$inferSelect;
export type InsertOrchestrationEventRecord = typeof orchestrationEvents.$inferInsert;

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  fullName: text('full_name').notNull().unique(),
  description: text('description'),
  url: text('url').notNull(),
  cloneUrl: text('clone_url'),
  sshUrl: text('ssh_url'),
  htmlUrl: text('html_url'),
  defaultBranch: text('default_branch'),
  language: text('language'),
  size: integer('size'), // Size in KB
  stars: integer('stars').default(0),
  forks: integer('forks').default(0),
  isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
  isFork: integer('is_fork', { mode: 'boolean' }).default(false),
  indexedContent: text('indexed_content'),
  indexedAt: integer('indexed_at', { mode: 'timestamp' }),
  briefing: text('briefing'),
  briefingGeneratedAt: integer('briefing_generated_at', { mode: 'timestamp' }),
  systemMap: text('system_map'),
  systemMapGeneratedAt: integer('system_map_generated_at', { mode: 'timestamp' }),
  lastCommit: text('last_commit'),
  lastCommitDate: integer('last_commit_date', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const repoFiles = sqliteTable(
  'repo_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    filename: text('filename').notNull(),
    content: text('content'),
    language: text('language'),
    size: integer('size'), // Size in bytes
    sha: text('sha'),
    url: text('url'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    repoIdx: index('idx_repo_files_repo_id').on(table.repoId),
  }),
);

export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id').references(() => demands.id),
    filename: text('filename').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_files_demand_id').on(table.demandId),
  }),
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
});

export const telemetry = sqliteTable(
  'telemetry',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    demandId: integer('demand_id').references(() => demands.id),
    agentName: text('agent_name'),
    operation: text('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    status: text('status').notNull(), // success, failed, error
    retryAttempt: integer('retry_attempt').notNull().default(0),
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull().default(false),
    timestamp: integer('timestamp', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_telemetry_demand_id').on(table.demandId),
  }),
);

// Human feedback on agent messages
export const humanFeedback = sqliteTable(
  'human_feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id').notNull(),
    agentMessageId: text('agent_message_id').notNull(),
    feedbackText: text('feedback_text').notNull().default(''),
    feedbackType: text('feedback_type', { enum: ['like', 'dislike'] }).notNull(),
    agent: text('agent'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_human_feedback_demand_id').on(table.demandId),
  }),
);

export type HumanFeedback = typeof humanFeedback.$inferSelect;
export type InsertHumanFeedback = typeof humanFeedback.$inferInsert;

export const REFINEMENT_ITEM_FEEDBACK_STATUSES = ['feito', 'não_feito', 'desatualizado'] as const;
export type RefinementItemFeedbackStatus = (typeof REFINEMENT_ITEM_FEEDBACK_STATUSES)[number];

// Structured refinement feedback. Legacy satisfaction feedback (nota 1-5) and
// operational item status coexist, but either dimension may be submitted alone.
export const feedbackRefinamento = sqliteTable(
  'feedback_refinamento',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    refinementId: text('refinement_id').notNull(),
    agentId: text('agent_id').notNull(),
    nota: integer('nota'),
    texto: text('texto'),
    modelo: text('modelo'),
    qtdIteracoesAteFeedback: integer('qtd_iteracoes_ate_feedback'),
    itemIndex: integer('item_index'),
    itemKey: text('item_key'),
    versionHash: text('version_hash'),
    status: text('status', { enum: REFINEMENT_ITEM_FEEDBACK_STATUSES }),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    atualizadoEm: integer('atualizado_em', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    itemVersionUnique: uniqueIndex('idx_feedback_refinamento_item_version').on(
      table.refinementId,
      table.versionHash,
      table.itemKey,
    ),
    statusCheck: check(
      'feedback_refinamento_status_check',
      sql`${table.status} IS NULL OR ${table.status} IN ('feito', 'não_feito', 'desatualizado')`,
    ),
    notaCheck: check(
      'feedback_refinamento_nota_check',
      sql`${table.nota} IS NULL OR (${table.nota} >= 1 AND ${table.nota} <= 5)`,
    ),
  }),
);

export type FeedbackRefinamento = typeof feedbackRefinamento.$inferSelect;
export type InsertFeedbackRefinamento = typeof feedbackRefinamento.$inferInsert;

// Anti-Overengineering Agent: parecer estruturado + impacto de esforço por demanda
export const agentInterventions = sqliteTable(
  'agent_interventions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    pontosOverengineering: text('pontos_overengineering', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    escopoReduzido: text('escopo_reduzido').notNull(),
    roiEstimado: text('roi_estimado').notNull(),
    esforcoOriginalDias: real('esforco_original_dias'),
    esforcoReduzidoDias: real('esforco_reduzido_dias'),
    overrideApplied: integer('override_applied', { mode: 'boolean' }).notNull().default(false),
    overrideBy: text('override_by'),
    overrideJustification: text('override_justification'),
    modelo: text('modelo'),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_agent_interventions_demand_id').on(table.demandId),
  }),
);

export type AgentIntervention = typeof agentInterventions.$inferSelect;
export type InsertAgentIntervention = typeof agentInterventions.$inferInsert;

export type MessageCategory = 'question' | 'answer' | 'alert' | 'error' | 'system';

export interface RefinementInteraction {
  id: string;
  section: string;
  itemKey: string;
  action: 'PROPOSE' | 'ACCEPT' | 'REJECT';
  justification: string;
  author: string;
  timestamp: string;
  originalValue?: string;
  proposedValue?: string;

  // Interactive refinement (MVP polling) - optional fields, additive
  kind?: 'question' | 'answer' | 'pause' | 'resume' | 'suggestion';
  sequence?: number;
  status?: 'pending' | 'answered' | 'expired' | 'cancelled';
  question?: string;
  options?: string[];
  answer?: string;
  reason?: string;
  contextVersion?: number;
  suggestionType?: 'context' | 'correction' | 'enhancement';
}

export const refinementInteractionInputSchema = z.object({
  section: z.string().min(1),
  itemKey: z.string().min(1),
  action: z.enum(['PROPOSE', 'ACCEPT', 'REJECT']),
  justification: z.string().min(1),
  originalValue: z.string().optional(),
  proposedValue: z.string().optional(),
});

export type RefinementInteractionInput = z.infer<typeof refinementInteractionInputSchema>;

export interface RefinementSuggestion {
  id: string;
  text: string;
  type: 'context' | 'correction' | 'enhancement';
  contextVersion: number;
}

export interface ActiveInteraction {
  interactionId: string;
  question: string;
  options?: string[];
  createdAt: string;
}

export interface RefinementStatusResponse {
  refinementId: string;
  status: 'ACTIVE' | 'PAUSED';
  sequence: number;
  pausedAt: string | null;
  activeInteraction: ActiveInteraction | null;
  suggestions: RefinementSuggestion[];
  history: Array<{
    interactionId: string;
    sequence: number;
    kind: string;
    question?: string;
    answer?: string;
    timestamp: string;
  }>;
}

// Answer Flow MVP contract (PRD - Modo Conversacional Interativo)
// Reference: docs/answer-flow-mvp.md
export type AnswerFlowState = 'IDLE' | 'RUNNING' | 'AWAITING_USER_INPUT' | 'COMPLETED' | 'FAILED';

export interface CurrentQuestion {
  questionId: string;
  questionText: string;
  agentStep?: string;
  options?: string[];
  emittedAt: string;
}

export interface AnswerFlowStatusResponse {
  refinementId: string;
  state: AnswerFlowState;
  awaitingToken: number | null;
  currentQuestion: CurrentQuestion | null;
  history: Array<{
    questionId: string;
    awaitingToken: number;
    questionText?: string;
    answer?: string;
    timestamp: string;
  }>;
}

export interface CoverageAnalysisResult {
  omittedItems: {
    category: string;
    item: string;
    criticality: 'HIGH' | 'MEDIUM' | 'LOW';
  }[];
  score: number;
  analyzedAt: string;
}

// Contrato de tipo para refinamentos
export interface TypeContract {
  type: RefinementType;
  requiredSections: string[];
  minSectionsRequired: number;
  description: string;
}

// Contratos de tipo definidos
export const TYPE_CONTRACTS: Record<'technical' | 'business', TypeContract> = {
  technical: {
    type: 'technical',
    requiredSections: [
      'visão geral',
      'arquitetura',
      'modelo de dados',
      'definição de apis',
      'fluxo de sequência',
      'performance e segurança',
      'rollout e monitoramento',
      'alternativas consideradas',
    ],
    minSectionsRequired: 2,
    description:
      'Refinamento técnico: foco em arquitetura, modelo de dados, contratos de APIs e fluxo de sequência',
  },
  business: {
    type: 'business',
    requiredSections: [
      'objetivo',
      'benefício',
      'valor',
      'impacto',
      'prioridade',
      'roi',
      'métrica',
      'usuário',
      'problema',
      'resultado',
    ],
    minSectionsRequired: 2,
    description: 'Refinamento de negócios: foco em objetivo, valor, impacto e prioridade',
  },
};

// Resultado da validação de aderência ao tipo
export interface TypeAdherenceResult {
  isAdherent: boolean;
  type: RefinementType;
  sectionsFound: string[];
  sectionsRequired: number;
  sectionsMet: number;
  score: number; // 0-100
  feedback: string;
}

export type SourceType = 'direct_read' | 'fallback_rag' | 'blocked';

export interface RepoContext {
  owner: string;
  repo: string;
  branch: string;
  commitSha?: string;
}

export interface EvidenceBlock {
  sourceType: SourceType;
  repoContext: RepoContext;
  evidenceFiles: string[];
  evidenceNotes?: string;
}

export type ChatMessage = {
  id: string;
  agent: string;
  message: string;
  thinking?: string; // Optional field for agent's inner monologue/reasoning
  timestamp: string;
  type: 'processing' | 'completed' | 'error' | 'inputrequired';
  category?: MessageCategory; // Visual category for message styling
  progress?: number; // Progress percentage 0-100
  metadata?: Record<string, unknown> & {
    evidence?: EvidenceBlock;
  };
};

// Schema específico para criação de demanda via API
// Só aceita campos que o cliente pode definir
export const insertDemandSchema = createInsertSchema(demands)
  .pick({
    title: true,
    description: true,
    type: true,
    priority: true,
    refinementType: true,
    requiresApproval: true,
    requiresHumanReview: true,
    roundtableConfig: true,
    goLiveMode: true,
    size: true,
    origin: true,
    originMetadata: true,
  })
  .extend({
    title: z.string().trim().min(1, 'Título é obrigatório'),
    description: z.string().trim().min(1, 'Descrição é obrigatória'),
    type: demandTypeSchema,
    priority: prioritySchema,
    domain: demandDomainSchema.default('padrao').optional(),
    // Spec 10015: aceita boolean (JSON) ou 'true'/'false' (multipart FormData).
    goLiveMode: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
    // Demanda 10089 (item 5): classificação de esforço P/M/G na entrada do refinamento.
    size: z.enum(['P', 'M', 'G']).optional(),
    // Demanda 10196: origem Discovery → Refinement.
    origin: z.string().optional(),
    originMetadata: z
      .preprocess(
        (v) => (typeof v === 'string' ? JSON.parse(v) : v),
        z.object({
          frameworkName: z.string().optional(),
          frameworkId: z.string().optional(),
          sessionId: z.string().optional(),
        }),
      )
      .optional(),
  })
  // H-21: reject unknown fields in the request body instead of silently
  // ignoring them. Without .strict(), a typo in a field name (e.g., 'titel'
  // instead of 'title') is silently dropped, and the demand is created with
  // defaults — confusing for API consumers.
  .strict()
  .openapi({
    title: 'InsertDemand',
    description: 'Schema para criação de uma nova demanda',
  });

// Schema interno completo (para uso no servidor)
export const internalDemandSchema = createInsertSchema(demands).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertFileSchema = createInsertSchema(files).omit({
  id: true,
  createdAt: true,
});

export const insertRepoSchema = createInsertSchema(repos).omit({
  id: true,
  indexedAt: true,
  lastCommitDate: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRepoFileSchema = createInsertSchema(repoFiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

// =============================================================================
// Data Retention Policies (PRD - Políticas de Retenção de Dados)
// =============================================================================

export const retentionPolicyActionSchema = z.enum(['archive', 'delete']);
export type RetentionPolicyAction = z.infer<typeof retentionPolicyActionSchema>;

export const retentionDataTypeSchema = z.enum([
  'chat_messages',
  'telemetry',
  'document_snapshots',
  'approval_comments',
  'document_lifecycle_events',
  'human_feedback',
  'feedback_refinamento',
  'agent_interventions',
  'operation_attempts',
  'model_routing_stage_runs',
  'agent_decision_records',
  'progressive_refinement_records',
]);
export type RetentionDataType = z.infer<typeof retentionDataTypeSchema>;

export const retentionPolicies = sqliteTable('retention_policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dataType: text('data_type').$type<RetentionDataType>().notNull(),
  ttlDays: integer('ttl_days').notNull(),
  action: text('action', { enum: ['archive', 'delete'] })
    .$type<RetentionPolicyAction>()
    .notNull()
    .default('delete'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type InsertRetentionPolicy = typeof retentionPolicies.$inferInsert;

export const retentionJobStatusSchema = z.enum(['running', 'completed', 'failed']);
export type RetentionJobStatus = z.infer<typeof retentionJobStatusSchema>;

export const retentionJobLogs = sqliteTable(
  'retention_job_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id'),
    policyId: integer('policy_id')
      .notNull()
      .references(() => retentionPolicies.id, { onDelete: 'cascade' }),
    executionStartedAt: integer('execution_started_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    executionCompletedAt: integer('execution_completed_at', { mode: 'timestamp' }),
    status: text('status').$type<RetentionJobStatus>().notNull().default('running'),
    rowsAffected: integer('rows_affected').notNull().default(0),
    dbSizeBeforeMb: real('db_size_before_mb'),
    dbSizeAfterMb: real('db_size_after_mb'),
    errorMessage: text('error_message'),
    retryAttempt: integer('retry_attempt').notNull().default(0),
  },
  (table) => ({
    policyIdx: index('idx_retention_job_logs_policy_id').on(table.policyId),
  }),
);

export type RetentionJobLog = typeof retentionJobLogs.$inferSelect;
export type InsertRetentionJobLog = typeof retentionJobLogs.$inferInsert;

export const documentJobs = sqliteTable(
  'document_jobs',
  {
    jobId: text('job_id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    docType: text('doc_type').notNull(),
    targetFilepath: text('target_filepath').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    statusIdx: index('document_jobs_status_idx').on(table.status),
    demandDocTypeIdx: index('document_jobs_demand_idx').on(table.demandId, table.docType),
  }),
);

export const agentJobs = sqliteTable(
  'agent_jobs',
  {
    id: text('id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    speckitPath: text('speckit_path').notNull(),
    status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    promptSentHash: text('prompt_sent_hash').notNull(),
    // H-22: use { mode: 'json' } so Drizzle handles JSON.parse/stringify
    // automatically and the TypeScript type is string[] (not string).
    filesModified: text('files_modified', { mode: 'json' }).$type<string[]>().notNull().default([]),
    typecheckPassed: integer('typecheck_passed'),
    apiCostUsd: real('api_cost_usd'),
    humanEditsCount: integer('human_edits_count').notNull().default(0),
    cancelledAt: text('cancelled_at'),
    errorMessage: text('error_message'),
    steps: text('steps').notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('agent_jobs_demand_idx').on(table.demandId),
    statusIdx: index('agent_jobs_status_idx').on(table.status),
    updatedAtIdx: index('agent_jobs_updated_at_idx').on(table.updatedAt),
  }),
);

// Demanda 10078: registro de sessões de retrospectiva automatizada (SM +
// squad analisam demandas/repos de um período e sintetizam aprendizados).
export const retrospectiveSessions = sqliteTable(
  'retrospective_sessions',
  {
    id: text('id').primaryKey().notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    status: text('status').notNull().default('running'),
    summary: text('summary'),
    insights: text('insights').notNull().default('[]'),
    demandsAnalyzed: text('demands_analyzed').notNull().default('[]'),
    agentParticipants: text('agent_participants').notNull().default('[]'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    statusIdx: index('retrospective_sessions_status_idx').on(table.status),
  }),
);

export const codeAgentJobQueue = sqliteTable(
  'code_agent_job_queue',
  {
    id: text('id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    speckitPath: text('speckit_path').notNull(),
    prompt: text('prompt').notNull(),
    cwd: text('cwd'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    workerPid: integer('worker_pid'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    statusIdx: index('code_agent_job_queue_status_idx').on(table.status),
    demandIdx: index('idx_code_agent_job_queue_demand_id').on(table.demandId),
  }),
);

export const insertRetentionPolicySchema = createInsertSchema(retentionPolicies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// =============================================================================
// Refinement Executions (demanda 10025 — pipeline unificado)
// Trilha de auditoria por execução do refinamento (unified/sequential/
// roundtable): fallback, score de consenso, tokens, tempo, fases e artefato.
// =============================================================================

export const REFINEMENT_EXECUTION_METHODS = ['sequential', 'roundtable', 'unified'] as const;
export type RefinementExecutionMethod = (typeof REFINEMENT_EXECUTION_METHODS)[number];

export const refinementExecutions = sqliteTable(
  'refinement_executions',
  {
    id: text('id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    method: text('method', { enum: REFINEMENT_EXECUTION_METHODS }).notNull(),
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull().default(false),
    adapterFallback: integer('adapter_fallback', { mode: 'boolean' }).notNull().default(false),
    consensusScore: real('consensus_score'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    executionTimeMs: integer('execution_time_ms').notNull(),
    executionPhases: text('execution_phases', { mode: 'json' }).$type<Record<string, unknown>>(),
    artifactJson: text('artifact_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_refinement_executions_demand_id').on(table.demandId),
  }),
);

export type RefinementExecution = typeof refinementExecutions.$inferSelect;
export type InsertRefinementExecution = typeof refinementExecutions.$inferInsert;

// =============================================================================
// Refinements (demanda 10048 — persistência de dados de refinamentos para Grafana)
//
// Dados brutos de cada execução: prompt de entrada, resposta, modelo, tokens,
// temperatura e duração. Metadata armazenado como string JSON.
export const refinements = sqliteTable(
  'refinements',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    input: text('input').notNull(),
    output: text('output').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    sessionIdx: index('idx_refinements_session_id').on(table.sessionId),
    createdAtIdx: index('idx_refinements_created_at').on(table.createdAt),
  }),
);

export type Refinement = typeof refinements.$inferSelect;
export type InsertRefinement = typeof refinements.$inferInsert;

// =============================================================================
// Quality Scores (demanda 10093 Fase 2 — Quality Index)
//
// Persiste scores de groundedness, numeric-integrity e cited-path por demanda
// e documento (PRD/TSD), permitindo análise de qualidade real no dashboard.
// =============================================================================

export const qualityScores = sqliteTable(
  'quality_scores',
  {
    id: text('id').primaryKey(),
    demandId: integer('demand_id').notNull(),
    documentType: text('document_type', { enum: ['prd', 'tsd'] }).notNull(),
    groundednessScore: real('groundedness_score'),
    numericIntegrityScore: real('numeric_integrity_score'),
    citedPathScore: real('cited_path_score'),
    overallScore: real('overall_score'),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    demandIdx: index('idx_quality_scores_demand_id').on(table.demandId),
    documentTypeIdx: index('idx_quality_scores_document_type').on(table.documentType),
  }),
);

export type QualityScore = typeof qualityScores.$inferSelect;
export type InsertQualityScore = typeof qualityScores.$inferInsert;

// =============================================================================
// Artifacts (demanda 10037 — artefatos pós-refinamento)
//
// Guarda o TEXTO-FONTE do artefato (ex.: diagrama Mermaid), não o binário
// renderizado: por ADR-0002 a renderização acontece no cliente. `source` é
// texto curto (~1 KB) e já vem com PII mascarada pelo gerador.
// =============================================================================

export const ARTIFACT_TYPES = ['flowchart'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    demandId: integer('demand_id')
      .notNull()
      .references(() => demands.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ARTIFACT_TYPES }).notNull(),
    source: text('source').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    demandIdx: index('idx_artifacts_demand_id').on(table.demandId),
  }),
);

export type Artifact = typeof artifacts.$inferSelect;
export type InsertArtifact = typeof artifacts.$inferInsert;

// =============================================================================

export type InsertDemand = z.infer<typeof insertDemandSchema>;
export type InsertFile = z.infer<typeof insertFileSchema>;
export type InsertRepo = z.infer<typeof insertRepoSchema>;
export type InsertRepoFile = z.infer<typeof insertRepoFileSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;

/**
 * H-19: Wire-safe demand type for client/server boundary.
 *
 * Drizzle's `integer('...', { mode: 'timestamp' })` makes the TypeScript type
 * `Date`, but when serialized to JSON (res.json, JSON.stringify), Date becomes
 * an ISO string (Postgres) or epoch number (SQLite). The `Demand` type above
 * inherits `Date` from Drizzle, which is a type lie on the wire.
 *
 * `WireDemand` is the correct type for demand objects that have crossed the
 * JSON serialization boundary (REST responses, SSE events). It replaces
 * `Date` with `string | number` for all timestamp fields.
 *
 * Server-side code that reads from the DB gets `Date` objects (correct).
 * Client-side code that receives JSON should use `WireDemand` (correct).
 */
export type WireDemand = Omit<
  typeof demands.$inferSelect,
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'reviewRequestedAt'
  | 'approvedAt'
  | 'rejectedAt'
  | 'returnedToDraftAt'
> & {
  createdAt: string | number;
  updatedAt: string | number;
  completedAt: string | number | null;
  reviewRequestedAt: string | number | null;
  approvedAt: string | number | null;
  rejectedAt: string | number | null;
  returnedToDraftAt: string | number | null;
};

export type Demand = typeof demands.$inferSelect & {
  // CRIT-15/C-17: tipado com a interface compartilhada em shared/framework-types,
  // evitando `any`/`unknown` e mantendo a fronteira shared ↔ client/server intacta.
  frameworkExecution?: FrameworkExecutionResult;
  domain?: DemandDomain;
  executionId?: string | null;
  executionConfig?: Record<string, unknown> | null;
  qualityPassed?: boolean | null;
  // H-20: qualityScore was a phantom field — it existed in the Demand type
  // but had no corresponding database column. The actual quality score lives
  // inside frameworkExecution (FrameworkExecutionResult.qualityScore). Removed
  // from the Demand type to avoid confusing consumers.
  missingSections?: string[] | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
};
export type Repo = typeof repos.$inferSelect;
export type RepoFile = typeof repoFiles.$inferSelect;
export type File = typeof files.$inferSelect;
export type User = typeof users.$inferSelect;

// ==========================================
// Zod Schemas for API Payloads (Refatoração AI)
// ==========================================

export const feedbackPayloadSchema = z.object({
  demandId: z.number().int().optional(),
  agentMessageId: z.string().min(1, 'agentMessageId é obrigatório.'),
  feedbackType: z.enum(['like', 'dislike']),
  feedbackText: z.string().max(500, 'feedbackText deve ter no máximo 500 caracteres.').optional(),
  agent: z.string().optional(),
});

export const classifyVaguenessPayloadSchema = z.object({
  title: z.string().min(1, 'title is required'),
  description: z.string().min(1, 'description is required'),
});

// ==========================================
// Idempotency Records
// ==========================================

export const idempotencyRecords = sqliteTable('idempotency_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastSucceededDialect: text('last_succeeded_dialect', { enum: ['postgres', 'sqlite', 'unknown'] })
    .notNull()
    .default('unknown'), // Track which DB was last successfully used for reconciliation
});

// ==========================================
// Client Errors (React Error Instrumentation)
// ==========================================

export const clientErrorDataSourceSchema = z.enum(['gov_api', 'internal', 'ai_model', 'unknown']);
export type ClientErrorDataSource = z.infer<typeof clientErrorDataSourceSchema>;

export const clientErrors = sqliteTable('client_errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  sessionId: text('session_id').notNull(),
  component: text('component').notNull(),
  errorMessage: text('error_message').notNull(),
  stackTrace: text('stack_trace').default(''),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  dataSource: text('data_source').$type<ClientErrorDataSource>().notNull(),
  userAgent: text('user_agent').default(''),
  url: text('url').default(''),
});

export type ClientError = typeof clientErrors.$inferSelect;
export type InsertClientError = typeof clientErrors.$inferInsert;

// ==========================================
// Model Registry — dynamic model discovery & promotion
// ==========================================

export const MODEL_ALIAS_STATUSES = ['active', 'disabled', 'deprecated'] as const;
export type ModelAliasStatus = (typeof MODEL_ALIAS_STATUSES)[number];

export const MODEL_ALIAS_SOURCES = ['memory-cache', 'database', 'static-fallback'] as const;
export type ModelAliasSource = (typeof MODEL_ALIAS_SOURCES)[number];

export const modelAliases = sqliteTable('model_aliases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  alias: text('alias').notNull().unique(),
  family: text('family').notNull(),
  provider: text('provider').notNull(),
  activeModelId: text('active_model_id').notNull(),
  fallbackModelId: text('fallback_model_id'),
  status: text('status', { enum: MODEL_ALIAS_STATUSES }).notNull().default('active'),
  source: text('source', { enum: MODEL_ALIAS_SOURCES }).notNull().default('static-fallback'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  lastValidatedAt: integer('last_validated_at', { mode: 'timestamp' }),
  // MR-05: Persisted auto-rollback state. Failure counts and cooldown
  // timestamps live here so they survive process restarts. Without
  // persistence, a restart resets the counter and distributed failures
  // never reach the threshold.
  failureCount: integer('failure_count').notNull().default(0),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),
  lastRollbackAt: integer('last_rollback_at', { mode: 'timestamp' }),
});

export const MODEL_CANDIDATE_STATUSES = [
  'discovered',
  'validating',
  'validated',
  'validation_failed',
  'promoted',
  'rejected',
  'superseded',
] as const;
export type ModelCandidateStatus = (typeof MODEL_CANDIDATE_STATUSES)[number];

export const modelCandidates = sqliteTable(
  'model_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alias: text('alias').notNull(),
    family: text('family').notNull(),
    provider: text('provider').notNull(),
    currentModelId: text('current_model_id').notNull(),
    candidateModelId: text('candidate_model_id').notNull(),
    candidateVersion: text('candidate_version'),
    status: text('status', { enum: MODEL_CANDIDATE_STATUSES }).notNull().default('discovered'),
    selectionReason: text('selection_reason'),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default({}),
    discoveredAt: integer('discovered_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    validatedAt: integer('validated_at', { mode: 'timestamp' }),
    validationError: text('validation_error'),
  },
  (table) => ({
    // Enforced by migration 0026. Dedup of discovery cycles relies on this
    // DB-level guarantee rather than a read-then-write TOCTOU check.
    aliasCandidateUnique: uniqueIndex('idx_model_candidates_alias_candidate').on(
      table.alias,
      table.candidateModelId,
    ),
  }),
);

export const MODEL_HISTORY_ACTIONS = [
  'promoted',
  'rejected',
  'rolled_back',
  'auto_rolled_back',
  'invalidated',
  'seeded',
] as const;
export type ModelHistoryAction = (typeof MODEL_HISTORY_ACTIONS)[number];

export const modelHistory = sqliteTable('model_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  alias: text('alias').notNull(),
  previousModelId: text('previous_model_id'),
  newModelId: text('new_model_id'),
  action: text('action', { enum: MODEL_HISTORY_ACTIONS }).notNull(),
  reason: text('reason'),
  triggeredBy: text('triggered_by').notNull().default('system'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
});

export type ModelAlias = typeof modelAliases.$inferSelect;
export type InsertModelAlias = typeof modelAliases.$inferInsert;
export type ModelCandidate = typeof modelCandidates.$inferSelect;
export type InsertModelCandidate = typeof modelCandidates.$inferInsert;
export type ModelHistoryRecord = typeof modelHistory.$inferSelect;
export type InsertModelHistoryRecord = typeof modelHistory.$inferInsert;

/**
 * DOC-001: External document export tracking (DocuMente integration).
 * Makes the fire-and-forget DocuMente export traceable and idempotent:
 * - traceable: stores the external id/url returned by DocuMente so the
 *   user can navigate back to the generated epic/user stories.
 * - idempotent: a partial UNIQUE constraint on the current
 *   (demand_id, doc_type) row preserves history while coordinating retries.
 */
export const demandExternalDocs = sqliteTable(
  'demand_external_docs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    demandId: integer('demand_id').notNull(),
    docType: text('doc_type', { enum: ['epic', 'userstories'] }).notNull(),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    docuMenteUrl: text('docu_mente_url').notNull(),
    status: text('status', { enum: ['pending', 'success', 'failed'] }).notNull(),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    operationToken: text('operation_token'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
  },
  (table) => ({
    // One current logical document; historical rows remain queryable.
    demandDocTypeUniq: uniqueIndex('demand_external_docs_current_idx')
      .on(table.demandId, table.docType)
      .where(sql`${table.isCurrent} = 1`),
  }),
);

export type DemandExternalDoc = typeof demandExternalDocs.$inferSelect;
export type InsertDemandExternalDoc = typeof demandExternalDocs.$inferInsert;

// H-28: tables previously only in raw SQL migrations
// The 15 table definitions below mirror migrations that were historically
// accessed only via raw SQL in services. They are declared here for type
// safety ($inferSelect / $inferInsert) and future Drizzle query use.
// Source of truth for column shapes: the migration SQL files referenced
// inline per table.

// --- agent_memory (migrations/0040_agent_memory.sql) ---
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    id: text('id').primaryKey().notNull(),
    agentId: text('agent_id').notNull(),
    memoryType: text('memory_type').notNull(),
    content: text('content').notNull(),
    sourceDemandId: integer('source_demand_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    lookupIdx: index('agent_memory_lookup_idx').on(
      table.agentId,
      table.memoryType,
      sql`${table.createdAt} DESC`,
    ),
  }),
);

// --- pm_frameworks (migrations/0041_pm_frameworks.sql) ---
export const pmFrameworks = sqliteTable(
  'pm_frameworks',
  {
    id: text('id').primaryKey().notNull(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    content: text('content').notNull(),
    version: text('version'),
    importedAt: integer('imported_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    slugIdx: index('pm_frameworks_slug_idx').on(table.slug),
  }),
);

// --- retrospectives (migrations/0042_retro_actions.sql, first CREATE TABLE) ---
export const retrospectives = sqliteTable('retrospectives', {
  id: text('id').primaryKey().notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  snapshot: text('snapshot').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- retro_actions (migrations/0042_retro_actions.sql, second CREATE TABLE) ---
export const retroActions = sqliteTable(
  'retro_actions',
  {
    id: text('id').primaryKey().notNull(),
    retroId: text('retro_id').notNull(),
    description: text('description').notNull(),
    owner: text('owner'),
    metricKey: text('metric_key').notNull(),
    metricBefore: real('metric_before'),
    metricAfter: real('metric_after'),
    successCriteria: text('success_criteria'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    retroIdx: index('retro_actions_retro_idx').on(table.retroId, sql`${table.createdAt} DESC`),
  }),
);

// --- episodic_memory (migrations/0043_episodic_memory.sql) ---
export const episodicMemory = sqliteTable(
  'episodic_memory',
  {
    id: text('id').primaryKey().notNull(),
    skill: text('skill').notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull().default(0),
    sanitized: integer('sanitized', { mode: 'boolean' }).notNull().default(false),
    sourceType: text('source_type').notNull().default('episodic'),
    retryCount: integer('retry_count'),
    durationMs: integer('duration_ms'),
    memoryActive: integer('memory_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    skillIdx: index('episodic_memory_skill_idx').on(
      table.skill,
      sql`${table.confidence} DESC`,
      sql`${table.createdAt} DESC`,
    ),
  }),
);

// --- backlog_activities (migrations/0044_backlog_activities.sql) ---
export const backlogActivities = sqliteTable(
  'backlog_activities',
  {
    id: text('id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('em_desenvolvimento'),
    hasPrd: integer('has_prd', { mode: 'boolean' }).notNull().default(false),
    hasTasks: integer('has_tasks', { mode: 'boolean' }).notNull().default(false),
    hasChat: integer('has_chat', { mode: 'boolean' }).notNull().default(false),
    // Auditoria 2026-08-01 (A08): a declaração dizia `integer timestamp`, mas a
    // tabela implantada (migration 0044) é TEXT com `datetime('now')` — e a
    // afinidade TEXT do SQLite converte qualquer número gravado em string. O
    // resultado eram DOIS formatos na mesma coluna (ISO e epoch-string), e como
    // `ORDER BY created_at` compara lexicograficamente, as linhas em epoch
    // ficavam sempre no fim da lista. A declaração passa a refletir a coluna
    // real; a normalização para ISO vive no serviço.
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    demandIdx: uniqueIndex('backlog_activities_demand_idx').on(table.demandId),
  }),
);

// --- chunk_embeddings (migrations/0014_rag_improvements.sql, line 15) ---
// pgvector table. SQLite has no native vector type; embedding is stored as
// serialized text. UUID id stored as text.
export const chunkEmbeddings = sqliteTable(
  'chunk_embeddings',
  {
    id: text('id').primaryKey().notNull(),
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    embedding: text('embedding').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    chunkSourceUniq: uniqueIndex('chunk_embeddings_chunk_id_chunk_source_idx').on(
      table.chunkId,
      table.chunkSource,
    ),
    sourceIdx: index('idx_chunk_embeddings_source').on(table.chunkSource),
  }),
);

// --- rag_feedback (migrations/0014_rag_improvements.sql, line 56) ---
export const ragFeedback = sqliteTable(
  'rag_feedback',
  {
    id: text('id').primaryKey().notNull(),
    queryId: text('query_id').notNull(),
    queryText: text('query_text').notNull(),
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    wasHelpful: integer('was_helpful', { mode: 'boolean' }).notNull(),
    selectedByUser: integer('selected_by_user', { mode: 'boolean' }).default(false),
    feedbackType: text('feedback_type').default('implicit'),
    sessionId: text('session_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    chunkIdx: index('idx_rag_feedback_chunk').on(table.chunkId),
    queryIdx: index('idx_rag_feedback_query').on(table.queryId),
  }),
);

// --- chunk_relevance_scores (migrations/0014_rag_improvements.sql, line 76) ---
export const chunkRelevanceScores = sqliteTable(
  'chunk_relevance_scores',
  {
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    totalShown: integer('total_shown').default(0),
    totalHelpful: integer('total_helpful').default(0),
    totalSelected: integer('total_selected').default(0),
    successRate: real('success_rate').default(0.0),
    boostFactor: real('boost_factor').default(1.0),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chunkId, table.chunkSource] }),
  }),
);

// --- safety_logs (migrations/0013_expand_guardrails_safety.sql, line 8) ---
export const safetyLogs = sqliteTable(
  'safety_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp')
      .notNull()
      .default(sql`(unixepoch())`),
    action: text('action').notNull(),
    confidence: text('confidence').notNull(),
    originalTextHash: text('original_text_hash'),
    userId: text('user_id'),
    demandId: integer('demand_id'),
    detections: text('detections', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    latencyMs: integer('latency_ms').notNull().default(0),
    guardrailLogId: integer('guardrail_log_id'),
  },
  (table) => ({
    timestampIdx: index('idx_safety_logs_timestamp').on(table.timestamp),
    actionIdx: index('idx_safety_logs_action').on(table.action),
    confidenceIdx: index('idx_safety_logs_confidence').on(table.confidence),
  }),
);

// --- prompt_versions (migrations/0012_add_prompt_versions.sql, line 3) ---
export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    promptName: text('prompt_name').notNull(),
    version: text('version').notNull(),
    content: text('content').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
    activatedAt: integer('activated_at'),
    author: text('author'),
    description: text('description'),
  },
  (table) => ({
    nameVersionUniq: uniqueIndex('idx_prompt_versions_name_version').on(
      table.promptName,
      table.version,
    ),
    nameIdx: index('idx_prompt_versions_name').on(table.promptName),
    activeIdx: index('idx_prompt_versions_active').on(table.promptName, table.isActive),
  }),
);

// --- prompt_ab_tests (migrations/0012_add_prompt_versions.sql, line 20) ---
export const promptAbTests = sqliteTable(
  'prompt_ab_tests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    promptName: text('prompt_name').notNull(),
    versionA: text('version_a').notNull(),
    versionB: text('version_b').notNull(),
    trafficPercentB: integer('traffic_percent_b').notNull().default(50),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
    endedAt: integer('ended_at'),
  },
  (table) => ({
    nameActiveUniq: uniqueIndex('idx_prompt_ab_tests_name_active').on(
      table.promptName,
      table.isActive,
    ),
  }),
);

// --- prompt_version_metrics (migrations/0012_add_prompt_versions.sql, line 33) ---
export const promptVersionMetrics = sqliteTable(
  'prompt_version_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    promptName: text('prompt_name').notNull(),
    version: text('version').notNull(),
    sessionId: text('session_id'),
    demandId: integer('demand_id'),
    /** A08: usada por prompt-version.ts (INSERT/SELECT); faltava na declaração. */
    model: text('model'),
    successFlag: integer('success_flag', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms'),
    abTestId: integer('ab_test_id').references(() => promptAbTests.id),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    nameVersionIdx: index('idx_prompt_metrics_name_version').on(table.promptName, table.version),
    abTestIdx: index('idx_prompt_metrics_ab_test').on(table.abTestId),
    createdIdx: index('idx_prompt_metrics_created').on(table.createdAt),
  }),
);

// --- guardrail_logs (migrations/0011_add_guardrail_logs.sql, line 4) ---
export const guardrailLogs = sqliteTable(
  'guardrail_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp')
      .notNull()
      .default(sql`(unixepoch())`),
    guardrailType: text('guardrail_type').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    inputHash: text('input_hash').notNull(),
    detections: text('detections', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    latencyMs: integer('latency_ms').notNull().default(0),
    userId: text('user_id'),
    demandId: integer('demand_id'),
    requestId: text('request_id'),
  },
  (table) => ({
    timestampIdx: index('idx_guardrail_logs_timestamp').on(table.timestamp),
    typeIdx: index('idx_guardrail_logs_type').on(table.guardrailType),
    actionIdx: index('idx_guardrail_logs_action').on(table.action),
  }),
);

// --- llm_audit_logs (migrations/0010_add_llm_audit_logs.sql, line 5) ---
export const llmAuditLogs = sqliteTable(
  'llm_audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id').notNull(),
    userId: text('user_id'),
    userName: text('user_name'),
    prompt: text('prompt').notNull(),
    response: text('response').notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    operation: text('operation'),
    agentName: text('agent_name'),
    latencyMs: integer('latency_ms').notNull().default(0),
    statusCode: integer('status_code').notNull().default(200),
    errorMessage: text('error_message'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    estimatedCostUsd: real('estimated_cost_usd'),
    duimpId: text('duimp_id'),
    contractId: text('contract_id'),
    ncm: text('ncm'),
    iofFlag: integer('iof_flag', { mode: 'boolean' }).default(false),
    domain: text('domain').default('geral'),
    demandId: integer('demand_id'),
    feedback: text('feedback'),
    feedbackComment: text('feedback_comment'),
    feedbackAt: integer('feedback_at'),
    // Demanda #10364 (Fatia 2A) — correlação de custo de IA por usuário da
    // plataforma pública. Nullable: logs legados e logs do admin local não têm.
    platformUserId: integer('platform_user_id'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    createdAtIdx: index('idx_llm_audit_logs_created_at').on(table.createdAt),
    duimpIdIdx: index('idx_llm_audit_logs_duimp_id').on(table.duimpId),
    contractIdIdx: index('idx_llm_audit_logs_contract_id').on(table.contractId),
    ncmIdx: index('idx_llm_audit_logs_ncm').on(table.ncm),
    requestIdIdx: index('idx_llm_audit_logs_request_id').on(table.requestId),
    demandIdIdx: index('idx_llm_audit_logs_demand_id').on(table.demandId),
    userIdIdx: index('idx_llm_audit_logs_user_id').on(table.userId),
    feedbackIdx: index('idx_llm_audit_logs_feedback').on(table.feedback),
    feedbackCheck: check(
      'llm_audit_logs_feedback_check',
      sql`${table.feedback} IS NULL OR ${table.feedback} IN ('positive', 'negative')`,
    ),
  }),
);

// Type exports for the 15 new tables
export type AgentMemory = typeof agentMemory.$inferSelect;
export type InsertAgentMemory = typeof agentMemory.$inferInsert;
export type PmFramework = typeof pmFrameworks.$inferSelect;
export type InsertPmFramework = typeof pmFrameworks.$inferInsert;
export type Retrospective = typeof retrospectives.$inferSelect;
export type InsertRetrospective = typeof retrospectives.$inferInsert;
export type RetroAction = typeof retroActions.$inferSelect;
export type InsertRetroAction = typeof retroActions.$inferInsert;
export type EpisodicMemory = typeof episodicMemory.$inferSelect;
export type InsertEpisodicMemory = typeof episodicMemory.$inferInsert;
export type BacklogActivity = typeof backlogActivities.$inferSelect;
export type InsertBacklogActivity = typeof backlogActivities.$inferInsert;
export type ChunkEmbedding = typeof chunkEmbeddings.$inferSelect;
export type InsertChunkEmbedding = typeof chunkEmbeddings.$inferInsert;
export type RagFeedback = typeof ragFeedback.$inferSelect;
export type InsertRagFeedback = typeof ragFeedback.$inferInsert;
export type ChunkRelevanceScore = typeof chunkRelevanceScores.$inferSelect;
export type InsertChunkRelevanceScore = typeof chunkRelevanceScores.$inferInsert;
export type SafetyLog = typeof safetyLogs.$inferSelect;
export type InsertSafetyLog = typeof safetyLogs.$inferInsert;
export type PromptVersion = typeof promptVersions.$inferSelect;
export type InsertPromptVersion = typeof promptVersions.$inferInsert;
export type PromptAbTest = typeof promptAbTests.$inferSelect;
export type InsertPromptAbTest = typeof promptAbTests.$inferInsert;
export type PromptVersionMetric = typeof promptVersionMetrics.$inferSelect;
export type InsertPromptVersionMetric = typeof promptVersionMetrics.$inferInsert;
export type GuardrailLog = typeof guardrailLogs.$inferSelect;
export type InsertGuardrailLog = typeof guardrailLogs.$inferInsert;
export type LlmAuditLog = typeof llmAuditLogs.$inferSelect;
export type InsertLlmAuditLog = typeof llmAuditLogs.$inferInsert;

// Spec 10192: Drizzle relations para joins tipados.
export const demandsRelations = relations(demands, ({ many }) => ({
  files: many(files),
}));

export const filesRelations = relations(files, ({ one }) => ({
  demand: one(demands, { fields: [files.demandId], references: [demands.id] }),
}));

// --- dead_letters (Spec 10240 M-2): event bus dead-letter queue ---
export const deadLetters = sqliteTable(
  'dead_letters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    errorMessage: text('error_message').notNull(),
    errorStack: text('error_stack'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    eventTypeIdx: index('idx_dead_letters_event_type').on(table.eventType),
    createdAtIdx: index('idx_dead_letters_created_at').on(table.createdAt),
    eventIdIdx: index('idx_dead_letters_event_id').on(table.eventId),
  }),
);

export type DeadLetter = typeof deadLetters.$inferSelect;
export type InsertDeadLetter = typeof deadLetters.$inferInsert;

// --- dlq_messages (migrations/0052_add_dlq_messages.sql) ---
export const dlqMessages = sqliteTable(
  'dlq_messages',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id').notNull(),
    queueName: text('queue_name').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    stackTrace: text('stack_trace').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    failedAt: integer('failed_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    queueNameIdx: index('idx_dlq_messages_queue_name').on(table.queueName),
    failedAtIdx: index('idx_dlq_messages_failed_at').on(table.failedAt),
    messageIdIdx: index('idx_dlq_messages_message_id').on(table.messageId),
  }),
);

export type DlqMessage = typeof dlqMessages.$inferSelect;
export type InsertDlqMessage = typeof dlqMessages.$inferInsert;

// --- agent_failures (A-1: log estruturado de falhas de agente no AgentOrchestrator)
export const agentFailures = sqliteTable(
  'agent_failures',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    executionId: text('execution_id').notNull(),
    errorCategory: text('error_category').notNull(),
    errorMessage: text('error_message').notNull(),
    stackShort: text('stack_short'),
    delayApplied: integer('delay_applied').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    agentCreatedAtIdx: index('idx_agent_failures_agent_created_at').on(
      table.agentId,
      table.createdAt,
    ),
    executionIdIdx: index('idx_agent_failures_execution_id').on(table.executionId),
  }),
);

export type AgentFailure = typeof agentFailures.$inferSelect;
export type InsertAgentFailure = typeof agentFailures.$inferInsert;

// =============================================================================
// Demanda #10358 — Plataforma Online do Aichatflow para Vibe Coders (Fatia 1)
//
// Camada pública multi-tenant, aditiva ao núcleo local-first do produto
// (constituição v1.1.0, seção "Camada de Plataforma Pública"). Deliberadamente
// NÃO reaproveita a tabela legada `users` (não usada por nenhuma rota real —
// só por server/storage.ts/IStorage) para não misturar dead code com feature
// nova. Ver migrations/0056_vibe_coders_platform.sql.
// =============================================================================

// --- platform_users: contas reais dos usuários da plataforma pública ---
export const platformUsers = sqliteTable('platform_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Spec 10358 (session_nonce): login gera um nonce novo; logout/comprometimento
  // de conta gera outro, invalidando todo JWT emitido antes da troca.
  sessionNonce: text('session_nonce'),
  plan: text('plan').notNull().default('free'),
  // Demanda #10367 (Fatia 2D) — soft delete + admin
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  admin: integer('admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PlatformUser = typeof platformUsers.$inferSelect;
export type InsertPlatformUser = typeof platformUsers.$inferInsert;

// --- waitlist: captura de demanda na landing page (T1), paralela ao MVP ---
export const waitlist = sqliteTable('waitlist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  source: text('source').default('landing'),
});

export type WaitlistEntry = typeof waitlist.$inferSelect;
export type InsertWaitlistEntry = typeof waitlist.$inferInsert;

// --- git_connections: OAuth GitHub por usuário, somente leitura (T4) ---
export const gitConnections = sqliteTable(
  'git_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['github'] })
      .notNull()
      .default('github'),
    // AES-256-GCM (iv + authTag + ciphertext) — ver server/services/git-token-cipher.ts.
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    githubUsername: text('github_username'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userProviderIdx: uniqueIndex('idx_git_connections_user_provider').on(
      table.userId,
      table.provider,
    ),
  }),
);

export type GitConnection = typeof gitConnections.$inferSelect;
export type InsertGitConnection = typeof gitConnections.$inferInsert;

// --- usage_counters: contadores do Free Tier por usuário/mês (T5) ---
export const usageCounters = sqliteTable(
  'usage_counters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    period: text('period').notNull(), // 'YYYY-MM'
    refinementsCount: integer('refinements_count').notNull().default(0),
    connectedRepos: integer('connected_repos').notNull().default(0),
  },
  (table) => ({
    userPeriodIdx: uniqueIndex('idx_usage_counters_user_period').on(table.userId, table.period),
  }),
);

export type UsageCounter = typeof usageCounters.$inferSelect;
export type InsertUsageCounter = typeof usageCounters.$inferInsert;

// --- analytics_events: métrica de ativação (abertura -> 1o refinamento) (T3) ---
export const analyticsEvents = sqliteTable(
  'analytics_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userEventIdx: index('idx_analytics_events_user_event').on(table.userId, table.eventType),
  }),
);

export type PlatformAnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type InsertPlatformAnalyticsEvent = typeof analyticsEvents.$inferInsert;

// --- subscriptions: estado canônico de assinatura Paddle (Fatia 2A, #10364) ---
// `platform_users.plan` é cache derivado (atualizado pelo webhook); esta tabela
// é a fonte de verdade. Grace period: status='canceled' + current_period_end > now = Pro.
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('pro'),
    status: text('status').notNull().default('active'), // active | canceled | past_due | paused
    paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
    paddleCustomerId: text('paddle_customer_id'),
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp' }),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    paddleIdx: uniqueIndex('idx_subscriptions_paddle_id').on(table.paddleSubscriptionId),
    userIdx: index('idx_subscriptions_user_id').on(table.userId),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;

// --- db_connections: conexões de banco do usuário (Fatia 2B, #10365) ---
// Credenciais cifradas com AES-256-GCM (db-credential-cipher.ts). Apenas
// leitura de schema — zero queries arbitrárias do usuário.
export const dbConnections = sqliteTable(
  'db_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    dbType: text('db_type').notNull(), // postgresql | mysql | supabase | neon
    host: text('host').notNull(),
    port: integer('port'),
    databaseName: text('database_name'),
    username: text('username'),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userNameIdx: uniqueIndex('idx_db_connections_user_name').on(table.userId, table.name),
    userIdx: index('idx_db_connections_user_id').on(table.userId),
  }),
);

export type DbConnection = typeof dbConnections.$inferSelect;
export type InsertDbConnection = typeof dbConnections.$inferInsert;

// --- preview_cache: cache 24h de previews automáticos (Fatia 2C, #10366) ---
export const previewCache = sqliteTable('preview_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  result: text('result').notNull(), // JSON string
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PreviewCache = typeof previewCache.$inferSelect;
export type InsertPreviewCache = typeof previewCache.$inferInsert;

// --- preview_jobs: jobs assíncronos de preview (Fatia 2C, #10366) ---
export const previewJobs = sqliteTable('preview_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().unique(),
  userId: integer('user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  status: text('status').notNull().default('pending'), // pending|processing|completed|failed
  result: text('result'), // JSON string when completed
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PreviewJob = typeof previewJobs.$inferSelect;
export type InsertPreviewJob = typeof previewJobs.$inferInsert;
