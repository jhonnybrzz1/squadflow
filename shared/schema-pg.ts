/**
 * Postgres schema mirror of `schema.ts`.
 *
 * Strategy: declare the same 14 tables with `pgTable` (using `boolean`,
 * `timestamp`, `jsonb`, `serial`) so the runtime adapter `drizzle-orm/neon-http`
 * can issue Postgres-compatible queries.
 *
 * Tipos canônicos (`Demand`, `User`, etc.) continuam vindo de `schema.ts` —
 * a estrutura de colunas é idêntica, então `$inferSelect` produz o mesmo
 * shape em ambos.
 *
 * Source of truth: `schema.ts` (SQLite). Any change there MUST be mirrored here.
 */

import {
  pgTable,
  text,
  integer,
  serial,
  boolean,
  timestamp,
  jsonb,
  bigint,
  doublePrecision,
  uniqueIndex,
  check,
  index,
  primaryKey,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type {
  RefinementInteraction,
  CoverageAnalysisResult,
  ChatMessage,
  TypeAdherenceResult,
  DemandDomain,
  RefinementType,
  DocumentVersionsMap,
  RetentionPolicyAction,
  RetentionDataType,
  RetentionJobStatus,
} from './schema';
import type { DemandType, DemandPriority } from './demand-types';

export const demands = pgTable('demands', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  type: text('type').$type<DemandType>().notNull(),
  priority: text('priority').$type<DemandPriority>().notNull(),
  refinementType: text('refinement_type').$type<RefinementType>(),
  status: text('status').notNull().default('processing'),
  progress: integer('progress').notNull().default(0),
  chatMessages: jsonb('chat_messages').$type<ChatMessage[]>().default([]),
  prdUrl: text('prd_url'),
  tddUrl: text('tdd_url'),
  tasksUrl: text('tasks_url'),
  domain: text('domain').$type<DemandDomain>().default('padrao'),
  classification: jsonb('classification').$type<any>(),
  orchestration: jsonb('orchestration').$type<any>(),
  currentAgent: text('current_agent'),
  errorMessage: text('error_message'),
  validationNotes: text('validation_notes'),
  typeAdherence: jsonb('type_adherence').$type<TypeAdherenceResult>(),
  completedAt: timestamp('completed_at'),

  requiresApproval: boolean('requires_approval').default(false),
  requiresHumanReview: boolean('requires_human_review').default(false),
  documentState: text('document_state').default('DRAFT'),
  reviewSnapshotId: text('review_snapshot_id'),
  approvedSnapshotId: text('approved_snapshot_id'),
  approvedSnapshotHash: text('approved_snapshot_hash'),
  finalSnapshotId: text('final_snapshot_id'),
  finalizedFromHash: text('finalized_from_hash'),
  approvalSessionId: text('approval_session_id'),
  revisionNumber: integer('revision_number').notNull().default(0),
  reviewRequestedAt: timestamp('review_requested_at'),
  approvedAt: timestamp('approved_at'),
  approvedBy: text('approved_by'),
  rejectedAt: timestamp('rejected_at'),
  rejectionReason: text('rejection_reason'),
  returnedToDraftAt: timestamp('returned_to_draft_at'),

  sectionChecklist: jsonb('section_checklist').$type<Record<string, boolean>>().default({}),
  refinementInteractions: jsonb('refinement_interactions')
    .$type<RefinementInteraction[]>()
    .default([]),
  coverageAnalysis: jsonb('coverage_analysis').$type<CoverageAnalysisResult>(),
  learningLog: jsonb('learning_log').$type<string[]>().default([]),
  // Demanda 10089 (item 4): evidência textual de 1 cenário negativo no fechamento.
  qaEvidence: text('qa_evidence'),
  // Demanda 10089 (item 5): classificação de esforço P/M/G na entrada do refinamento.
  size: text('size', { enum: ['P', 'M', 'G'] }).$type<'P' | 'M' | 'G'>(),
  overrideJustification: text('override_justification'),
  overrideBy: text('override_by'),

  runId: text('run_id'),
  qualityGateStatus: text('quality_gate_status'),
  finalDocHash: text('final_doc_hash'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  custoEstimado: doublePrecision('custo_estimado').notNull().default(0),

  documentVersions: jsonb('document_versions').$type<DocumentVersionsMap>().default({}),

  // Anti-overengineering: PO/TL pode elevar o teto de esforço aprovado
  maxEffortOverrideDias: doublePrecision('max_effort_override_dias'),
  maxEffortOverrideBy: text('max_effort_override_by'),
  maxEffortOverrideJustification: text('max_effort_override_justification'),

  // Departmentalização do RAG — ver shared/schema.ts (mantido nullable para
  // demandas sem repo associado e para backfill do histórico).
  repoFullName: text('repo_full_name'),

  // Skill externa (URL raw) — ver shared/schema.ts
  // BAIXO-01: propriedade renomeada, coluna preservada de propósito.
  // Ver a nota em shared/schema.ts.
  skillRawUrl: text('skill_sh_url'),

  // CRIT-16: descrição original do usuário antes do enriquecimento — ver
  // shared/schema.ts
  originalDescription: text('original_description'),

  // Mesa Redonda (PRD #5)
  roundtableConfig: jsonb('roundtable_config')
    .$type<{
      agentIds: string[];
      maxRounds: number;
      currentRound?: number;
      triageReasoning?: string;
    }>()
    .default({ agentIds: [], maxRounds: 3 }),
  roundtableSummary: jsonb('roundtable_summary').$type<{
    totalRounds: number;
    divergences: number;
    agentContributions: Record<string, number>;
    consolidation?: string;
    escalations?: Array<{ agent: string; round: number; reason: string }>;
  }>(),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),

  // Optional fields used by some routes (matching schema.ts extension type)
  executionId: text('execution_id'),
  executionConfig: jsonb('execution_config'),
  qualityPassed: boolean('quality_passed'),
  missingSections: jsonb('missing_sections'),
  fallbackUsed: boolean('fallback_used').default(false),
  fallbackReason: text('fallback_reason'),
  // Spec 10015: modo go-live (fast-track) opt-in por demanda (ver schema.ts).
  goLiveMode: boolean('go_live_mode').default(false),

  // Demanda 10196: rastreamento de origem Discovery → Refinement.
  origin: text('origin'),
  originMetadata: jsonb('origin_metadata')
    .$type<{
      frameworkName?: string;
      frameworkId?: string;
      sessionId?: string;
    }>()
    .default({}),
});

