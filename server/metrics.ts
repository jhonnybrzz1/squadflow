import client from 'prom-client';
import { toolExecutionDuration, toolExecutionTimeoutTotal } from './metrics/tool-execution';
import {
  githubContentIndexedTotal,
  githubContentIndexFailureTotal,
} from './metrics/github-content';

export { toolExecutionDuration, toolExecutionTimeoutTotal } from './metrics/tool-execution';
export {
  githubContentIndexedTotal,
  githubContentIndexFailureTotal,
} from './metrics/github-content';

// Criar registro para armazenar as métricas.
// OpenMetrics é necessário para emitir exemplars (link pico→trace no Grafana).
// Prometheus aceita OpenMetrics desde v2.5; o compose local usa v2.54.
// Nota: prom-client v15.1.3 não tipa enableExemplars nem o generic do Registry
// corretamente — os casts abaixo fecham a lacuna dos .d.ts (o runtime suporta).
const register = new client.Registry<client.RegistryContentType>();
register.setContentType(client.Registry.OPENMETRICS_CONTENT_TYPE);
// Métricas auto-registram no registry global por padrão; precisa estar em OpenMetrics
// também para o check do construtor (enableExemplars exige OpenMetrics em todos os registries).
(client.register as client.Registry<client.RegistryContentType>).setContentType(
  client.Registry.OPENMETRICS_CONTENT_TYPE,
);

// Coletar métricas padrão do Node.js (memória, CPU, event loop)
client.collectDefaultMetrics({ register });

// Métrica para chamadas de IA (Histograma de latência).
// enableExemplars permite anexar trace_id + request_id a cada amostra via observe({ labels, value, exemplarLabels }),
// habilitando o link direto pico no gráfico → trace no Tempo via Grafana (item #3 do roadmap de obs).
export const aiCallDuration = new client.Histogram({
  name: 'ai_api_call_duration_seconds',
  help: 'Duração das chamadas à API de IA em segundos',
  // fallback_level: 'primary' | 'explicit' | 'economic' | 'provider' | 'governance' | 'none'
  // Permite segmentar latência por caminho degradado vs primário no Grafana.
  labelNames: ['model', 'provider', 'status', 'agent_name', 'agent_version', 'fallback_level'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30], // buckets para distribuição
  enableExemplars: true,
} as client.HistogramConfiguration<string>);

// Métrica para Time-To-First-Token (TTFT) — latência percebida pelo operador
// Em streaming: tempo até o primeiro chunk
// Em não-streaming: equivale à latência total da chamada (fornecido para coerência do baseline)
export const aiFirstTokenDuration = new client.Histogram({
  name: 'ai_first_token_duration_seconds',
  help: 'Tempo até o primeiro token (TTFT) das chamadas à API de IA, em segundos',
  labelNames: ['model', 'provider', 'agent_name', 'agent_version', 'mode'], // mode: streaming | non_streaming
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
  enableExemplars: true,
} as client.HistogramConfiguration<string>);

// Métrica para uso de tokens (Counter)
export const aiTokensUsage = new client.Counter({
  name: 'ai_api_tokens_total',
  help: 'Total de tokens de IA consumidos',
  labelNames: ['model', 'token_type', 'agent_name', 'agent_version'], // prompt vs completion
});

// Métrica para requests HTTP da API (Histograma)
export const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});

// Classificação de demandas por zona (clear_vague, ambiguous, clear_not_vague)
export const demandsByClassificationZone = new client.Counter({
  name: 'demands_by_classification_zone_total',
  help: 'Demandas classificadas por zona do score rule-based',
  labelNames: ['zone', 'method', 'label'],
});

// Taxa de retrabalho por zona de classificação
export const retrabalhoRateByZone = new client.Gauge({
  name: 'retrabalho_rate_by_zone',
  help: 'Taxa de retrabalho (refinements > 1) por zona de classificação',
  labelNames: ['zone'],
});

// Latência da classificação híbrida
export const classificationLatency = new client.Histogram({
  name: 'hybrid_classification_latency_seconds',
  help: 'Latência da classificação híbrida de vagueza em segundos',
  labelNames: ['method'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1],
});

// Custo da classificação por demanda
export const classificationCostPerDemand = new client.Histogram({
  name: 'classification_cost_per_demand_usd',
  help: 'Custo em USD por classificação de demanda',
  labelNames: ['method'],
  buckets: [0, 0.0001, 0.0005, 0.001, 0.005],
});

