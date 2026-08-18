import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import { z, type ZodSchema } from 'zod';
import { aiResponseCache, DEFAULT_CACHE_KEY_VERSION } from '../ai-cache';
import {
  aiUsageTracker,
  estimateCost,
  estimateTextTokens,
  type RoutingMode,
} from '../ai-usage-tracker';
import { circuitBreaker } from '../circuit-breaker';
import { logger } from '../../utils/logger';
import {
  aiCallDuration,
  aiFirstTokenDuration,
  aiTokensUsage,
  llmPromptCacheTokens,
} from '../../metrics';
import { metricsCollector } from '../../metrics/collector';
import { validateModelAllowed, ModelGovernanceError } from '../model-governance';
import { generateRequestId } from '../../utils/request-id';
import { decideRoutingModel, type RoutingDecision } from '../cost-routing';
import { requestTelemetryService } from '../request-telemetry';
import { classifyTaskType } from '../task-classifier';
import { llmAuditLogService } from '../llm-audit-log';
import { applyGuardrails } from './guardrails';
import {
  generateEmbedding as generateEmbeddingModule,
  generateEmbeddings as generateEmbeddingsModule,
  isUsingLocalEmbeddings as isUsingLocalEmbeddingsModule,
  isUsingLocalEmbeddingsForRAG as isUsingLocalEmbeddingsForRAGModule,
} from './embeddings';
import { llmClientManager, type AIProvider } from '../llm-client-manager';
import { ResponseTruncatedError } from './errors';

import { computeContextFingerprint, semanticCacheService } from '../semantic-cache';

import {
  resolveModel,
  resolveProvider,
  normalizeModelForProvider,
  prepareProviderMessages,
  resolveMaxTokens,
  OPENROUTER_FALLBACK_MODEL,
  OPENROUTER_PRIMARY_MODEL,
  getModelConfig,
  cleanReasoningPrompt,
  DEFAULT_MAX_COMPLETION_TOKENS,
} from '../llm-model-router';
import {
  prepareMessages,
  estimateMessagesTokens,
  canonicalizeMessages,
  canonicalizeCacheValue,
} from '../llm-message-preparer';
import { startTracing, endTracing, tryResponseCache, trySemanticCache } from '../llm-observability';
import { getPromptHash } from '../system-prompts';
import { errorHandlingManager } from '../llm-error-handling-operations';
import { fallbackManager, routingManager } from '../llm-routing';
import {
  createChatCompletionWithRetry,
  type CompletionContext,
  createFallbackBudget,
  createRequestBudget,
  disposeRequestBudget,
  isQualityFailure,
} from './retry';
import { llmFallbackCounter } from '../../metrics';
import { applyAgentModelPolicy } from '../ai-model-policy';
import { dispatchLogger } from '../dispatch-logger';
import {
  applyModelRegistryOverride,
  recordModelFailureForRollback,
} from '../model-registry-bridge';
import { validateJSONContent, resolveConcurrency, mapWithConcurrency } from '../llm-utils';
import {
  type AIChatMessage,
  type GenerateOptions,
  type ChatCompletionMetadata,
  type ChatCompletionWithMetadata,
} from './types';
export {
  type AIChatMessage,
  type AIChatRole,
  type GenerateOptions,
  type ChatCompletionMetadata,
  type ChatCompletionWithMetadata,
} from './types';

const jsonObjectSchema = z.record(z.unknown());

/**
 * Teto do retry de JSON truncado. Impede que quadruplicar o orçamento vire um
 * pedido ilimitado quando o chamador já pediu um teto alto.
 */
const JSON_RETRY_TOKEN_CAP = 8000;

/**
 * Auditoria 2026-08-04: prazo wall-clock proporcional ao teto de saída pedido.
 *
 * Medido no `llm_audit_logs` deste repo: gerações de `document:tasks` com teto
 * de 2000 levaram de 29s a 90s — ou seja, até ~45ms por token de saída. Com
 * 60ms/token há folga sobre o pior caso observado sem abrir mão do teto.
 */
const REQUEST_BUDGET_MS_PER_TOKEN = 60;

/** Nenhum pedido, por maior que seja, passa disto. */
const REQUEST_BUDGET_MAX_MS = 300_000;

export function resolveRequestBudgetMs(
  maxTokens: number,
  defaults: { globalMs?: number; stageMs?: number } = {},
): { globalMs: number; stageMs: number } {
  const defaultGlobal = defaults.globalMs ?? Number(process.env.REQUEST_BUDGET_MS ?? 120_000);
  const defaultStage = defaults.stageMs ?? Number(process.env.REQUEST_STAGE_BUDGET_MS ?? 60_000);

  // Uma tentativa precisa caber num ESTÁGIO; o global tem que comportar a
  // tentativa mais um fallback. Escalar só o global não adiantaria: o estágio
  // é capado à parte, e era ele que abortava a geração no meio.
  const perAttempt = maxTokens * REQUEST_BUDGET_MS_PER_TOKEN;
  const stageMs = Math.min(Math.max(defaultStage, perAttempt), REQUEST_BUDGET_MAX_MS);
  const globalMs = Math.min(Math.max(defaultGlobal, stageMs * 2), REQUEST_BUDGET_MAX_MS);

  return { globalMs, stageMs };
}

export class OpenAIService {
  constructor() {
    // Client initialization moved to llmClientManager
    // Fallback management lives in the consolidated llm-routing policy surface.
  }

  private getClient(provider: AIProvider): OpenAI {
    return llmClientManager.getClient(provider);
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions<string> = {},
  ): Promise<string> {
    return this.generateChatCompletionWithMessages(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options,
    );
  }

  async generateChatCompletionWithMetadata(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions<string> = {},
  ): Promise<ChatCompletionWithMetadata> {
    return this.generateChatCompletionWithMessagesAndMetadata(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options,
    );
  }

  async generateChatCompletionWithMessages(
    messages: AIChatMessage[],
    options: GenerateOptions<string> = {},
  ): Promise<string> {
    const result = await this.generateChatCompletionWithMessagesAndMetadata(messages, options);
    return result.content;
  }