export const documentSnapshots = pgTable('document_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id),
  snapshotType: text('snapshot_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const approvalComments = pgTable('approval_comments', {
  commentId: serial('comment_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id),
  reviewSnapshotId: text('review_snapshot_id'),
  approvedSnapshotId: text('approved_snapshot_id'),
  author: text('author'),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const documentLifecycleEvents = pgTable('document_lifecycle_events', {
  eventId: serial('event_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id),
  requiresApproval: boolean('requires_approval').notNull(),
  approvalSessionId: text('approval_session_id'),
  eventType: text('event_type').notNull(),
  reviewSnapshotId: text('review_snapshot_id'),
  approvedSnapshotId: text('approved_snapshot_id'),
  finalSnapshotId: text('final_snapshot_id'),
  finalizedFromHash: text('finalized_from_hash'),
  resultCode: text('result_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull(),
});

export const operationAttempts = pgTable('operation_attempts', {
  attemptId: text('attempt_id').primaryKey(),
  operationId: text('operation_id').notNull(),
  operationType: text('operation_type').notNull(),
  demandId: integer('demand_id').references(() => demands.id),
  status: text('status').notNull(),
  gateStatus: text('gate_status').notNull(),
  missingFields: jsonb('missing_fields').$type<string[]>().notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  completedAt: timestamp('completed_at'),
});

export const modelRoutingStageRuns = pgTable('model_routing_stage_runs', {
  runId: text('run_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  executionId: text('execution_id'),
  stageName: text('stage_name').notNull(),
  modelUsed: text('model_used').notNull(),
  attemptIndex: integer('attempt_index').notNull(),
  status: text('status').notNull(),
  validationPassed: boolean('validation_passed'),
  validationErrorsCount: integer('validation_errors_count'),
  qaPassed: boolean('qa_passed'),
  qaBlockersCount: integer('qa_blockers_count'),
  failureReason: text('failure_reason'),
  finalArtifactAccepted: boolean('final_artifact_accepted'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull(),
});

export const agentDecisionRecords = pgTable('agent_decision_records', {
  runId: text('run_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  executionId: text('execution_id'),
  demandType: text('demand_type').notNull(),
  taskType: text('task_type').notNull(),
  problemDefined: boolean('problem_defined'),
  uiImpactKnown: text('ui_impact_known'),
  acceptanceScope: text('acceptance_scope').notNull(),
  confidence: text('confidence').notNull(),
  proposedIncludeAgents: jsonb('proposed_include_agents').$type<string[]>().notNull(),
  proposedOmitAgents: jsonb('proposed_omit_agents').$type<string[]>().notNull(),
  actualIncludeAgents: jsonb('actual_include_agents').$type<string[]>().notNull(),
  actualOmitAgents: jsonb('actual_omit_agents').$type<string[]>().notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull(),
  fallbackUsed: boolean('fallback_used').notNull(),
  shadowMode: boolean('shadow_mode').notNull(),
  decisionLatencyMs: integer('decision_latency_ms').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const domainExecutionRecords = pgTable('domain_execution_records', {
  executionId: text('execution_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  domainTriggered: boolean('domain_triggered').notNull(),
  domainUsableReturned: boolean('domain_usable_returned').notNull(),
  domainUsedInFinal: boolean('domain_used_in_final').notNull(),
  outputSource: text('output_source').notNull(),
  fallbackOrReprocess: boolean('fallback_or_reprocess').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const progressiveRefinementRecords = pgTable('progressive_refinement_records', {
  executionId: text('execution_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  complexity: text('complexity').notNull(),
  impact: text('impact').notNull(),
  risk: text('risk').notNull(),
  levelTriaged: integer('level_triaged').notNull(),
  triageConfidence: integer('triage_confidence').notNull().default(100),
  triageReasonCodes: jsonb('triage_reason_codes').$type<string[]>().default([]),
  levelExecuted: integer('level_executed').notNull(),
  wasDowngraded: boolean('was_downgraded').notNull().default(false),
  agentsUsed: jsonb('agents_used').$type<string[]>().notNull(),
  modelUsed: text('model_used').notNull(),
  callsCountByStage: jsonb('calls_count_by_stage').$type<Record<string, number>>().default({}),
  contextBudgetProxyByStage: jsonb('context_budget_proxy_by_stage')
    .$type<Record<string, number>>()
    .default({}),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
  tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
  costEstimated: doublePrecision('cost_estimated').notNull().default(0.0),
  costReal: doublePrecision('cost_real').notNull().default(0.0),
  reworkFlag: boolean('rework_flag').notNull().default(false),
  truncated: boolean('truncated').notNull().default(false),
  incomplete: boolean('incomplete').notNull().default(false),
  artifactValidation: boolean('artifact_validation').notNull().default(true),
  gateStatus: text('gate_status').notNull(),
  endedReason: text('ended_reason').notNull().default('completed_successfully'),
  experimentBucket: text('experiment_bucket').notNull().default('baseline'),
  triagePolicyVersion: text('triage_policy_version').notNull().default('1.0.0'),
  executionPolicyVersion: text('execution_policy_version').notNull().default('1.0.0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// Orchestration Runtime Persistence (espelha schema.ts em pgTable)
// ============================================================================

export const orchestrationRuns = pgTable('orchestration_runs', {
  runId: text('run_id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  pipelineId: text('pipeline_id'),
  mode: text('mode').notNull().default('roundtable'),
  status: text('status').notNull(),
  agentOrder: jsonb('agent_order').$type<string[]>(),
  errorMessage: text('error_message'),
  regulatoryContext: text('regulatory_context'),
  sensitivityLevel: text('sensitivity_level'),
  normaReferencia: text('norma_referencia'),
  tokensIn: bigint('tokens_in', { mode: 'number' }),
  tokensOut: bigint('tokens_out', { mode: 'number' }),
  costEstimated: doublePrecision('cost_estimated'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
});

export const agentTurns = pgTable(
  'agent_turns',
  {
    turnId: text('turn_id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => orchestrationRuns.runId, { onDelete: 'cascade' }),
    demandId: integer('demand_id').notNull(),
    agentName: text('agent_name').notNull(),
    turnIndex: integer('turn_index').notNull(),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    tokensIn: bigint('tokens_in', { mode: 'number' }),
    tokensOut: bigint('tokens_out', { mode: 'number' }),
    costEstimated: doublePrecision('cost_estimated'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    runIdx: index('idx_agent_turns_run_id').on(table.runId),
  }),
);

export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    toolCallId: text('tool_call_id').primaryKey(),
    turnId: text('turn_id')
      .notNull()
      .references(() => agentTurns.turnId, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    toolName: text('tool_name').notNull(),
    status: text('status').notNull(),
    argsJson: jsonb('args_json').$type<Record<string, unknown>>(),
    resultJson: jsonb('result_json').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => ({
    turnIdx: index('idx_agent_tool_calls_turn_id').on(table.turnId),
  }),
);

export const orchestrationEvents = pgTable(
  'orchestration_events',
  {
    eventId: text('event_id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => orchestrationRuns.runId, { onDelete: 'cascade' }),
    demandId: integer('demand_id').notNull(),
    eventType: text('event_type').notNull(),
    agentName: text('agent_name'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => ({
    runIdx: index('idx_orchestration_events_run_id').on(table.runId),
  }),
);

export const repos = pgTable('repos', {
  id: serial('id').primaryKey(),
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
  size: integer('size'),
  stars: integer('stars').default(0),
  forks: integer('forks').default(0),
  isPrivate: boolean('is_private').default(false),
  isFork: boolean('is_fork').default(false),
  indexedContent: text('indexed_content'),
  indexedAt: timestamp('indexed_at'),
  briefing: text('briefing'),
  briefingGeneratedAt: timestamp('briefing_generated_at'),
  systemMap: text('system_map'),
  systemMapGeneratedAt: timestamp('system_map_generated_at'),
  lastCommit: text('last_commit'),
  lastCommitDate: timestamp('last_commit_date'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const repoFiles = pgTable(
  'repo_files',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    filename: text('filename').notNull(),
    content: text('content'),
    language: text('language'),
    size: integer('size'),
    sha: text('sha'),
    url: text('url'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    repoIdx: index('idx_repo_files_repo_id').on(table.repoId),
  }),
);

export const files = pgTable('files', {
  id: serial('id').primaryKey(),
  demandId: integer('demand_id').references(() => demands.id),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  path: text('path').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
});

export const telemetry = pgTable('telemetry', {
  id: serial('id').primaryKey(),
  runId: text('run_id').notNull(),
  demandId: integer('demand_id').references(() => demands.id),
  agentName: text('agent_name'),
  operation: text('operation').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  status: text('status').notNull(),
  retryAttempt: integer('retry_attempt').notNull().default(0),
  fallbackUsed: boolean('fallback_used').notNull().default(false),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
});

export const humanFeedback = pgTable('human_feedback', {
  id: serial('id').primaryKey(),
  demandId: integer('demand_id').notNull(),
  agentMessageId: text('agent_message_id').notNull(),
  feedbackText: text('feedback_text').notNull().default(''),
  feedbackType: text('feedback_type').notNull(),
  agent: text('agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

const REFINEMENT_ITEM_FEEDBACK_STATUSES = ['feito', 'não_feito', 'desatualizado'] as const;

// Mirrors shared/schema.ts: satisfaction and per-item operational status are
// independent dimensions and therefore nullable individually.
export const feedbackRefinamento = pgTable(
  'feedback_refinamento',
  {
    id: serial('id').primaryKey(),
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
    criadoEm: timestamp('criado_em').notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em').notNull().defaultNow(),
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

// Anti-Overengineering Agent: parecer estruturado + impacto de esforço por demanda
export const agentInterventions = pgTable('agent_interventions', {
  id: serial('id').primaryKey(),
  demandId: integer('demand_id').notNull(),
  pontosOverengineering: jsonb('pontos_overengineering').$type<string[]>().notNull(),
  escopoReduzido: text('escopo_reduzido').notNull(),
  roiEstimado: text('roi_estimado').notNull(),
  esforcoOriginalDias: doublePrecision('esforco_original_dias'),
  esforcoReduzidoDias: doublePrecision('esforco_reduzido_dias'),
  overrideApplied: boolean('override_applied').notNull().default(false),
  overrideBy: text('override_by'),
  overrideJustification: text('override_justification'),
  modelo: text('modelo'),
  criadoEm: timestamp('criado_em').notNull().defaultNow(),
});

// =============================================================================
// Data Retention Policies (PRD - Políticas de Retenção de Dados)
// =============================================================================

export const retentionPolicies = pgTable('retention_policies', {
  id: serial('id').primaryKey(),
  dataType: text('data_type').$type<RetentionDataType>().notNull(),
  ttlDays: integer('ttl_days').notNull(),
  action: text('action', { enum: ['archive', 'delete'] })
    .$type<RetentionPolicyAction>()
    .notNull()
    .default('delete'),
  isActive: boolean('is_active').notNull().default(true),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const retentionJobLogs = pgTable(
  'retention_job_logs',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id'),
    policyId: integer('policy_id')
      .notNull()
      .references(() => retentionPolicies.id, { onDelete: 'cascade' }),
    executionStartedAt: timestamp('execution_started_at').notNull().defaultNow(),
    executionCompletedAt: timestamp('execution_completed_at'),
    status: text('status').$type<RetentionJobStatus>().notNull().default('running'),
    rowsAffected: integer('rows_affected').notNull().default(0),
    dbSizeBeforeMb: doublePrecision('db_size_before_mb'),
    dbSizeAfterMb: doublePrecision('db_size_after_mb'),
    errorMessage: text('error_message'),
    retryAttempt: integer('retry_attempt').notNull().default(0),
  },
  (table) => ({
    policyIdx: index('idx_retention_job_logs_policy_id').on(table.policyId),
  }),
);

export const documentJobs = pgTable(
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

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: text('id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    speckitPath: text('speckit_path').notNull(),
    status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    promptSentHash: text('prompt_sent_hash').notNull(),
    filesModified: jsonb('files_modified').$type<string[]>().notNull().default([]),
    typecheckPassed: integer('typecheck_passed'),
    apiCostUsd: doublePrecision('api_cost_usd'),
    humanEditsCount: integer('human_edits_count').notNull().default(0),
    cancelledAt: text('cancelled_at'),
    errorMessage: text('error_message'),
    steps: text('steps').notNull().default('[]'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    demandIdx: index('agent_jobs_demand_idx').on(table.demandId),
    statusIdx: index('agent_jobs_status_idx').on(table.status),
    updatedAtIdx: index('agent_jobs_updated_at_idx').on(table.updatedAt),
  }),
);

// Demanda 10078: registro de sessões de retrospectiva automatizada (SM +
// squad analisam demandas/repos de um período e sintetizam aprendizados).
export const retrospectiveSessions = pgTable(
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
    startedAt: timestamp('started_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('retrospective_sessions_status_idx').on(table.status),
  }),
);

export const codeAgentJobQueue = pgTable(
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
  }),
);

// ==========================================
// Idempotency Records
// ==========================================

export const idempotencyRecords = pgTable('idempotency_records', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  lastSucceededDialect: text('last_succeeded_dialect', { enum: ['postgres', 'sqlite', 'unknown'] })
    .notNull()
    .default('unknown'),
});

// ==========================================
// Client Errors (React Error Instrumentation)
// ==========================================

export type ClientErrorDataSource = 'gov_api' | 'internal' | 'ai_model' | 'unknown';

export const clientErrors = pgTable('client_errors', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  sessionId: text('session_id').notNull(),
  component: text('component').notNull(),
  errorMessage: text('error_message').notNull(),
  stackTrace: text('stack_trace').default(''),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
  dataSource: text('data_source').$type<ClientErrorDataSource>().notNull(),
  userAgent: text('user_agent').default(''),
  url: text('url').default(''),
});

// ==========================================
// Model Registry — dynamic model discovery & promotion
// ==========================================

export const MODEL_ALIAS_STATUSES = ['active', 'disabled', 'deprecated'] as const;
export type ModelAliasStatus = (typeof MODEL_ALIAS_STATUSES)[number];

export const MODEL_ALIAS_SOURCES = ['memory-cache', 'database', 'static-fallback'] as const;
export type ModelAliasSource = (typeof MODEL_ALIAS_SOURCES)[number];

export const modelAliases = pgTable('model_aliases', {
  id: serial('id').primaryKey(),
  alias: text('alias').notNull().unique(),
  family: text('family').notNull(),
  provider: text('provider').notNull(),
  activeModelId: text('active_model_id').notNull(),
  fallbackModelId: text('fallback_model_id'),
  status: text('status', { enum: MODEL_ALIAS_STATUSES }).notNull().default('active'),
  source: text('source', { enum: MODEL_ALIAS_SOURCES }).notNull().default('static-fallback'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastValidatedAt: timestamp('last_validated_at'),
  // MR-05: Persisted auto-rollback state.
  failureCount: integer('failure_count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at'),
  lastRollbackAt: timestamp('last_rollback_at'),
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

export const modelCandidates = pgTable(
  'model_candidates',
  {
    id: serial('id').primaryKey(),
    alias: text('alias').notNull(),
    family: text('family').notNull(),
    provider: text('provider').notNull(),
    currentModelId: text('current_model_id').notNull(),
    candidateModelId: text('candidate_model_id').notNull(),
    candidateVersion: text('candidate_version'),
    status: text('status', { enum: MODEL_CANDIDATE_STATUSES }).notNull().default('discovered'),
    selectionReason: text('selection_reason'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().default({}),
    discoveredAt: timestamp('discovered_at').notNull().defaultNow(),
    validatedAt: timestamp('validated_at'),
    validationError: text('validation_error'),
  },
  (table) => ({
    // Enforced by migration 0010 (pg). Mirrors the SQLite schema.
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

export const modelHistory = pgTable('model_history', {
  id: serial('id').primaryKey(),
  alias: text('alias').notNull(),
  previousModelId: text('previous_model_id'),
  newModelId: text('new_model_id'),
  action: text('action', { enum: MODEL_HISTORY_ACTIONS }).notNull(),
  reason: text('reason'),
  triggeredBy: text('triggered_by').notNull().default('system'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
});

// DOC-001: External document export tracking (DocuMente integration).
// See shared/schema.ts demandExternalDocs for full documentation.
export const demandExternalDocs = pgTable(
  'demand_external_docs',
  {
    id: serial('id').primaryKey(),
    demandId: integer('demand_id').notNull(),
    docType: text('doc_type', { enum: ['epic', 'userstories'] }).notNull(),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    docuMenteUrl: text('docu_mente_url').notNull(),
    status: text('status', { enum: ['pending', 'success', 'failed'] }).notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
    isCurrent: boolean('is_current').notNull().default(true),
    operationToken: text('operation_token'),
    leaseExpiresAt: timestamp('lease_expires_at'),
  },
  (table) => ({
    // One current logical document; historical rows remain queryable.
    demandDocTypeUniq: uniqueIndex('demand_external_docs_current_idx')
      .on(table.demandId, table.docType)
      .where(sql`${table.isCurrent} = true`),
  }),
);

// =============================================================================
// Refinement Executions (demanda 10025 — pipeline unificado)
// Espelho PG de shared/schema.ts (dual-dialect).
// =============================================================================

export const refinementExecutions = pgTable('refinement_executions', {
  id: text('id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  method: text('method', { enum: ['sequential', 'roundtable', 'unified'] }).notNull(),
  fallbackUsed: boolean('fallback_used').notNull().default(false),
  adapterFallback: boolean('adapter_fallback').notNull().default(false),
  consensusScore: doublePrecision('consensus_score'),
  tokensUsed: integer('tokens_used').notNull().default(0),
  executionTimeMs: integer('execution_time_ms').notNull(),
  executionPhases: jsonb('execution_phases').$type<Record<string, unknown>>(),
  artifactJson: jsonb('artifact_json').$type<Record<string, unknown>>(),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// =============================================================================
// Refinements (demanda 10048 — persistência de dados de refinamentos para Grafana)
// Espelho PG de shared/schema.ts (dual-dialect).
// =============================================================================

export const refinements = pgTable(
  'refinements',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    input: text('input').notNull(),
    output: text('output').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index('idx_refinements_session_id').on(table.sessionId),
    createdAtIdx: index('idx_refinements_created_at').on(table.createdAt),
  }),
);

// =============================================================================
// Quality Scores (demanda 10093 Fase 2 — Quality Index)
// Espelho PG de shared/schema.ts (dual-dialect).
// =============================================================================

export const qualityScores = pgTable(
  'quality_scores',
  {
    id: text('id').primaryKey(),
    demandId: integer('demand_id').notNull(),
    documentType: text('document_type', { enum: ['prd', 'tsd'] }).notNull(),
    groundednessScore: doublePrecision('groundedness_score'),
    numericIntegrityScore: doublePrecision('numeric_integrity_score'),
    citedPathScore: doublePrecision('cited_path_score'),
    overallScore: doublePrecision('overall_score'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    demandIdx: index('idx_quality_scores_demand_id').on(table.demandId),
    documentTypeIdx: index('idx_quality_scores_document_type').on(table.documentType),
  }),
);

export type QualityScorePg = typeof qualityScores.$inferSelect;
export type InsertQualityScorePg = typeof qualityScores.$inferInsert;

// =============================================================================
// Artifacts (demanda 10037 — artefatos pós-refinamento)
// Espelho PG de shared/schema.ts (dual-dialect).
// =============================================================================

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  demandId: integer('demand_id')
    .notNull()
    .references(() => demands.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['flowchart'] }).notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// H-28: tables previously only in raw SQL migrations
// The 15 table definitions below mirror migrations that were historically
// accessed only via raw SQL in services. They are declared here for type
// safety ($inferSelect / $inferInsert) and future Drizzle query use.
// Source of truth for column shapes: the migration SQL files referenced
// inline per table.

// --- agent_memory (migrations/0040_agent_memory.sql) ---
export const agentMemory = pgTable(
  'agent_memory',
  {
    id: text('id').primaryKey().notNull(),
    agentId: text('agent_id').notNull(),
    memoryType: text('memory_type').notNull(),
    content: text('content').notNull(),
    sourceDemandId: integer('source_demand_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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
export const pmFrameworks = pgTable(
  'pm_frameworks',
  {
    id: text('id').primaryKey().notNull(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    content: text('content').notNull(),
    version: text('version'),
    importedAt: timestamp('imported_at').notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: index('pm_frameworks_slug_idx').on(table.slug),
  }),
);

// --- retrospectives (migrations/0042_retro_actions.sql, first CREATE TABLE) ---
export const retrospectives = pgTable('retrospectives', {
  id: text('id').primaryKey().notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  snapshot: text('snapshot').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// --- retro_actions (migrations/0042_retro_actions.sql, second CREATE TABLE) ---
export const retroActions = pgTable(
  'retro_actions',
  {
    id: text('id').primaryKey().notNull(),
    retroId: text('retro_id').notNull(),
    description: text('description').notNull(),
    owner: text('owner'),
    metricKey: text('metric_key').notNull(),
    metricBefore: doublePrecision('metric_before'),
    metricAfter: doublePrecision('metric_after'),
    successCriteria: text('success_criteria'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    retroIdx: index('retro_actions_retro_idx').on(table.retroId, sql`${table.createdAt} DESC`),
  }),
);

// --- episodic_memory (migrations/0043_episodic_memory.sql) ---
export const episodicMemory = pgTable(
  'episodic_memory',
  {
    id: text('id').primaryKey().notNull(),
    skill: text('skill').notNull(),
    content: text('content').notNull(),
    confidence: doublePrecision('confidence').notNull().default(0),
    sanitized: boolean('sanitized').notNull().default(false),
    sourceType: text('source_type').notNull().default('episodic'),
    retryCount: integer('retry_count'),
    durationMs: integer('duration_ms'),
    memoryActive: boolean('memory_active').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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
export const backlogActivities = pgTable(
  'backlog_activities',
  {
    id: text('id').primaryKey().notNull(),
    demandId: integer('demand_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('em_desenvolvimento'),
    hasPrd: boolean('has_prd').notNull().default(false),
    hasTasks: boolean('has_tasks').notNull().default(false),
    hasChat: boolean('has_chat').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    demandIdx: uniqueIndex('backlog_activities_demand_idx').on(table.demandId),
  }),
);

// --- chunk_embeddings (migrations/0014_rag_improvements.sql, line 15) ---
// pgvector table: native UUID + vector(3072) types.
export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    embedding: vector('embedding', { dimensions: 3072 }).notNull(),
    createdAt: timestamp('created_at').defaultNow(),
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
export const ragFeedback = pgTable(
  'rag_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryId: text('query_id').notNull(),
    queryText: text('query_text').notNull(),
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    wasHelpful: boolean('was_helpful').notNull(),
    selectedByUser: boolean('selected_by_user').default(false),
    feedbackType: text('feedback_type').default('implicit'),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    chunkIdx: index('idx_rag_feedback_chunk').on(table.chunkId),
    queryIdx: index('idx_rag_feedback_query').on(table.queryId),
  }),
);

// --- chunk_relevance_scores (migrations/0014_rag_improvements.sql, line 76) ---
export const chunkRelevanceScores = pgTable(
  'chunk_relevance_scores',
  {
    chunkId: text('chunk_id').notNull(),
    chunkSource: text('chunk_source').notNull().default('comex_cambio'),
    totalShown: integer('total_shown').default(0),
    totalHelpful: integer('total_helpful').default(0),
    totalSelected: integer('total_selected').default(0),
    successRate: doublePrecision('success_rate').default(0.0),
    boostFactor: doublePrecision('boost_factor').default(1.0),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chunkId, table.chunkSource] }),
  }),
);

// --- safety_logs (migrations/0013_expand_guardrails_safety.sql, line 8) ---
export const safetyLogs = pgTable(
  'safety_logs',
  {
    id: serial('id').primaryKey(),
    timestamp: integer('timestamp')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
    action: text('action').notNull(),
    confidence: text('confidence').notNull(),
    originalTextHash: text('original_text_hash'),
    userId: text('user_id'),
    demandId: integer('demand_id'),
    detections: jsonb('detections').$type<unknown[]>().notNull().default([]),
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
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: serial('id').primaryKey(),
    promptName: text('prompt_name').notNull(),
    version: text('version').notNull(),
    content: text('content').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
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
export const promptAbTests = pgTable(
  'prompt_ab_tests',
  {
    id: serial('id').primaryKey(),
    promptName: text('prompt_name').notNull(),
    versionA: text('version_a').notNull(),
    versionB: text('version_b').notNull(),
    trafficPercentB: integer('traffic_percent_b').notNull().default(50),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
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
export const promptVersionMetrics = pgTable(
  'prompt_version_metrics',
  {
    id: serial('id').primaryKey(),
    promptName: text('prompt_name').notNull(),
    version: text('version').notNull(),
    sessionId: text('session_id'),
    demandId: integer('demand_id'),
    /** A08: usada por prompt-version.ts (INSERT/SELECT); faltava na declaração. */
    model: text('model'),
    successFlag: boolean('success_flag').notNull(),
    latencyMs: integer('latency_ms'),
    abTestId: integer('ab_test_id').references(() => promptAbTests.id),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
  },
  (table) => ({
    nameVersionIdx: index('idx_prompt_metrics_name_version').on(table.promptName, table.version),
    abTestIdx: index('idx_prompt_metrics_ab_test').on(table.abTestId),
    createdIdx: index('idx_prompt_metrics_created').on(table.createdAt),
  }),
);

// --- guardrail_logs (migrations/0011_add_guardrail_logs.sql, line 4) ---
export const guardrailLogs = pgTable(
  'guardrail_logs',
  {
    id: serial('id').primaryKey(),
    timestamp: integer('timestamp')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
    guardrailType: text('guardrail_type').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    inputHash: text('input_hash').notNull(),
    detections: jsonb('detections').$type<unknown[]>().notNull().default([]),
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
export const llmAuditLogs = pgTable(
  'llm_audit_logs',
  {
    id: serial('id').primaryKey(),
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
    estimatedCostUsd: doublePrecision('estimated_cost_usd'),
    duimpId: text('duimp_id'),
    contractId: text('contract_id'),
    ncm: text('ncm'),
    iofFlag: boolean('iof_flag').default(false),
    domain: text('domain').default('geral'),
    demandId: integer('demand_id'),
    feedback: text('feedback'),
    feedbackComment: text('feedback_comment'),
    feedbackAt: integer('feedback_at'),
    // Demanda #10364 (Fatia 2A) — correlação de custo de IA por usuário da plataforma.
    platformUserId: integer('platform_user_id'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int`),
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

// Spec 10192: Drizzle relations para joins tipados.
export const demandsRelations = relations(demands, ({ many }) => ({
  files: many(files),
}));

export const filesRelations = relations(files, ({ one }) => ({
  demand: one(demands, { fields: [files.demandId], references: [demands.id] }),
}));

// --- dead_letters (Spec 10240 M-2): event bus dead-letter queue ---
export const deadLetters = pgTable(
  'dead_letters',
  {
    id: serial('id').primaryKey(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    errorMessage: text('error_message').notNull(),
    errorStack: text('error_stack'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    eventTypeIdx: index('idx_dead_letters_event_type').on(table.eventType),
    createdAtIdx: index('idx_dead_letters_created_at').on(table.createdAt),
    eventIdIdx: index('idx_dead_letters_event_id').on(table.eventId),
  }),
);

export type DeadLetter = typeof deadLetters.$inferSelect;
export type InsertDeadLetter = typeof deadLetters.$inferInsert;

// --- dlq_messages (migrations-pg/0052_add_dlq_messages.sql) ---
export const dlqMessages = pgTable(
  'dlq_messages',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id').notNull(),
    queueName: text('queue_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    stackTrace: text('stack_trace').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    failedAt: timestamp('failed_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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
export const agentFailures = pgTable(
  'agent_failures',
  {
    id: serial('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    executionId: text('execution_id').notNull(),
    errorCategory: text('error_category').notNull(),
    errorMessage: text('error_message').notNull(),
    stackShort: text('stack_short'),
    delayApplied: integer('delay_applied').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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
// Mirror de shared/schema.ts — ver comentário lá para o contexto completo.
// =============================================================================

export const platformUsers = pgTable('platform_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  sessionNonce: text('session_nonce'),
  plan: text('plan').notNull().default('free'),
  // Demanda #10367 (Fatia 2D) — soft delete + admin
  isActive: boolean('is_active').notNull().default(true),
  deletedAt: timestamp('deleted_at'),
  admin: boolean('admin').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type PlatformUser = typeof platformUsers.$inferSelect;
export type InsertPlatformUser = typeof platformUsers.$inferInsert;

export const waitlist = pgTable('waitlist', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  source: text('source').default('landing'),
});

export type WaitlistEntry = typeof waitlist.$inferSelect;
export type InsertWaitlistEntry = typeof waitlist.$inferInsert;

export const gitConnections = pgTable(
  'git_connections',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['github'] })
      .notNull()
      .default('github'),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    githubUsername: text('github_username'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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

export const usageCounters = pgTable(
  'usage_counters',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    refinementsCount: integer('refinements_count').notNull().default(0),
    connectedRepos: integer('connected_repos').notNull().default(0),
  },
  (table) => ({
    userPeriodIdx: uniqueIndex('idx_usage_counters_user_period').on(table.userId, table.period),
  }),
);

export type UsageCounter = typeof usageCounters.$inferSelect;
export type InsertUsageCounter = typeof usageCounters.$inferInsert;

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userEventIdx: index('idx_analytics_events_user_event').on(table.userId, table.eventType),
  }),
);

export type PlatformAnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type InsertPlatformAnalyticsEvent = typeof analyticsEvents.$inferInsert;

// --- subscriptions: estado canônico de assinatura Paddle (Fatia 2A, #10364) ---
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('pro'),
    status: text('status').notNull().default('active'),
    paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
    paddleCustomerId: text('paddle_customer_id'),
    currentPeriodEnd: timestamp('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    paddleIdx: uniqueIndex('idx_subscriptions_paddle_id').on(table.paddleSubscriptionId),
    userIdx: index('idx_subscriptions_user_id').on(table.userId),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;

// --- db_connections: conexões de banco do usuário (Fatia 2B, #10365) ---
export const dbConnections = pgTable(
  'db_connections',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => platformUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    dbType: text('db_type').notNull(),
    host: text('host').notNull(),
    port: integer('port'),
    databaseName: text('database_name'),
    username: text('username'),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userNameIdx: uniqueIndex('idx_db_connections_user_name').on(table.userId, table.name),
    userIdx: index('idx_db_connections_user_id').on(table.userId),
  }),
);

export type DbConnection = typeof dbConnections.$inferSelect;
export type InsertDbConnection = typeof dbConnections.$inferInsert;

// --- preview_cache: cache 24h de previews automáticos (Fatia 2C, #10366) ---
export const previewCache = pgTable('preview_cache', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  result: text('result').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type PreviewCache = typeof previewCache.$inferSelect;
export type InsertPreviewCache = typeof previewCache.$inferInsert;

// --- preview_jobs: jobs assíncronos de preview (Fatia 2C, #10366) ---
export const previewJobs = pgTable('preview_jobs', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().unique(),
  userId: integer('user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  status: text('status').notNull().default('pending'),
  result: text('result'),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type PreviewJob = typeof previewJobs.$inferSelect;
export type InsertPreviewJob = typeof previewJobs.$inferInsert;