export const hybridClassifierComparison = new client.Counter({
  name: 'hybrid_classifier_comparison_total',
  help: 'Comparações shadow entre a regra e o classificador híbrido',
  labelNames: ['result'], // match | divergent
});

export const discPromptTokensInjected = new client.Counter({
  name: 'disc_prompt_tokens_injected_total',
  help: 'Estimativa de tokens DISC adicionados aos prompts de sistema',
});

export const contextSummarizationTokensSaved = new client.Counter({
  name: 'context_summarization_tokens_saved_total',
  help: 'Estimativa de tokens removidos por compactação dos insights antigos',
});

export const modelRoutingAdaptation = new client.Counter({
  name: 'model_routing_adaptation_total',
  help: 'Decisões propostas ou aplicadas pelo roteamento adaptativo',
  labelNames: ['from_model', 'to_model', 'reason', 'mode'],
});

export const documentHallucinationTotal = new client.Counter({
  name: 'document_hallucination_total',
  help: 'Documentos avaliados pela detecção de paths alucinados',
  labelNames: ['result', 'document_type'],
});

export const numericProvenanceViolationsTotal = new client.Counter({
  name: 'numeric_provenance_violations_total',
  help: 'Claims numéricos sem provenance confirmada',
  labelNames: ['source'],
});

export const citedPathViolationsTotal = new client.Counter({
  name: 'cited_path_violations_total',
  help: 'Caminhos citados e confirmados como inexistentes',
  labelNames: ['source'],
});

// Avaliação de fluxo de agentes (2026-07-26, A-2): antes desta métrica, a
// checagem de seções obrigatórias na consolidação do roundtable só emitia
// `logger.warn` — sem contador, ninguém percebia se o handoff saía
// incompleto. Torna o gap observável/alertável.
export const consolidationTypeRequirementsMissingTotal = new client.Counter({
  name: 'consolidation_type_requirements_missing_total',
  help: 'Consolidações do roundtable cuja seção obrigatória do tipo de demanda não foi encontrada no texto',
  labelNames: ['demand_type'],
});

// Spec 10012 F2/FR-008/009: instrumentação de budget por estágio. NOTA de grounding:
// o `RequestBudget` que expira ("Request budget expired before document:prd") é um teto
// WALL-CLOCK (ms), não de tokens — por isso a métrica mede ms restantes por operação,
// não tokens consumidos (a premissa "tokens_consumed" da spec foi corrigida no research).
export const refinementStageBudgetRemainingMs = new client.Gauge({
  name: 'refinement_stage_budget_remaining_ms',
  help: 'Budget wall-clock (ms) restante ao entrar num estágio/operação da cascata LLM',
  labelNames: ['operation', 'fallback_level'],
});

// Spec 10012 FR-010: contagem de expirações de budget por operação (o caso
// "Request budget expired before document:prd" que degrada o PRD).
export const refinementStageBudgetExpiredTotal = new client.Counter({
  name: 'refinement_stage_budget_expired_total',
  help: 'Estágios/operações abortados por expiração do budget wall-clock',
  labelNames: ['operation', 'fallback_level'],
});

// Spec 10012 FR-005/007: PRDs marcados como grounding-degraded (>50% de claims
// verificáveis não encontrados no repositório-alvo).
export const prdGroundingDegradedTotal = new client.Counter({
  name: 'prd_grounding_degraded_total',
  help: 'Documentos (PRD/TSD) marcados como degraded por grounding parcial (>50% não verificado)',
  labelNames: ['source'],
});

export const roundtableTotalDuration = new client.Histogram({
  name: 'roundtable_total_duration_seconds',
  help: 'Duração total da mesa redonda, incluindo consolidação',
  labelNames: ['refinement_level'],
  buckets: [10, 30, 60, 120, 180, 300, 600, 900, 1200],
});

export const roundtableModeratorDuration = new client.Histogram({
  name: 'roundtable_moderator_duration_seconds',
  help: 'Duração da decisão do moderador por modo efetivo',
  labelNames: ['mode', 'refinement_level'],
  buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 20, 30],
});

