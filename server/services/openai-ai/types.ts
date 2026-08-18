/**
 * Demanda 10209 — tipos públicos do módulo openai-ai.
 */
import type { ZodSchema } from 'zod';
import type { AIProvider } from '../llm-client-manager';
import type { AITaskType } from '../llm-model-router';
import type { RoutingMode } from '../ai-usage-tracker';

export type AIChatRole = 'system' | 'developer' | 'user' | 'assistant';

export interface AIChatMessage {
  role: AIChatRole;
  content: string;
  name?: string;
}

export interface GenerateOptions<T = unknown> {
  model?: string;
  provider?: AIProvider;
  temperature?: number;
  maxTokens?: number;
  cache?: boolean;
  cacheTtlMs?: number;
  /**
   * Quando true, desabilita o cache semântico (embedding similarity) mesmo que
   * `cache` seja true. Aplica-se ao moderador e à consolidação do roundtable,
   * onde respostas estruturadas/JSON não devem retornar hits semânticos stale.
   */
  semanticCacheDisabled?: boolean;
  taskType?: AITaskType;
  operation?: string;
  agentName?: string;
  agentVersion?: string;
  /** M-2: identificador do agente, formato 'agent:nome-agente'. */
  agentId?: string;
  /** M-2: etapa do pipeline (ex.: 'enrichment'). */
  stage?: string;
  demandId?: number;
  /** Descrição da demanda, usada como contexto na classificação de tarefas. */
  demandDescription?: string;
  responseFormat?: 'text' | 'json_object';
  schema?: ZodSchema<T>;
  summaryMemory?: string;
  maxHistoryTurns?: number;
  maxConcurrency?: number;
  retryAttempts?: number;
  /** Delay base (ms) entre tentativas de retry. Padrão 350 ms. */
  retryDelayMs?: number;
  cacheContext?: Record<string, unknown>;
  /** Spec 10126: timeout por chamada (ms). */
  timeoutMs?: number;
  modelFallback?: string;
  /**
   * Spec 012 (FR-009): marca a operação como sensível — quando os guardrails
   * estiverem indisponíveis, a política fail-closed bloqueia em vez de seguir.
   */
  sensitiveOperation?: boolean;
  /**
   * Spec 10064: entrada é DADO de autoria do próprio usuário (ex.: rascunho do
   * botão Reformular). Rebaixa o BLOQUEIO de injection para shadow (loga, não
   * bloqueia); PII e fail-closed continuam. Não usar em fluxos de agentes/RAG.
   */
  injectionShadow?: boolean;
  /**
   * Bug #10224: pula a checagem de prompt injection (regex + classificador
   * semântico) inteiramente para este conteúdo. Uso restrito a fluxos internos
   * da squad (roundtable, geração de PRD/tasks) que re-circulam conteúdo já
   * ingerido — não usar para input humano ao vivo nem conteúdo de fontes
   * externas não confiáveis. PII masking e fail-closed continuam ativos.
   */
  skipInjectionCheck?: boolean;
  /**
   * Permite seguir quando o pipeline de guardrails estiver indisponível.
   * Detecções reais continuam bloqueando; isto cobre só erro/timeout/JSON inválido.
   */
  failOpenOnError?: boolean;
  /**
   * Auditoria 2026-08-03: quando o provider devolve `finish_reason: 'length'`,
   * a resposta foi CORTADA no teto de `maxTokens` — não terminou. Para chat
   * isso é tolerável; para um documento (PRD/Tasks/TDD) significa entregar um
   * artefato incompleto como se estivesse pronto. Com esta flag, truncamento
   * vira erro em vez de passar silenciosamente.
   */
  failOnTruncation?: boolean;
}

export interface ChatCompletionMetadata {
  modelUsed: string;
  provider: AIProvider;
  originalModel: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  semanticCacheHit?: boolean;
  semanticSimilarity?: number;
  routingMode: RoutingMode;
  routingReason: string | null;
  cacheHit: boolean;
  promptTokens?: number;
  completionTokens?: number;
  costEstimate?: number;
  agentName?: string;
  agentVersion?: string;
}

export interface ChatCompletionWithMetadata {
  content: string;
  metadata: ChatCompletionMetadata;
}
