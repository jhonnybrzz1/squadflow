/**
 * Unified schema selector — picks SQLite or Postgres tables at runtime.
 *
 * Usage: import tables from this file when issuing Drizzle queries.
 * Tipos canônicos (Demand, User, etc.) continuam em schema.ts.
 *
 * Strategy:
 * - schema.ts é a fonte da verdade tipada (sqliteTable, $inferSelect)
 * - schema-pg.ts espelha em pgTable
 * - schema-unified.ts re-exporta as tabelas ativas em runtime
 *
 * Os shapes das tabelas são idênticos (mesmas colunas, mesmos tipos lógicos),
 * então castamos para os tipos canônicos de schema.ts via `as typeof ...`.
 */

import * as schemaSqlite from './schema';
import * as schemaPg from './schema-pg';
import { resolveDatabasePolicy } from './database-policy';

// Spec 016 B1 (M-08): o schema ativo deriva da MESMA política que o adapter
// e o storage — uma configuração contraditória lança aqui, antes de qualquer
// query, em vez de combinar schema e banco incompatíveis.
export const IS_POSTGRES = resolveDatabasePolicy().dialect === 'postgres';

const active = IS_POSTGRES ? schemaPg : schemaSqlite;

// Re-export tables with canonical (SQLite) types — runtime points to active dialect
export const demands = active.demands as typeof schemaSqlite.demands;
export const documentSnapshots = active.documentSnapshots as typeof schemaSqlite.documentSnapshots;
export const approvalComments = active.approvalComments as typeof schemaSqlite.approvalComments;
export const documentLifecycleEvents =
  active.documentLifecycleEvents as typeof schemaSqlite.documentLifecycleEvents;
export const operationAttempts = active.operationAttempts as typeof schemaSqlite.operationAttempts;
export const modelRoutingStageRuns =
  active.modelRoutingStageRuns as typeof schemaSqlite.modelRoutingStageRuns;
export const agentDecisionRecords =
  active.agentDecisionRecords as typeof schemaSqlite.agentDecisionRecords;
export const domainExecutionRecords =
  active.domainExecutionRecords as typeof schemaSqlite.domainExecutionRecords;
export const progressiveRefinementRecords =
  active.progressiveRefinementRecords as typeof schemaSqlite.progressiveRefinementRecords;
export const repos = active.repos as typeof schemaSqlite.repos;
export const repoFiles = active.repoFiles as typeof schemaSqlite.repoFiles;
export const files = active.files as typeof schemaSqlite.files;
export const users = active.users as typeof schemaSqlite.users;
export const telemetry = active.telemetry as typeof schemaSqlite.telemetry;
export const humanFeedback = active.humanFeedback as typeof schemaSqlite.humanFeedback;
export const clientErrors = active.clientErrors as typeof schemaSqlite.clientErrors;
export const idempotencyRecords =
  active.idempotencyRecords as typeof schemaSqlite.idempotencyRecords;

// Feedback e intervenções de agentes
export const feedbackRefinamento =
  active.feedbackRefinamento as typeof schemaSqlite.feedbackRefinamento;
export const agentInterventions =
  active.agentInterventions as typeof schemaSqlite.agentInterventions;

// Data Retention Policies
export const retentionPolicies = active.retentionPolicies as typeof schemaSqlite.retentionPolicies;
export const retentionJobLogs = active.retentionJobLogs as typeof schemaSqlite.retentionJobLogs;

// Orchestration Runtime Persistence
export const orchestrationRuns = active.orchestrationRuns as typeof schemaSqlite.orchestrationRuns;
export const agentTurns = active.agentTurns as typeof schemaSqlite.agentTurns;
export const agentToolCalls = active.agentToolCalls as typeof schemaSqlite.agentToolCalls;
export const orchestrationEvents =
  active.orchestrationEvents as typeof schemaSqlite.orchestrationEvents;