export const roundtableAgentDuration = new client.Histogram({
  name: 'roundtable_agent_duration_seconds',
  help: 'Duração de cada fala de agente na mesa redonda',
  labelNames: ['agent', 'refinement_level', 'mode'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
});

export const roundtableTurnDuration = new client.Histogram({
  name: 'roundtable_turn_duration_seconds',
  help: 'Duração completa de um turno, incluindo moderação e agente',
  labelNames: ['refinement_level'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
});

export const roundtableTtft = new client.Histogram({
  name: 'roundtable_ttft_seconds',
  help: 'Tempo até o primeiro token de um agente da mesa redonda',
  labelNames: ['agent', 'refinement_level'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
});

export const roundtableTurnsUsed = new client.Histogram({
  name: 'roundtable_turns_used',
  help: 'Quantidade de turnos efetivamente usados por mesa redonda',
  labelNames: ['refinement_level'],
  buckets: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20],
});

export const roundtableExecutionMode = new client.Counter({
  name: 'roundtable_execution_mode_total',
  help: 'Falas executadas em modo paralelo ou sequencial',
  labelNames: ['mode', 'refinement_level', 'result'],
});

/**
 * Demanda 10321 — throughput de demandas.
 *
 * A retrospectiva registrou queda de 11 para 1 demanda no período e não
 * conseguiu dizer se a causa foi backlog seco, demanda travada ou falha
 * silenciosa: não havia contagem nenhuma. O baseline segue **A MEDIR — sem
 * baseline**; estes contadores existem para produzi-lo, não para afirmá-lo.
 *
 * `demand_terminal_state_total` separa os desfechos, que é o que distingue as
 * três hipóteses: só `completed` subindo com `created` parado = backlog seco;
 * `error` subindo = falha técnica; nenhum dos dois mexendo com `created`
 * subindo = demanda travada em processing.
 */
export const demandCreatedTotal = new client.Counter({
  name: 'demand_created_total',
  help: 'Demandas criadas, por tipo e nível de refinamento',
  labelNames: ['demand_type', 'refinement_type'],
});

export const demandTerminalStateTotal = new client.Counter({
  name: 'demand_terminal_state_total',
  help: 'Demandas que atingiram estado terminal (completed, error, stopped), por tipo',
  labelNames: ['status', 'demand_type'],
});

// Spec 10122: falhas de parse de respostas de modelos de IA nos plugins
export const aiModelFailureTotal = new client.Counter({
  name: 'ai_model_failure_total',
  help: 'Falhas em respostas de modelos de IA (parse, formato inválido, etc.)',
  labelNames: ['error_type', 'component'],
});

// Spec 10122: erros de IO/permissão em arquivos de feature flags
export const featureFlagIoErrorTotal = new client.Counter({
  name: 'feature_flag_io_error_total',
  help: 'Erros de IO/permissão ao ler arquivos de feature flags',
  labelNames: ['file', 'error_code'],
});

// Spec 10122: degradações silenciosas na leitura de flags (ex: squadGraphEnabled)
export const squadGraphFlagDegradedTotal = new client.Counter({
  name: 'squad_graph_flag_degraded_total',
  help: 'Falhas na leitura da flag squadGraphEnabled',
  labelNames: ['flag_name', 'component'],
});

// Spec 10144: falhas na construção do cognitive-core output no roundtable.
// Degradação silenciosa — o pipeline continua sem constraints enriquecidas.
export const cognitiveCoreBuildFailureTotal = new client.Counter({
  name: 'cognitive_core_build_failure_total',
  help: 'Falhas na construção do cognitive-core output para o roundtable',
  labelNames: ['demand_id'],
});

// Spec 10116: observabilidade do Cognitive Core (latência e nº de agentes).
export const cognitiveCoreLatencyMs = new client.Histogram({
  name: 'cognitive_core_latency_ms',
  help: 'Latência do processamento do Cognitive Core por demanda',
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
});

export const cognitiveCoreAgentsTotal = new client.Gauge({
  name: 'cognitive_core_agents_total',
  help: 'Número de agentes invocados pelo Cognitive Core',
  labelNames: ['demand_id'],
});

export const cognitiveCoreDepthLevel = new client.Gauge({
  name: 'cognitive_core_depth_level',
  help: 'Nível de refinamento (profundidade) do Cognitive Core',
  labelNames: ['demand_id'],
});

// B2 — Squad graph: tamanho da squad (nº de nós-agente) por demanda
export const squadGraphSize = new client.Histogram({
  name: 'squad_graph_size',
  help: 'Número de nós-agente do squad graph por demanda',
  buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9],
});

// Seção 14 — Observabilidade de custo do roundtable (8a / 8b)
// labelNames inclui 'stage' para futura cobertura progressiva de agentes/red-team/judge.
// Cobertura atual: moderator | consolidation.
export const roundtableCostUsdTotal = new client.Counter({
  name: 'roundtable_cost_usd_total',
  help: 'Custo estimado em USD por estágio LLM do roundtable (cobertura atual: moderator, consolidation)',
  labelNames: ['stage', 'refinement_level', 'agent_name', 'agent_version'],
});

export const roundtableTokensTotal = new client.Counter({
  name: 'roundtable_tokens_total',
  help: 'Total de tokens consumidos pelo roundtable por estágio e tipo',
  labelNames: ['stage', 'token_type', 'refinement_level', 'agent_name', 'agent_version'], // stage: moderator|agent|consolidation|red_team|judge
});

export const roundtableCacheHitTotal = new client.Counter({
  name: 'roundtable_cache_hit_total',
  help: 'Cache hits no roundtable por estágio e tipo',
  labelNames: ['stage', 'cache_type'], // cache_type: exact|semantic
});

// B2 — Squad graph: builds do grafo, com flag de presença do nó de deliberação
export const squadGraphBuilt = new client.Counter({
  name: 'squad_graph_built_total',
  help: 'Total de squad graphs construídos (deliberation: roundtable presente?)',
  labelNames: ['deliberation'],
});

// Spec 10124: falhas na construção do squad graph não devem ser mascaradas como warn
export const squadGraphBuildFailureTotal = new client.Counter({
  name: 'squad_graph_build_failure_total',
  help: 'Falhas na construção do squad graph',
  labelNames: ['demand_id'],
});

// Spec 10126: latência por turno de agente
export const agentTurnDurationSeconds = new client.Histogram({
  name: 'agent_turn_duration_seconds',
  help: 'Latência por turno de agente (segundos)',
  labelNames: ['agent_name', 'round'],
  buckets: [0.1, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120],
});

// B2 — Latência por nó-agente na execução da squad
export const squadAgentNodeDuration = new client.Histogram({
  name: 'squad_agent_node_duration_seconds',
  help: 'Latência de execução por nó-agente da squad em segundos',
  labelNames: ['agent'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
});

// B4 — Resultado da validação do Response Contract (schema) por agente
export const agentResponseSchemaResult = new client.Counter({
  name: 'agent_response_schema_total',
  help: 'Validações do Response Contract por agente (result: valid|invalid)',
  labelNames: ['agent', 'result'],
});

// D3 — Feedback do usuário (👍/👎) por agente, exposto ao A2
export const userFeedbackTotal = new client.Counter({
  name: 'user_feedback_total',
  help: 'Feedback do usuário sobre respostas dos agentes (type: like|dislike)',
  labelNames: ['type', 'agent'],
});

// Resiliência — fallback de LLM por nível da cascata.
// Observabilidade de degradação: quantos requests serviram de um modelo pior
// (safe/economic/provider reroute) em vez do primário. Pico = alarme de qualidade.
// Labels:
//   level: 'explicit' | 'economic' | 'provider' | 'governance'
//   from_model: modelo primário que falhou
//   to_model: modelo de fallback usado
export const llmFallbackCounter = new client.Counter({
  name: 'llm_fallback_total',
  help: 'Total de fallbacks de LLM por nível da cascata (degradação servida como sucesso)',
  labelNames: ['level', 'from_model', 'to_model', 'agent_name', 'agent_version'],
});

// Prompt caching do provider (OpenRouter/DeepSeek cache implícito server-side).
// cached_tokens > 0 = cache hit (tokens lidos do cache, cobrados a ~0.1× preço).
// Observabilidade para confirmar que o cache automático do DeepSeek está ativo.
// Se cached_tokens consistentemente 0, o sticky routing não está funcionando.
export const llmPromptCacheTokens = new client.Counter({
  name: 'llm_prompt_cache_tokens_total',
  help: 'Tokens lidos do cache de prompt do provider (cache hit = economia de custo)',
  labelNames: ['model', 'provider', 'agent_name', 'agent_version'],
});

// EMB-001/EMB-003: Embedding provider observability.
// `provider` is enumerated: local | openai | openrouter | auto.
// `degraded` is 'true' when a remote call failed and we fell back to local
// (transient degradation), or when the configured provider is local for RAG
// (persistent degradation — semantic recall is poor).
// Bounded cardinality — no free-form model ids or alias strings.
export const embeddingProviderTotal = new client.Counter({
  name: 'embedding_provider_total',
  help: 'Embedding generation calls by provider and degradation state',
  labelNames: ['provider', 'degraded', 'operation'],
});

export const embeddingDegradedTotal = new client.Counter({
  name: 'embedding_degraded_total',
  help: 'Embedding fallback-to-local events (transient remote failures)',
  labelNames: ['reason'],
});

// Rerank observability — tracks the effective bounded route.
// `provider` is enumerated: cohere-openrouter | none.
export const rerankEffectiveTotal = new client.Counter({
  name: 'rerank_effective_total',
  help: 'Rerank invocations by effective provider (cohere-openrouter or none)',
  labelNames: ['provider'],
});

export const rerankFailureTotal = new client.Counter({
  name: 'rerank_failure_total',
  help: 'Rerank failures that fell back to original retrieval order',
});

// GH-003 (P2-03): GitHub API observability — tracks tool fallback usage
// and failures so we can see how often the indexed table is empty and
// the live GitHub API is used instead.
export const githubToolFallbackTotal = new client.Counter({
  name: 'github_tool_fallback_total',
  help: 'GitHub live-API fallback invocations by tool and source',
  labelNames: ['tool', 'source'],
});

export const githubToolFailureTotal = new client.Counter({
  name: 'github_tool_failure_total',
  help: 'GitHub live-API fallback failures by tool',
  labelNames: ['tool'],
});

// DOC-002 (P2-03): DocuMente export observability — tracks export
// attempts, idempotent skips, and failures.
export const documenteExportTotal = new client.Counter({
  name: 'documente_export_total',
  help: 'DocuMente export attempts by doc_type and outcome',
  labelNames: ['doc_type', 'outcome'],
});

export const documenteExportFailureTotal = new client.Counter({
  name: 'documente_export_failure_total',
  help: 'Terminal DocuMente export failures by bounded reason',
  labelNames: ['reason'],
});

// SKILL-001 (P1-02): skill raw fetch observability — tracks total fetches
// and failures by reason (invalid-host, http-status, non-text-content-type,
// oversized, timeout, exception).
export const skillFetchTotal = new client.Counter({
  name: 'skill_fetch_total',
  help: 'Total external skill content fetch attempts (GitHub raw)',
  labelNames: ['success'],
});

export const skillFetchFailureTotal = new client.Counter({
  name: 'skill_fetch_failure_total',
  help: 'External skill fetch failures by reason',
  labelNames: ['reason'],
});

export const openRouterBalanceRefreshTotal = new client.Counter({
  name: 'openrouter_balance_refresh_total',
  help: 'OpenRouter balance refresh attempts by bounded result',
  labelNames: ['result'],
});

export const openRouterBalanceStateTotal = new client.Counter({
  name: 'openrouter_balance_state_total',
  help: 'Valid OpenRouter balance snapshots by bounded state',
  labelNames: ['state'],
});

// Spec 012: segurança local e guardrails resilientes
export const wsUpgradeRejectedTotal = new client.Counter({
  name: 'ws_upgrade_rejected_total',
  help: 'WebSocket upgrades rejeitados por motivo (origin | demand_not_found)',
  labelNames: ['reason'],
});

export const uploadRejectedTotal = new client.Counter({
  name: 'upload_rejected_total',
  help: 'Uploads rejeitados por motivo (multer_limit | budget | signature | zip_bomb)',
  labelNames: ['reason'],
});

export const guardrailDegradedTotal = new client.Counter({
  name: 'guardrail_degraded_total',
  help: 'Vereditos unavailable de guardrail por modo (fail_closed | fail_open_logged)',
  labelNames: ['mode'],
});

// Spec 015 B3 (M-07): perdas de escrita de auditoria/segurança observáveis.
export const auditWriteLossTotal = new client.Counter({
  name: 'audit_write_loss_total',
  help: 'Escritas de auditoria perdidas por destino (guardrail_log | safety_log | llm_audit_log | demand_error_state)',
  labelNames: ['sink'],
});

// Spec 018: handoff export bundle — bundles gerados e falhas por motivo.
export const handoffBundleTotal = new client.Counter({
  name: 'handoff_bundle_total',
  help: 'Handoff export bundles gerados com sucesso',
});

export const handoffBundleFailureTotal = new client.Counter({
  name: 'handoff_bundle_failure_total',
  help: 'Falhas de export de handoff bundle por motivo (prd_missing | not_found | internal)',
  labelNames: ['reason'],
});

// Spec 024: operações de escrita GitHub (Octokit)
export const githubWriteTotal = new client.Counter({
  name: 'github_write_total',
  help: 'Total de operações de escrita GitHub por tipo e resultado',
  labelNames: ['operation'],
});

export const githubWriteFailureTotal = new client.Counter({
  name: 'github_write_failure_total',
  help: 'Falhas de operações de escrita GitHub por tipo e motivo',
  labelNames: ['operation', 'reason'],
});

// Spec 10183: fallbacks de framework configurado para auto-suggest
export const frameworkFallbackTotal = new client.Counter({
  name: 'framework_fallback_total',
  help: 'Frameworks configurados que caíram para auto-suggest',
  labelNames: ['framework_id'],
});

// Registrar métricas customizadas
register.registerMetric(userFeedbackTotal);
register.registerMetric(llmFallbackCounter);
register.registerMetric(llmPromptCacheTokens);
register.registerMetric(embeddingProviderTotal);
register.registerMetric(embeddingDegradedTotal);
register.registerMetric(rerankEffectiveTotal);
register.registerMetric(rerankFailureTotal);
register.registerMetric(githubToolFallbackTotal);
register.registerMetric(githubToolFailureTotal);
register.registerMetric(documenteExportTotal);
register.registerMetric(documenteExportFailureTotal);
register.registerMetric(frameworkFallbackTotal);
register.registerMetric(githubContentIndexedTotal);
register.registerMetric(githubContentIndexFailureTotal);
register.registerMetric(toolExecutionDuration);
register.registerMetric(toolExecutionTimeoutTotal);
register.registerMetric(skillFetchTotal);
register.registerMetric(skillFetchFailureTotal);
register.registerMetric(openRouterBalanceRefreshTotal);
register.registerMetric(openRouterBalanceStateTotal);
register.registerMetric(wsUpgradeRejectedTotal);
register.registerMetric(uploadRejectedTotal);
register.registerMetric(guardrailDegradedTotal);
register.registerMetric(auditWriteLossTotal);
register.registerMetric(handoffBundleTotal);
register.registerMetric(handoffBundleFailureTotal);
register.registerMetric(githubWriteTotal);
register.registerMetric(githubWriteFailureTotal);
register.registerMetric(agentResponseSchemaResult);
register.registerMetric(squadGraphSize);
register.registerMetric(squadGraphBuilt);
register.registerMetric(squadGraphBuildFailureTotal);
register.registerMetric(agentTurnDurationSeconds);
register.registerMetric(squadAgentNodeDuration);
register.registerMetric(aiCallDuration);
register.registerMetric(aiFirstTokenDuration);
register.registerMetric(aiTokensUsage);
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(demandsByClassificationZone);
register.registerMetric(retrabalhoRateByZone);
register.registerMetric(classificationLatency);
register.registerMetric(classificationCostPerDemand);
register.registerMetric(hybridClassifierComparison);
register.registerMetric(discPromptTokensInjected);
register.registerMetric(contextSummarizationTokensSaved);
register.registerMetric(modelRoutingAdaptation);
register.registerMetric(documentHallucinationTotal);
register.registerMetric(numericProvenanceViolationsTotal);
register.registerMetric(citedPathViolationsTotal);
register.registerMetric(refinementStageBudgetRemainingMs);
register.registerMetric(refinementStageBudgetExpiredTotal);
register.registerMetric(prdGroundingDegradedTotal);
register.registerMetric(roundtableTotalDuration);
register.registerMetric(roundtableModeratorDuration);
register.registerMetric(roundtableAgentDuration);
register.registerMetric(roundtableTurnDuration);
register.registerMetric(roundtableTtft);
register.registerMetric(roundtableTurnsUsed);
register.registerMetric(roundtableExecutionMode);
register.registerMetric(roundtableCostUsdTotal);
register.registerMetric(roundtableTokensTotal);
register.registerMetric(roundtableCacheHitTotal);
register.registerMetric(aiModelFailureTotal);
register.registerMetric(featureFlagIoErrorTotal);
register.registerMetric(squadGraphFlagDegradedTotal);
register.registerMetric(cognitiveCoreBuildFailureTotal);
register.registerMetric(cognitiveCoreLatencyMs);
register.registerMetric(cognitiveCoreAgentsTotal);
register.registerMetric(cognitiveCoreDepthLevel);
register.registerMetric(demandTerminalStateTotal);
register.registerMetric(demandCreatedTotal);

export { register };