  async generateChatCompletionWithMessagesAndMetadata(
    messages: AIChatMessage[],
    options: GenerateOptions<string> = {},
  ): Promise<ChatCompletionWithMetadata> {
    const startedAt = Date.now();
    const requestId = generateRequestId();

    options = applyAgentModelPolicy(options);

    // Model Registry integration (CRIT-01): resolve the hardcoded default
    // model/fallback through the registry so promote/rollback actually
    // change what the chat uses. No-op pass-through when the registry is
    // disabled or the ids are not bound to a known family.
    const registryOverride = await applyModelRegistryOverride(options);
    options = registryOverride.options;
    const registryAlias = registryOverride.primaryAlias;
    const registryFallbackAlias = registryOverride.fallbackAlias;
    // Kept separate from `options.provider` on purpose — see
    // applyModelRegistryOverride's docstring. Never let the primary model's
    // provider leak into resolving the fallback model's provider (and vice
    // versa): they can legitimately belong to different providers.
    const registryPrimaryProvider = registryOverride.primaryProvider as AIProvider | undefined;
    const registryFallbackProvider = registryOverride.fallbackProvider as AIProvider | undefined;

    let model = resolveModel(options);
    let provider = resolveProvider(model, options.provider ?? registryPrimaryProvider);
    const originalModel = model;

    // Guards double-counting the same request toward auto-rollback: the
    // primary-attempt catch records failures immediately (so fallback
    // recovery doesn't mask degradation), the outer catch only records when
    // that didn't already happen (e.g. the error never reached the primary
    // inference attempt).
    let registryFailureRecorded = false;

    // Cost optimization telemetry initialization
    let routingMode: RoutingMode = 'unknown';
    let routingReason: string | null = null;
    let fallbackUsed = false;
    let fallbackReason: string | null = null;
    const cacheKeyVersion = process.env.CACHE_KEY_VERSION || DEFAULT_CACHE_KEY_VERSION;
    const agentNameLabel = options.agentName || 'unknown';
    const agentVersionLabel = options.agentVersion || 'unknown';

    // isQualityFailure extraído para retry.ts (P3).

    // Prepare messages early for token estimation
    let preparedMessages = prepareMessages(messages, options);

    // Security Guardrails: check user messages for injection/PII before LLM
    // (regex/PII síncrono + camada semântica shadow async, atrás de flag)
    preparedMessages = await applyGuardrails({
      messages: preparedMessages,
      options,
      requestId,
    });

    const estimatedPromptTokens = estimateMessagesTokens(preparedMessages);

    // Apply cost routing if not explicitly overridden
    if (!options.model) {
      // [MA-2] Passa taskType para routing adaptativo: classification/json/simple → sempre econômico
      const routingDecision: RoutingDecision = decideRoutingModel(
        estimatedPromptTokens,
        options.taskType,
      );
      routingMode = routingDecision.mode;
      routingReason = routingDecision.reason;
      model = routingDecision.model;
      provider = resolveProvider(model, options.provider);

      // M4: log dispatch (LOG 2) — routing_output vs modelo realmente selecionado.
      const specForHash = preparedMessages.map((m) => `${m.role}: ${m.content}`).join('\n');
      dispatchLogger.logDispatch(
        specForHash,
        options.taskType ?? options.operation ?? 'unknown',
        model,
      );

      logger.info('Cost routing applied', {
        context: {
          requestId,
          estimatedTokens: estimatedPromptTokens,
          taskType: options.taskType ?? 'unspecified',
          routingMode,
          routingReason,
          selectedModel: model,
          threshold: routingDecision.threshold,
        },
      });
    }

    // Dynamic Fallback: prefer OpenRouter free when configured, then OpenAI if still available.
    const routingResult = routingManager.applyDynamicFallback({
      model,
      provider,
      originalModel,
      requestId,
    });
    model = routingResult.model;
    provider = routingResult.provider;

    model = routingManager.normalizeForProvider(model, provider);

    // Governança de modelos: Fail-fast se o modelo não for permitido
    // Se o modelo primário não for permitido mas existe fallback, tenta o fallback
    try {
      routingManager.validateModel(
        model,
        options.agentName || 'unknown_agent',
        options.operation || 'openai-ai.generate',
        registryAlias,
      );
    } catch (govError) {
      if (
        govError instanceof ModelGovernanceError &&
        options.modelFallback &&
        options.modelFallback !== model
      ) {
        logger.warn('Primary model not allowed by governance, switching to fallback', {
          context: {
            requestId,
            rejectedModel: model,
            fallbackModel: options.modelFallback,
            agent: options.agentName || 'unknown_agent',
          },
        });
        fallbackUsed = true;
        fallbackReason = `governance_rejected:${model}`;
        llmFallbackCounter.inc({
          level: 'governance',
          from_model: originalModel,
          to_model: options.modelFallback,
          agent_name: agentNameLabel,
          agent_version: agentVersionLabel,
        });
        model = options.modelFallback;
        provider = resolveProvider(model, options.provider ?? registryFallbackProvider);
        model = routingManager.normalizeForProvider(model, provider);
        // Validate the fallback model — if this also fails, let it throw
        routingManager.validateModel(
          model,
          options.agentName || 'unknown_agent',
          options.operation || 'openai-ai.generate.governance_fallback',
          registryFallbackAlias,
        );
      } else {
        throw govError;
      }
    }

    const client = this.getClient(provider);

    // Ajuste para Modelos de Raciocínio (Reasoning)
    const modelConfig = getModelConfig(model);
    if (modelConfig.behavior === 'reasoning') {
      preparedMessages = preparedMessages.map((msg) => ({
        ...msg,
        content: cleanReasoningPrompt(msg.content),
      }));
    }

    let temperature = options.temperature;
    if (modelConfig.behavior === 'reasoning') {
      if (temperature === undefined || temperature > 0.3) {
        temperature = modelConfig.defaultTemperature ?? 0.2;
      }
    }

    const responseFormat = options.responseFormat || 'text';
    const operation = options.operation || options.taskType || 'chat_completion';
    const maxTokens = resolveMaxTokens(options);

    // Spec 10259 T5: carrega o hash do system prompt externo (se existir) para
    // incluir na cache key. Mudanças no arquivo invalidam cache sem depender do
    // conteúdo renderizado por request.
    const promptHash = options.agentName ? getPromptHash(options.agentName) : null;

    const cacheKey = aiResponseCache.createKey({
      model: `${provider}:${model}`,
      messages: canonicalizeMessages(preparedMessages),
      temperature: temperature ?? null,
      maxTokens,
      responseFormat,
      operation,
      cacheContext: canonicalizeCacheValue(options.cacheContext || null),
      // H-12: include agentName and demandId in the cache key so that the same
      // prompt from different agents or different demands doesn't share a
      // cached response. Without this, agent A's response could be served to
      // agent B, or demand X's result to demand Y — cross-contamination that
      // produces wrong answers when agents have different roles or demands
      // have different contexts not captured in the message payload alone.
      agentName: options.agentName ?? null,
      demandId: options.demandId ?? null,
      // Spec 10259 T5: promptHash (SHA-256 do bruto) invalida cache quando o
      // system prompt externo muda.
      promptHash,
    });

    if (options.cache !== false) {
      const cacheResult = await tryResponseCache(cacheKey, preparedMessages, {
        model,
        provider,
        messages: canonicalizeMessages(preparedMessages),
        temperature,
        maxTokens,
        responseFormat,
        operation,
        cacheContext: options.cacheContext,
        demandId: options.demandId,
        requestId,
        routingMode,
        routingReason,
        cacheKeyVersion,
        originalModel,
        startedAt,
        promptHash,
        agentId: options.agentId,
        stage: options.stage,
      });

      if (cacheResult) {
        return {
          content: cacheResult.content,
          metadata: {
            ...cacheResult.metadata,
            fallbackUsed,
            fallbackReason,
          } as ChatCompletionMetadata,
        };
      }
    }

    // ── Semantic cache lookup (embedding similarity) ──
    // Ignorado quando semanticCacheDisabled=true (ex: moderador, consolidação do roundtable).
    if (options.cache !== false && responseFormat === 'text' && !options.semanticCacheDisabled) {
      const semanticResult = await trySemanticCache(preparedMessages, {
        model,
        provider,
        messages: canonicalizeMessages(preparedMessages),
        temperature,
        maxTokens,
        responseFormat,
        operation,
        cacheContext: options.cacheContext,
        demandId: options.demandId,
        requestId,
        routingMode,
        routingReason,
        cacheKeyVersion,
        originalModel,
        startedAt,
        promptHash,
        agentId: options.agentId,
        stage: options.stage,
      });

      if (semanticResult) {
        return {
          content: semanticResult.content,
          metadata: {
            ...semanticResult.metadata,
            fallbackUsed,
            fallbackReason,
          } as ChatCompletionMetadata,
        };
      }
    }

    // O timer nasce somente quando a inferência realmente começa. Cache hits e
    // bloqueios de guardrail não deixam timers pendurados no processo.
    //
    // Auditoria 2026-08-04: o budget era sempre o default de 120s, independente
    // de quantos tokens de saída o chamador pediu — as duas coisas são
    // acopladas e ninguém tratava assim. Subir o teto de `document:tasks` de
    // 2000 para 4000 fez a geração passar de ~40s para além dos 120s: três
    // tentativas seguidas abortaram em 120.0s com ZERO tokens devolvidos, e a
    // demanda entrou em cooldown por falha repetida. Trocar "trunca e entrega"
    // por "estoura o prazo e não entrega" não é conserto.
    //
    // O piso continua sendo o default do env, então nada abaixo de ~2000 tokens
    // muda de comportamento; só pedidos grandes ganham prazo proporcional. O
    // teto absoluto preserva a premissa do módulo: nenhuma cascata ilimitada.
    const budgetWindows = resolveRequestBudgetMs(maxTokens);
    let budget = createRequestBudget(budgetWindows.globalMs, undefined, budgetWindows.stageMs);
    const initialFallbackLevel: CompletionContext['fallbackLevel'] = fallbackReason?.startsWith(
      'governance',
    )
      ? 'governance'
      : 'primary';
    if (initialFallbackLevel === 'governance') {
      budget = createFallbackBudget(budget, 'governance');
    }

    const executeModelFallback = async (
      stage: 'explicit' | 'economic',
      fallbackClient: OpenAI,
      payload: Record<string, unknown>,
      context: Omit<CompletionContext, 'budget' | 'fallbackLevel'>,
    ) => {
      const fallbackBudget = createFallbackBudget(budget, stage);
      try {
        return await createChatCompletionWithRetry(fallbackClient, payload, {
          ...context,
          budget: fallbackBudget,
          fallbackLevel: stage,
        });
      } finally {
        disposeRequestBudget(fallbackBudget);
      }
    };

    // ── Start LLM tracing span ──
    const tracingContext = startTracing({
      operation,
      model: `${provider}:${model}`,
      provider,
      agentName: options.agentName,
      demandId: options.demandId,
      requestId,
      input: {
        messageCount: preparedMessages.length,
        lastUserMessage: preparedMessages
          .filter((m) => m.role === 'user')
          .pop()
          ?.content?.slice(0, 200),
      },
    });

    try {
      const requestPayload: Record<string, unknown> = {
        model,
        messages: prepareProviderMessages(preparedMessages, provider),
      };

      if (temperature !== undefined) {
        requestPayload.temperature = temperature;
      }

      if (maxTokens) {
        if (provider === 'openai') {
          requestPayload.max_completion_tokens = maxTokens;
        } else {
          requestPayload.max_tokens = maxTokens;
        }
      }

      if (responseFormat === 'json_object') {
        requestPayload.response_format = { type: 'json_object' };
      }

      let response;
      let content = '';
      let usage;
      // Auditoria 2026-08-03: `finish_reason` era lido por ninguém. Uma resposta
      // cortada no teto de maxTokens chegava indistinguível de uma completa.
      let finishReason: string | null | undefined;

      // Attempt with chosen model
      try {
        response = (await createChatCompletionWithRetry(client, requestPayload, {
          operation,
          model,
          provider,
          retryAttempts: options.retryAttempts,
          retryDelayMs: options.retryDelayMs,
          timeoutMs: options.timeoutMs,
          budget,
          fallbackLevel: initialFallbackLevel,
        })) as OpenAI.Chat.Completions.ChatCompletion;
        content = response.choices[0]?.message?.content || '';
        finishReason = response.choices[0]?.finish_reason;
        usage = response.usage;
      } catch (initialError) {
        // Model Registry auto-rollback (HIGH-01/PAR-02): count this failure
        // even when a fallback is about to rescue the response — otherwise a
        // degrading promoted model would never accumulate enough failures to
        // hit the auto-rollback threshold, since fallback keeps masking it.
        if (registryAlias) {
          registryFailureRecorded = true;
          void recordModelFailureForRollback(registryAlias);
        }

        const canFallback =
          (options.modelFallback && !fallbackUsed && options.modelFallback !== model) ||
          (routingMode === 'economic' && !fallbackUsed);

        if (canFallback) {
          if (!fallbackManager.checkAndRecordFallback()) {
            logger.error(
              'Fallback rate limit exceeded. Preventing cascading fallback to control costs.',
              {
                context: {
                  requestId,
                  originalModel: model,
                  error: errorHandlingManager.sanitizeAIError(initialError).message,
                },
              },
            );
            throw initialError;
          }
        }

        // Explicit per-agent fallback (e.g. tech_lead: qwen/qwen3-coder:free → codestral-latest)
        if (options.modelFallback && !fallbackUsed && options.modelFallback !== model) {
          logger.warn('Primary model failed, attempting explicit fallback', {
            context: {
              requestId,
              originalModel: model,
              originalProvider: provider,
              fallbackModel: options.modelFallback,
              error: errorHandlingManager.sanitizeAIError(initialError).message,
            },
          });

          model = options.modelFallback;
          provider = resolveProvider(model, options.provider ?? registryFallbackProvider);
          model = normalizeModelForProvider(model, provider);
          validateModelAllowed(
            model,
            options.agentName || 'unknown_agent',
            options.operation || 'openai-ai.generate.fallback',
            registryFallbackAlias,
          );
          requestPayload.model = model;
          requestPayload.messages = prepareProviderMessages(preparedMessages, provider);

          if (maxTokens) {
            if (provider === 'openai') {
              requestPayload.max_completion_tokens = maxTokens;
              delete requestPayload.max_tokens;
            } else {
              requestPayload.max_tokens = maxTokens;
              delete requestPayload.max_completion_tokens;
            }
          }

          fallbackUsed = true;
          fallbackReason = `explicit_model_failed:${initialError instanceof Error ? initialError.message.slice(0, 80) : 'unknown'}`;
          routingReason = `fallback_from_explicit_model_due_to_error`;
          llmFallbackCounter.inc({
            level: 'explicit',
            from_model: originalModel,
            to_model: model,
            agent_name: agentNameLabel,
            agent_version: agentVersionLabel,
          });

          response = (await executeModelFallback(
            'explicit',
            this.getClient(provider),
            requestPayload,
            {
              operation,
              model,
              provider,
              retryAttempts: options.retryAttempts,
              retryDelayMs: options.retryDelayMs,
            },
          )) as OpenAI.Chat.Completions.ChatCompletion;
          content = response.choices[0]?.message?.content || '';
          finishReason = response.choices[0]?.finish_reason;
          usage = response.usage;

          // [QW-3] Logging de custo do fallback
          const fallbackPromptTokens =
            usage?.prompt_tokens ?? estimateMessagesTokens(preparedMessages);
          const fallbackCompletionTokens = usage?.completion_tokens ?? estimateTextTokens(content);
          const fallbackCost = await estimateCost(
            model,
            fallbackPromptTokens,
            fallbackCompletionTokens,
          );
          logger.warn('Fallback cost log — explicit', {
            context: {
              requestId,
              primaryModel: originalModel,
              fallbackModel: model,
              fallbackProvider: provider,
              fallbackReason,
              operation,
              promptTokens: fallbackPromptTokens,
              completionTokens: fallbackCompletionTokens,
              estimatedCostUsd: fallbackCost.listCostUsd,
              pricingSource: fallbackCost.pricingSource,
            },
          });

          logger.info('Explicit fallback model successful', {
            context: { requestId, fallbackModel: model, fallbackProvider: provider },
          });
        }
        // Fallback logic: if economic mode failed, retry with safe model
        else if (routingMode === 'economic' && !fallbackUsed) {
          logger.warn('Economic model failed, attempting fallback to safe model', {
            context: {
              requestId,
              originalModel: model,
              originalProvider: provider,
              error: errorHandlingManager.sanitizeAIError(initialError).message,
            },
          });

          // Switch to safe model
          const safeModel = process.env.ROUTING_SAFE_MODEL || OPENROUTER_FALLBACK_MODEL;
          model = safeModel;
          provider = resolveProvider(model, options.provider);
          model = routingManager.normalizeForProvider(model, provider);
          routingManager.validateModel(model, options.agentName || 'unknown_agent', operation);
          requestPayload.model = model;
          requestPayload.messages = prepareProviderMessages(preparedMessages, provider);

          // Update provider-specific fields if needed
          if (maxTokens) {
            if (provider === 'openai') {
              requestPayload.max_completion_tokens = maxTokens;
              delete requestPayload.max_tokens;
            } else {
              requestPayload.max_tokens = maxTokens;
              delete requestPayload.max_completion_tokens;
            }
          }

          // Update telemetry
          fallbackUsed = true;
          fallbackReason = `economic_model_error:${errorHandlingManager.sanitizeAIError(initialError).message.slice(0, 80)}`;
          routingReason = `fallback_from_economic_due_to_error`;
          llmFallbackCounter.inc({
            level: 'economic',
            from_model: originalModel,
            to_model: model,
            agent_name: agentNameLabel,
            agent_version: agentVersionLabel,
          });

          // Retry with safe model
          response = (await executeModelFallback(
            'economic',
            this.getClient(provider),
            requestPayload,
            {
              operation,
              model,
              provider,
              retryAttempts: options.retryAttempts,
              retryDelayMs: options.retryDelayMs,
            },
          )) as OpenAI.Chat.Completions.ChatCompletion;
          content = response.choices[0]?.message?.content || '';
          finishReason = response.choices[0]?.finish_reason;
          usage = response.usage;

          // [QW-3] Logging de custo do fallback
          const econFallbackPromptTokens =
            usage?.prompt_tokens ?? estimateMessagesTokens(preparedMessages);
          const econFallbackCompletionTokens =
            usage?.completion_tokens ?? estimateTextTokens(content);
          const economicFallbackCost = await estimateCost(
            model,
            econFallbackPromptTokens,
            econFallbackCompletionTokens,
          );
          logger.warn('Fallback cost log — economic to safe', {
            context: {
              requestId,
              primaryModel: originalModel,
              fallbackModel: model,
              fallbackProvider: provider,
              fallbackReason,
              operation,
              promptTokens: econFallbackPromptTokens,
              completionTokens: econFallbackCompletionTokens,
              estimatedCostUsd: economicFallbackCost.listCostUsd,
              pricingSource: economicFallbackCost.pricingSource,
            },
          });

          logger.info('Fallback to safe model successful', {
            context: {
              requestId,
              fallbackModel: model,
              fallbackProvider: provider,
            },
          });
        } else {
          // Re-throw if not in economic mode or already used fallback
          throw initialError;
        }
      }

      // Validate content quality. Empty content from the provider is not a
      // usable completion, even when the HTTP/API call itself succeeded.
      if (isQualityFailure(null, content) && !fallbackUsed) {
        if (options.modelFallback && options.modelFallback !== model) {
          if (!fallbackManager.checkAndRecordFallback()) {
            logger.error('Fallback rate limit exceeded for quality failure. Skipping fallback.', {
              context: {
                requestId,
                originalModel: model,
              },
            });
          } else {
            logger.warn(
              'Primary model returned empty/invalid content, attempting explicit fallback',
              {
                context: {
                  requestId,
                  originalModel: model,
                  originalProvider: provider,
                  fallbackModel: options.modelFallback,
                  contentLength: content.length,
                },
              },
            );

            model = options.modelFallback;
            provider = resolveProvider(model, options.provider ?? registryFallbackProvider);
            model = normalizeModelForProvider(model, provider);
            validateModelAllowed(
              model,
              options.agentName || 'unknown_agent',
              options.operation || 'openai-ai.generate.empty_response_fallback',
              registryFallbackAlias,
            );
            requestPayload.model = model;
            requestPayload.messages = prepareProviderMessages(preparedMessages, provider);

            if (maxTokens) {
              if (provider === 'openai') {
                requestPayload.max_completion_tokens = maxTokens;
                delete requestPayload.max_tokens;
              } else {
                requestPayload.max_tokens = maxTokens;
                delete requestPayload.max_completion_tokens;
              }
            }

            fallbackUsed = true;
            fallbackReason = 'explicit_model_empty_response';
            routingReason = 'fallback_from_explicit_model_due_to_empty_response';
            llmFallbackCounter.inc({
              level: 'explicit',
              from_model: originalModel,
              to_model: model,
              agent_name: agentNameLabel,
              agent_version: agentVersionLabel,
            });

            response = (await executeModelFallback(
              'explicit',
              this.getClient(provider),
              requestPayload,
              {
                operation,
                model,
                provider,
                retryAttempts: options.retryAttempts,
                retryDelayMs: options.retryDelayMs,
              },
            )) as OpenAI.Chat.Completions.ChatCompletion;
            content = response.choices[0]?.message?.content || '';
            finishReason = response.choices[0]?.finish_reason;
            usage = response.usage;

            logger.info('Explicit fallback model successful for empty response', {
              context: {
                requestId,
                fallbackModel: model,
                fallbackProvider: provider,
              },
            });
          }
        } else if (routingMode === 'economic') {
          if (fallbackManager.checkAndRecordFallback()) {
            logger.warn('Economic model returned empty/invalid content, attempting fallback', {
              context: {
                requestId,
                originalModel: model,
                contentLength: content.length,
              },
            });

            // Switch to safe model
            const safeModel = process.env.ROUTING_SAFE_MODEL || OPENROUTER_FALLBACK_MODEL;
            model = safeModel;
            provider = resolveProvider(model, options.provider);
            model = routingManager.normalizeForProvider(model, provider);
            routingManager.validateModel(model, options.agentName || 'unknown_agent', operation);
            requestPayload.model = model;
            requestPayload.messages = prepareProviderMessages(preparedMessages, provider);

            // Update telemetry
            fallbackUsed = true;
            fallbackReason = `economic_model_empty_response`;
            routingReason = `fallback_from_economic_due_to_empty_response`;
            llmFallbackCounter.inc({
              level: 'economic',
              from_model: originalModel,
              to_model: model,
              agent_name: agentNameLabel,
              agent_version: agentVersionLabel,
            });

            // Retry with safe model
            response = (await executeModelFallback(
              'economic',
              this.getClient(provider),
              requestPayload,
              {
                operation,
                model,
                provider,
                retryAttempts: options.retryAttempts,
                retryDelayMs: options.retryDelayMs,
              },
            )) as OpenAI.Chat.Completions.ChatCompletion;
            content = response.choices[0]?.message?.content || '';
            finishReason = response.choices[0]?.finish_reason;
            usage = response.usage;

            logger.info('Fallback to safe model successful for empty response', {
              context: {
                requestId,
                fallbackModel: model,
              },
            });
          } else {
            logger.error('Fallback rate limit exceeded for quality failure. Skipping fallback.', {
              context: {
                requestId,
                originalModel: model,
              },
            });
          }
        }
      }

      // Auditoria 2026-08-03: 7 de 8 gerações de Tasks pararam exatamente no
      // teto de maxTokens e foram persistidas, versionadas e materializadas em
      // `specs/{id}-handoff/` como se estivessem completas — checklists sem as
      // últimas seções. O truncamento é sempre anômalo o bastante para logar;
      // quem gera documento pede `failOnTruncation` e trata como falha.
      const wasTruncated = finishReason === 'length';
      if (wasTruncated) {
        logger.warn('Resposta da LLM truncada no limite de tokens', {
          context: {
            requestId,
            operation,
            model,
            provider,
            maxTokens,
            failOnTruncation: options.failOnTruncation === true,
          },
        });

        if (options.failOnTruncation) {
          throw new ResponseTruncatedError(operation, maxTokens);
        }
      }

      const promptTokens = usage?.prompt_tokens ?? estimateMessagesTokens(preparedMessages);
      const completionTokens = usage?.completion_tokens ?? estimateTextTokens(content);
      const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
      const costEstimate = await estimateCost(model, promptTokens, completionTokens);

      // Prompt caching do provider: DeepSeek via OpenRouter tem cache implícito
      // server-side. cached_tokens > 0 = tokens lidos do cache (~0.1× preço).
      // Observabilidade: confirma que o cache automático está funcionando.
      // Se consistentemente 0, o sticky routing da OpenRouter não está ativo.
      const cachedTokens =
        (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
          ?.prompt_tokens_details?.cached_tokens ?? 0;
      if (cachedTokens > 0) {
        llmPromptCacheTokens
          .labels(model, provider, agentNameLabel, agentVersionLabel)
          .inc(cachedTokens);
      }

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        demandId: options.demandId,
        operation,
        model: `${provider}:${model}`,
        modelAlias: registryAlias,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: costEstimate.listCostUsd,
        pricingSource: costEstimate.pricingSource,
        pricingUpdatedAt: costEstimate.pricingUpdatedAt,
        billedCostUsd: costEstimate.billedCostUsd,
        creditAppliedUsd: costEstimate.creditAppliedUsd,
        isEstimated: costEstimate.isEstimated,
        cacheHit: false,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: null,
        latencyMs: Date.now() - startedAt,
        // Cost optimization telemetry
        requestId,
        routingMode,
        routingReason,
        cacheKeyVersion,
        fallbackUsed,
        // M-2: agent and stage labels
        agentId: options.agentId,
        stage: options.stage,
      });

      // Persistent request telemetry (fire-and-forget, non-blocking)
      {
        const promptTextForClassification = preparedMessages
          .map((m) => m.content)
          .join(' ')
          .slice(0, 2000); // Limit text for classification only, never stored
        const classification = classifyTaskType(
          promptTextForClassification,
          promptTokens,
          operation,
          options.taskType,
          options.demandDescription,
        );
        requestTelemetryService
          .recordEvent({
            requestId,
            demandId: options.demandId,
            model: `${provider}:${model}`,
            provider,
            operation,
            latencyMs: Date.now() - startedAt,
            promptTokens,
            completionTokens,
            totalTokens,
            estimatedCostUsd: costEstimate.listCostUsd,
            taskTypeInferred: classification.taskType,
            taskTypeProvided: null, // Set via API payload when provided
            classificationConfidence: classification.confidence,
            routingMode,
            routingReason,
            error: false,
            errorType: null,
            fallbackUsed,
            cacheHit: false,
          })
          .catch((err) => {
            // CRIT-18: log em vez de engolir silenciosamente.
            logger.warn('Failed to record telemetry event (fire-and-forget)', {
              error: errorHandlingManager.sanitizeAIError(err),
              context: { requestId, operation },
            });
          }); // Fire-and-forget
      }

      // LLM Audit Log (fire-and-forget, non-blocking)
      {
        const promptText = preparedMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n');
        llmAuditLogService.record({
          requestId,
          prompt: promptText,
          response: content,
          model: `${provider}:${model}`,
          provider,
          operation,
          agentName: options.agentName ?? null,
          latencyMs: Date.now() - startedAt,
          statusCode: 200,
          promptTokens,
          completionTokens,
          totalTokens,
          estimatedCostUsd: costEstimate.listCostUsd,
          demandId: options.demandId ?? null,
        });
      }

      // Prometheus Metrics — com exemplars (trace_id, request_id) para link pico→trace no Grafana.
      // Quando tracing está desabilitado, tracingContext.span é null e exemplarLabels fica vazio
      // (updateExemplar retorna early — a observação do histograma ainda é registrada).
      const latencySeconds = (Date.now() - startedAt) / 1000;
      const exemplarLabels = tracingContext.span
        ? { trace_id: tracingContext.span.traceId, request_id: requestId }
        : {};
      aiCallDuration.observe({
        labels: {
          model,
          provider,
          status: 'success',
          agent_name: agentNameLabel,
          agent_version: agentVersionLabel,
          fallback_level: fallbackUsed
            ? fallbackReason?.startsWith('governance')
              ? 'governance'
              : fallbackReason?.startsWith('economic')
                ? 'economic'
                : 'explicit'
            : 'primary',
        },
        value: latencySeconds,
        exemplarLabels,
      });
      // TTFT for non-streaming = total latency (response arrives as a single block).
      // Recorded for baseline coherence across streaming/non-streaming agents.
      aiFirstTokenDuration.observe({
        labels: {
          model,
          provider,
          agent_name: agentNameLabel,
          agent_version: agentVersionLabel,
          mode: 'non_streaming',
        },
        value: latencySeconds,
        exemplarLabels,
      });
      aiTokensUsage.labels(model, 'prompt', agentNameLabel, agentVersionLabel).inc(promptTokens);
      aiTokensUsage
        .labels(model, 'completion', agentNameLabel, agentVersionLabel)
        .inc(completionTokens);

      // Custom metrics collector
      metricsCollector.recordOpenAICall(
        options.demandId,
        Date.now() - startedAt,
        `${provider}:${model}`,
        requestId,
      );

      if (options.cache !== false) {
        aiResponseCache.set(cacheKey, content, options.cacheTtlMs);

        // Store in semantic cache (async, non-blocking).
        // Ignorado quando semanticCacheDisabled=true: evita geração de embeddings
        // e entradas inúteis para estágios como moderador e consolidação do roundtable.
        if (responseFormat === 'text' && content.length >= 20 && !options.semanticCacheDisabled) {
          const userMsg = preparedMessages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join(' ')
            .trim();
          if (userMsg.length > 10) {
            // Spec 015 (H-04): grava sob o mesmo fingerprint usado no lookup.
            // Spec 10259 T5: quando há promptHash, usa o hash do arquivo bruto.
            const storeFingerprint = computeContextFingerprint({
              systemMessages: canonicalizeMessages(
                preparedMessages.filter((m) => m.role === 'system'),
              ),
              cacheContext: canonicalizeCacheValue(options.cacheContext || null),
              temperature: temperature ?? null,
              maxTokens: maxTokens ?? null,
              responseFormat,
              promptHash,
            });
            semanticCacheService
              .set(
                userMsg,
                content,
                `${provider}:${model}`,
                operation,
                options.cacheTtlMs,
                storeFingerprint ?? undefined,
              )
              .catch(() => {
                /* non-fatal */
              });
          }
        }
      }

      // Complete tracing span on success
      endTracing(tracingContext, {
        content,
        modelUsed: model,
        provider,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        latencyMs: Date.now() - startedAt,
      });

      logger.info('LLM operation completed', {
        context: {
          requestId,
          operation,
          durationMs: Date.now() - startedAt,
          model,
          provider,
          fallbackUsed,
          fallbackLevel: fallbackUsed
            ? fallbackReason?.startsWith('governance')
              ? 'governance'
              : fallbackReason?.startsWith('economic')
                ? 'economic'
                : 'explicit'
            : 'primary',
        },
      });

      return {
        content,
        metadata: {
          modelUsed: model,
          provider,
          originalModel,
          fallbackUsed,
          fallbackReason,
          routingMode,
          routingReason,
          cacheHit: false,
          promptTokens,
          completionTokens,
          costEstimate: costEstimate.listCostUsd ?? undefined,
          agentName: agentNameLabel,
          agentVersion: agentVersionLabel,
        },
      };
    } catch (error) {
      // Complete tracing span on error
      const sanitizedError = errorHandlingManager.sanitizeAIError(error);
      endTracing(tracingContext, {
        content: '',
        modelUsed: model,
        provider,
        latencyMs: Date.now() - startedAt,
        error: sanitizedError.message,
      });

      errorHandlingManager.logSanitized(error, {
        operation,
        model,
        provider,
        requestId,
        durationMs: Date.now() - startedAt,
        fallbackUsed,
        fallbackLevel: fallbackUsed
          ? fallbackReason?.startsWith('governance')
            ? 'governance'
            : fallbackReason?.startsWith('economic')
              ? 'economic'
              : 'explicit'
          : 'primary',
      });

      // Model Registry auto-rollback (HIGH-01): a real inference failure on
      // the currently active (possibly promoted) model counts toward the
      // rollback threshold. No-op when the registry is disabled, the model
      // isn't bound to a known alias, or the primary attempt already
      // recorded this failure (see `registryFailureRecorded` above).
      if (registryAlias && !registryFailureRecorded) {
        void recordModelFailureForRollback(registryAlias);
      }

      const latencySeconds = (Date.now() - startedAt) / 1000;
      const errorExemplarLabels = tracingContext.span
        ? { trace_id: tracingContext.span.traceId, request_id: requestId }
        : {};
      aiCallDuration.observe({
        labels: {
          model,
          provider,
          status: 'error',
          agent_name: agentNameLabel,
          agent_version: agentVersionLabel,
          fallback_level: fallbackUsed
            ? fallbackReason?.startsWith('governance')
              ? 'governance'
              : fallbackReason?.startsWith('economic')
                ? 'economic'
                : 'explicit'
            : 'primary',
        },
        value: latencySeconds,
        exemplarLabels: errorExemplarLabels,
      });

      // Record error in persistent telemetry
      requestTelemetryService
        .recordEvent({
          requestId,
          demandId: options.demandId,
          model: `${provider}:${model}`,
          provider,
          operation,
          latencyMs: Date.now() - startedAt,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: null,
          taskTypeInferred: 'unknown',
          taskTypeProvided: null,
          classificationConfidence: 0,
          routingMode,
          routingReason,
          error: true,
          errorType: String(sanitizedError.message || 'unknown_error').slice(0, 100),
          fallbackUsed,
          cacheHit: false,
        })
        .catch((err) => {
          // CRIT-18: log em vez de engolir silenciosamente.
          logger.warn('Failed to record telemetry error event (fire-and-forget)', {
            error: errorHandlingManager.sanitizeAIError(err),
            context: { requestId, operation },
          });
        });

      // LLM Audit Log — error case
      {
        const promptText = preparedMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n');
        llmAuditLogService.record({
          requestId,
          prompt: promptText,
          response: '',
          model: `${provider}:${model}`,
          provider,
          operation,
          agentName: options.agentName ?? null,
          latencyMs: Date.now() - startedAt,
          statusCode: 500,
          errorMessage: String(sanitizedError.message || 'unknown_error').slice(0, 500),
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          demandId: options.demandId ?? null,
        });
      }

      throw new Error(`Failed to generate chat completion: ${sanitizedError.message}`);
    } finally {
      disposeRequestBudget(budget);
    }
  }

  /**
   * Generate a streaming chat completion.
   * Calls onChunk for each text delta, accumulates full response.
   * Falls back to non-streaming if streaming fails or model doesn't support it.
   * Returns the full accumulated response content.
   *
   * Backwards-compatible wrapper: returns just the string content.
   * For metadata (model used, fallback info, cache, etc.) use
   * `generateChatCompletionStreamingWithMetadata` directly.
   */
  async generateChatCompletionStreaming(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions<string> & {
      onChunk: (chunk: string) => void;
      onReasoningChunk?: (chunk: string) => void;
      onStreamEnd?: () => void;
      onFirstChunk?: () => void;
    },
  ): Promise<string> {
    const result = await this.generateChatCompletionStreamingWithMetadata(
      systemPrompt,
      userPrompt,
      options,
    );
    return result.content;
  }

  /**
   * Streaming variant of `generateChatCompletionWithMetadata`.
   * Emits chunks via `onChunk` and a single `onFirstChunk` callback on the first
   * non-empty delta (used to measure Time-To-First-Token).
   *
   * Preserves: governance validation, agent label in metrics, TTFT histogram,
   * `aiCallDuration` histogram, automatic fallback to non-streaming on errors.
   * Not preserved (current scope): semantic cache, model_fallback retry, llm-tracing.
   */
  async generateChatCompletionStreamingWithMetadata(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions<string> & {
      onChunk: (chunk: string) => void;
      onReasoningChunk?: (chunk: string) => void;
      onStreamEnd?: () => void;
      onFirstChunk?: () => void;
    },
  ): Promise<ChatCompletionWithMetadata> {
    const { onChunk, onReasoningChunk, onStreamEnd, onFirstChunk, ...initialRestOptions } = options;
    const startedAt = Date.now();

    // Model Registry integration (CRIT-01): resolve the hardcoded default
    // model/fallback (from agent YAML config) through the registry, so
    // promote/rollback also take effect in the streaming path.
    const registryOverride = await applyModelRegistryOverride(initialRestOptions);
    const restOptions = registryOverride.options;
    const registryAlias = registryOverride.primaryAlias;
    // Kept separate from `restOptions.provider` — see
    // applyModelRegistryOverride's docstring (never let one model's provider
    // leak into another attempt's provider resolution).
    const registryPrimaryProvider = registryOverride.primaryProvider as AIProvider | undefined;

    // Resolve model/provider early (simplified path, no full routing for streaming pilot)
    let model = resolveModel(restOptions);
    let provider = resolveProvider(model, restOptions.provider ?? registryPrimaryProvider);

    if (!llmClientManager.hasClient(provider)) {
      if (llmClientManager.hasClient('openrouter')) {
        provider = 'openrouter';
        model = OPENROUTER_PRIMARY_MODEL;
      } else {
        provider = 'openai';
      }
    }

    model = normalizeModelForProvider(model, provider);
    const originalModel = model;
    const agentLabel = restOptions.agentName ?? 'unknown';
    const agentVersionLabel = restOptions.agentVersion ?? 'unknown';

    // Governance check — block disallowed models before any network call
    try {
      validateModelAllowed(
        model,
        agentLabel,
        restOptions.operation || 'openai-ai.streaming',
        registryAlias,
      );
    } catch (govError) {
      if (govError instanceof ModelGovernanceError) {
        logger.warn('Streaming blocked by governance, no fallback applied', {
          context: {
            model,
            agent: agentLabel,
            reason: govError.message,
          },
        });
      }
      throw govError;
    }

    const client = this.getClient(provider);

    const messages: AIChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    let preparedMessages = prepareMessages(messages, restOptions);

    // Ajuste para Modelos de Raciocínio (Reasoning)
    const modelConfig = getModelConfig(model);
    if (modelConfig.behavior === 'reasoning') {
      preparedMessages = preparedMessages.map((msg) => ({
        ...msg,
        content: cleanReasoningPrompt(msg.content),
      }));
    }

    const requestPayload: Record<string, unknown> = {
      model,
      messages: prepareProviderMessages(preparedMessages, provider),
      stream: true,
    };

    let temperature = restOptions.temperature;
    if (modelConfig.behavior === 'reasoning') {
      if (temperature === undefined || temperature > 0.3) {
        temperature = modelConfig.defaultTemperature ?? 0.2;
      }
    }
    if (temperature !== undefined) {
      requestPayload.temperature = temperature;
    }

    const maxTokens = resolveMaxTokens(restOptions);
    if (maxTokens) {
      if (provider === 'openai') {
        requestPayload.max_completion_tokens = maxTokens;
      } else {
        requestPayload.max_tokens = maxTokens;
      }
    }

    try {
      const stream = (await circuitBreaker.execute(
        provider,
        async () =>
          client.chat.completions.create(
            requestPayload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          ),
        { timeout: 120_000 },
      )) as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>;

      let accumulated = '';
      let firstChunkSeen = false;

      // Handle async iterable stream
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta as
          | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
              reasoning?: string;
              reasoning_content?: string;
            })
          | undefined;
        const deltaContent = delta?.content;
        const deltaReasoning = delta?.reasoning || delta?.reasoning_content;

        if (deltaReasoning) {
          onReasoningChunk?.(deltaReasoning);
        }

        if (deltaContent) {
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            const ttftSeconds = (Date.now() - startedAt) / 1000;
            aiFirstTokenDuration
              .labels(model, provider, agentLabel, agentVersionLabel, 'streaming')
              .observe(ttftSeconds);
            onFirstChunk?.();
          }
          accumulated += deltaContent;
          onChunk(deltaContent);
        }
      }

      onStreamEnd?.();

      // Prometheus: total latency (with agent label)
      const latencySeconds = (Date.now() - startedAt) / 1000;
      // Streaming path não tem cascade de fallback (not preserved no escopo atual).
      // Label 'primary' reflete que streaming serve o modelo primário sem degradar.
      aiCallDuration
        .labels(model, provider, 'success', agentLabel, agentVersionLabel, 'primary')
        .observe(latencySeconds);

      // Record usage (estimated since streaming doesn't always return usage)
      const promptTokens = estimateMessagesTokens(preparedMessages);
      const completionTokens = estimateTextTokens(accumulated);
      const totalTokens = promptTokens + completionTokens;
      const costEstimate = await estimateCost(model, promptTokens, completionTokens);
      const operation = restOptions.operation || 'streaming_completion';

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        demandId: restOptions.demandId,
        operation,
        model: `${provider}:${model}`,
        modelAlias: registryAlias,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: costEstimate.listCostUsd,
        pricingSource: costEstimate.pricingSource,
        pricingUpdatedAt: costEstimate.pricingUpdatedAt,
        billedCostUsd: costEstimate.billedCostUsd,
        creditAppliedUsd: costEstimate.creditAppliedUsd,
        isEstimated: costEstimate.isEstimated,
        cacheHit: false,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: null,
        latencyMs: Date.now() - startedAt,
        requestId: generateRequestId(),
        routingMode: 'unknown',
        routingReason: 'streaming_pilot',
        fallbackUsed: false,
        // M-2: agent and stage labels
        agentId: restOptions.agentId,
        stage: restOptions.stage,
      });

      return {
        content: accumulated,
        metadata: {
          modelUsed: model,
          provider,
          originalModel,
          fallbackUsed: false,
          fallbackReason: null,
          routingMode: 'unknown',
          routingReason: 'streaming_pilot',
          cacheHit: false,
        },
      };
    } catch (error) {
      // Record error latency
      const latencySeconds = (Date.now() - startedAt) / 1000;
      aiCallDuration
        .labels(model, provider, 'error', agentLabel, agentVersionLabel, 'primary')
        .observe(latencySeconds);

      // Fallback to non-streaming on any streaming error
      errorHandlingManager.logSanitized(
        error,
        {
          message: 'Streaming failed, falling back to non-streaming',
          model,
          provider,
          agent: agentLabel,
        },
        'warn',
      );

      // Model Registry auto-rollback: count the streaming failure itself —
      // the non-streaming fallback below re-resolves the registry alias
      // independently and records its own failure only if IT also fails, so
      // without this a degrading promoted model could fail every streaming
      // attempt and never accumulate enough failures to trigger rollback.
      if (registryAlias) {
        void recordModelFailureForRollback(registryAlias);
      }

      const fallbackResult = await this.generateChatCompletionWithMetadata(
        systemPrompt,
        userPrompt,
        restOptions,
      );
      // Emit entire response as a single chunk; first-chunk event still fires
      onFirstChunk?.();
      onChunk(fallbackResult.content);
      onStreamEnd?.();
      return {
        content: fallbackResult.content,
        metadata: {
          ...fallbackResult.metadata,
          fallbackUsed: true,
          fallbackReason: 'streaming_error_fallback_to_non_streaming',
        },
      };
    }
  }

  async generateMultipleChatCompletions(
    prompts: Array<{ systemPrompt: string; userPrompt: string }>,
    options: GenerateOptions<string> = {},
  ): Promise<string[]> {
    try {
      const concurrency = resolveConcurrency(options.maxConcurrency);
      return await mapWithConcurrency(prompts, concurrency, (prompt) =>
        this.generateChatCompletion(prompt.systemPrompt, prompt.userPrompt, options),
      );
    } catch (error) {
      errorHandlingManager.logSanitized(error, {
        operation: 'generateMultipleChatCompletions',
      });
      // Nunca fabrique PRD/Tasks em caso de falha: o caller deve abortar ou
      // decidir explicitamente como tratar a indisponibilidade do provedor.
      throw error;
    }
  }

  async generateJSONResponse<T = Record<string, unknown>>(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions<T> = {},
  ): Promise<T> {
    const { schema, ...completionOptions } = options;
    const taskType = completionOptions.taskType || 'json';
    const baseMaxTokens =
      completionOptions.maxTokens ??
      DEFAULT_MAX_COMPLETION_TOKENS[taskType] ??
      DEFAULT_MAX_COMPLETION_TOKENS.json;

    const requestJson = (maxTokens: number, failOnTruncation: boolean) =>
      this.generateChatCompletion(
        `${systemPrompt}\nYou must respond with valid JSON only.`,
        userPrompt,
        {
          ...completionOptions,
          maxTokens,
          failOnTruncation,
          taskType,
          temperature: completionOptions.temperature ?? 0.3,
          responseFormat: 'json_object',
        },
      );

    let content: string;
    try {
      content = await requestJson(baseMaxTokens, true);
    } catch (error) {
      if (!(error instanceof ResponseTruncatedError)) throw error;

      // Auditoria 2026-08-03: JSON cortado no teto de tokens chegava aqui como
      // "Unexpected end of JSON input" e caía no reparo abaixo — que é incapaz
      // de resolver truncamento. O reparo conserta JSON MALFORMADO; um JSON
      // INCOMPLETO só volta inteiro se houver orçamento para ele. Pior: o
      // reparo reenviava o conteúdo truncado pedindo correção com o MESMO teto,
      // então teria que reproduzir tudo e ainda completar no mesmo espaço —
      // truncava de novo, e o erro chegava ao usuário. Aqui refazemos o pedido
      // ORIGINAL com orçamento maior, que é a única saída real.
      logger.warn('JSON truncado no teto de tokens; refazendo com orçamento maior', {
        context: {
          operation: completionOptions.operation || 'json_response',
          baseMaxTokens,
          retryMaxTokens: Math.min(baseMaxTokens * 4, JSON_RETRY_TOKEN_CAP),
        },
      });

      content = await requestJson(Math.min(baseMaxTokens * 4, JSON_RETRY_TOKEN_CAP), false);
    }

    try {
      return validateJSONContent(content, schema || (jsonObjectSchema as ZodSchema<T>));
    } catch (_error) {
      const repairedContent = await this.generateChatCompletion(
        'Você corrige respostas JSON inválidas. Responda apenas JSON válido, sem markdown ou explicações.',
        `Corrija apenas o JSON abaixo, preservando os dados existentes:\n\n${content}`,
        {
          ...completionOptions,
          cache: false,
          // O reparo precisa ECOAR o conteúdo recebido e ainda fechá-lo, então
          // nunca pode ter orçamento menor que o da resposta que está
          // corrigindo — era o que acontecia quando caía no default de 400.
          maxTokens: Math.min(Math.max(baseMaxTokens, 400) * 2, JSON_RETRY_TOKEN_CAP),
          taskType: 'json',
          temperature: 0,
          responseFormat: 'json_object',
          operation: `${completionOptions.operation || 'json_response'}:repair`,
        },
      );

      return validateJSONContent(repairedContent, schema || (jsonObjectSchema as ZodSchema<T>));
    }
  }

  async generateResponse(prompt: string, options: GenerateOptions<string> = {}): Promise<string> {
    return this.generateChatCompletion(
      'Você é um assistente de produto e engenharia. Responda de forma objetiva e prática em português brasileiro.',
      prompt,
      {
        ...options,
        taskType: options.taskType || 'simple',
      },
    );
  }

  /**
   * Generate a vector embedding for the given text.
   * Delegates to embeddingsManager for provider selection, fallback and telemetry.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    return generateEmbeddingModule(text);
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * Delegates to embeddingsManager for provider selection, fallback and telemetry.
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return generateEmbeddingsModule(texts);
  }

  isUsingLocalEmbeddings(): boolean {
    return isUsingLocalEmbeddingsModule();
  }

  /**
   * Whether local embeddings are explicitly enabled for RAG paths.
   * Local embeddings are a performance fallback, not semantically equivalent
   * to remote embeddings. By default they are NOT used for critical RAG.
   */
  isUsingLocalEmbeddingsForRAG(): boolean {
    return isUsingLocalEmbeddingsForRAGModule();
  }
}

export const openAIService = new OpenAIService();