// Model Registry — dynamic model discovery & promotion
// The canonical cast carries lastRollbackAt from both dialect definitions;
// schema parity is verified by the migration losslessness suite.
export const modelAliases = active.modelAliases as typeof schemaSqlite.modelAliases;
export const modelCandidates = active.modelCandidates as typeof schemaSqlite.modelCandidates;
export const modelHistory = active.modelHistory as typeof schemaSqlite.modelHistory;
// Includes isCurrent/operationToken/leaseExpiresAt in both dialects.
export const demandExternalDocs =
  active.demandExternalDocs as typeof schemaSqlite.demandExternalDocs;

// Job queue / session tables
export const documentJobs = active.documentJobs as typeof schemaSqlite.documentJobs;
export const agentJobs = active.agentJobs as typeof schemaSqlite.agentJobs;
export const codeAgentJobQueue = active.codeAgentJobQueue as typeof schemaSqlite.codeAgentJobQueue;
export const retrospectiveSessions =
  active.retrospectiveSessions as typeof schemaSqlite.retrospectiveSessions;
export const refinementExecutions =
  active.refinementExecutions as typeof schemaSqlite.refinementExecutions;

// Retrospective & memory
export const retrospectives = active.retrospectives as typeof schemaSqlite.retrospectives;
export const retroActions = active.retroActions as typeof schemaSqlite.retroActions;
export const agentMemory = active.agentMemory as typeof schemaSqlite.agentMemory;
export const episodicMemory = active.episodicMemory as typeof schemaSqlite.episodicMemory;
export const pmFrameworks = active.pmFrameworks as typeof schemaSqlite.pmFrameworks;
export const backlogActivities = active.backlogActivities as typeof schemaSqlite.backlogActivities;

// RAG feedback / embeddings
export const chunkEmbeddings = active.chunkEmbeddings as typeof schemaSqlite.chunkEmbeddings;
export const ragFeedback = active.ragFeedback as typeof schemaSqlite.ragFeedback;
export const chunkRelevanceScores =
  active.chunkRelevanceScores as typeof schemaSqlite.chunkRelevanceScores;

// Audit / observability
export const safetyLogs = active.safetyLogs as typeof schemaSqlite.safetyLogs;
export const promptVersions = active.promptVersions as typeof schemaSqlite.promptVersions;
export const promptAbTests = active.promptAbTests as typeof schemaSqlite.promptAbTests;
export const promptVersionMetrics =
  active.promptVersionMetrics as typeof schemaSqlite.promptVersionMetrics;
export const guardrailLogs = active.guardrailLogs as typeof schemaSqlite.guardrailLogs;
export const llmAuditLogs = active.llmAuditLogs as typeof schemaSqlite.llmAuditLogs;

// Document artifacts
export const artifacts = active.artifacts as typeof schemaSqlite.artifacts;

// Demanda #10358 — Plataforma Online do Aichatflow para Vibe Coders (Fatia 1)
export const platformUsers = active.platformUsers as typeof schemaSqlite.platformUsers;
export const waitlist = active.waitlist as typeof schemaSqlite.waitlist;
export const gitConnections = active.gitConnections as typeof schemaSqlite.gitConnections;
export const usageCounters = active.usageCounters as typeof schemaSqlite.usageCounters;
export const analyticsEvents = active.analyticsEvents as typeof schemaSqlite.analyticsEvents;

// Demanda #10364 — Fatia 2A: Sistema de Pagamento e Plano Pro (Paddle)
export const subscriptions = active.subscriptions as typeof schemaSqlite.subscriptions;

// Demanda #10365 — Fatia 2B: Acesso a Bases de Dados do Usuário
export const dbConnections = active.dbConnections as typeof schemaSqlite.dbConnections;

// Demanda #10366 — Fatia 2C: Preview Automático de Refinamento
export const previewCache = active.previewCache as typeof schemaSqlite.previewCache;
export const previewJobs = active.previewJobs as typeof schemaSqlite.previewJobs;

// Re-export the bundle (used by drizzle({ schema })) — returns the correct dialect's schema
export const activeSchema = IS_POSTGRES
  ? (schemaPg as unknown as typeof schemaSqlite)
  : schemaSqlite;
