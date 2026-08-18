import { resolvePath } from '@shared/utils/paths';
import { isTestEnvironment } from '@shared/database-policy';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '../utils/logger';

export const demandTypeRuleSchema = z.object({
  requireBaseline: z.boolean(),
  evidenceMode: z.enum(['verified', 'conceptual']),
  allowHallucinatedPaths: z.literal(false).catch(false),
});

export const demandTypeRulesSchema = z.record(demandTypeRuleSchema);

export const featureFlagsSchema = z.object({
  // Demanda 10074: desligada por padrão para manter o Claude como caminho legado.
  multi_agent_routing: z.boolean().default(false),
  multi_agent_routing_override: z.enum(['claude', 'codex']).optional(),
  enableRefactoringFeatures: z.boolean().default(false),
  enableNewProductFeatures: z.boolean().default(false),
  enableEnhancedValidation: z.boolean().default(false),
  enableUserFeedbackSystem: z.boolean().default(false),
  enableImprovementParallelSubset: z.boolean().default(false),
  enableParallelSubsetForAllTypes: z.boolean().default(false),
  enableAgentRouter: z.boolean().default(false),
  enableAgentRouterShadowMode: z.boolean().default(false),
  enableRequestTelemetry: z.boolean().default(false),
  enableTaskClassification: z.boolean().default(false),
  enableHybridClassifier: z.boolean().default(false),
  hybridClassifierInfluenceEnabled: z.boolean().default(true),
  hybridClassifierAmbiguousZoneLow: z.number().min(0).max(100).default(30),
  hybridClassifierAmbiguousZoneHigh: z.number().min(0).max(100).default(70),
  enableLlmAuditLog: z.boolean().default(false),
  enableLlmGuardrails: z.boolean().default(false),
  enableAgentStreaming: z.boolean().default(false),
  enableDiscPersonalization: z.boolean().default(false),
  enablePmInnovationAgent: z.boolean().default(false),
  streamingPilotAgents: z.array(z.string()).default([]),
  enablePromptVersioning: z.boolean().default(false),
  enablePgVector: z.boolean().default(false),
  enableQueryIntentDetection: z.boolean().default(false),
  enableRagFeedbackLoop: z.boolean().default(false),
  enableRefinementHybridSearch: z.boolean().default(false),
  enableLocalEmbeddings: z.boolean().default(false),
  enableLocalEmbeddingsForRAG: z.boolean().default(false),
  enableSemanticCache: z.boolean().default(false),
  semanticCacheSimilarityThreshold: z.number().min(0).max(1).default(0.9),
  enableLlmTracing: z.boolean().default(false),
  enableTraceExport: z.boolean().default(false),
  traceSampleRate: z.number().min(0).max(1).default(1),
  redTeamEnabled: z.boolean().default(false),
  roundtableModeratorMode: z.enum(['llm', 'round-robin', 'hybrid']).default('hybrid'),
  enableRoundtableStreaming: z.boolean().default(false),
  enableParallelAgents: z.boolean().default(false),
  roundtableParallelConcurrency: z.number().int().min(1).max(3).default(3),
  selfConsistencyEnabled: z.boolean().default(false),
  // Spec 10039 T9 — otimização de custo: default N=2 (era 3). N=3 segue disponível.
  selfConsistencyN: z.number().min(1).default(2),
  selfConsistencyThreshold: z.number().min(0).max(1).default(0.6),
  selfConsistencyMaxExtraRounds: z.number().min(0).default(2),
  contextEngineeringEnabled: z.boolean().default(false),
  contextHistoryK: z.number().min(0).default(6),
  enableContextSummarization: z.boolean().default(false),
  contextSummarizationThreshold: z.number().int().min(6).default(15),
  enableAdaptiveModelRouting: z.boolean().default(false),
  adaptiveModelRoutingShadowMode: z.boolean().default(true),
  adaptiveModelRoutingMinSamples: z.number().int().min(1).default(20),
  agentResponseSchemaPilot: z.boolean().default(false),
  agentResponseSchemaPilotAgents: z.array(z.string()).default([]),
  numericProvenanceEmissionEnabled: z.boolean().default(false),
  citedPathValidationEnabled: z.boolean().default(false),
  // Spec 10014: gate de alucinações antes de commitar o handoff no repo destino.
  // 'dry-run' (coleta+loga, não bloqueia), 'blocking' (aborta em issue crítica),
  // 'off' (desligado). Default 'dry-run' para calibrar sem frustrar (US1).
  handoffValidationGateMode: z.enum(['off', 'dry-run', 'blocking']).default('dry-run'),
  // Spec 10007: commit AUTOMÁTICO do handoff no repo destino ao concluir cada
  // refinamento. Default FALSE — auto-escrita em repo real é opt-in explícito
  // (exige GITHUB_WRITE_TOKEN e repoFullName na demanda). Ver handoff-service.ts.
  handoffAutoCommitEnabled: z.boolean().default(false),
  semanticInjectionClassifierEnabled: z.boolean().default(true),
  semanticInjectionEnforceEnabled: z.boolean().default(true),
  // Spec 012 (H-07/FR-009): fail-closed p/ operações sensíveis quando guardrail indisponível.
  guardrailsFailClosedSensitiveOps: z.boolean().default(true),
  // Spec 10015 (FR-015): rollout gradual do modo go-live (fast-track). Default
  // false — quando desligado, o toggle no formulário não aparece e goLiveMode é
  // forçado a false na persistência, mesmo que o cliente envie true.
  goLiveEnabled: z.boolean().default(false),
  fewShotInjectionEnabled: z.boolean().default(false),
  // B5: escala 0-100 (mesma de efficacy.score; neutro = 50). Antes estava max(1),
  // incompatível com o score → a flag não conseguia filtrar nada.
  fewShotMinEfficacy: z.number().min(0).max(100).default(0),
  typedStateContextEnabled: z.boolean().default(false),
  squadGraphEnabled: z.boolean().default(false),
  // Demanda 10100: delegação de subtarefas por agentes coordenadores.
  enableSubagentDelegation: z.boolean().default(false),
  maxDelegationCostPerTask: z.number().min(0).default(2.0),
  maxConcurrentSubagents: z.number().int().min(1).default(3),
  subagentTimeoutMs: z.number().int().min(1000).default(30000),
  // B6: porta a consolidação estruturada (8 campos) do roundtable para o caminho
  // assíncrono. Default on; quando on, prependa o bloco estruturado ao PRD.
  asyncStructuredConsolidationEnabled: z.boolean().default(true),
  // ── SpecKit conformance — validação síncrona de PRD/Tasks contra o schema ──
  // Fonte da verdade: shared/spec-schemas.ts. Orquestrador (retry + needs_review):
  // server/cognitive-core/spec-conformance.ts. Default OFF: rollout controlado —
  // quando on, PRD/Tasks passam pela validação síncrona conforme o SpecKit.
  specKitConformanceEnabled: z.boolean().default(false),
  // Demanda 10078: módulo de retrospectiva automatizada (SM + squad analisam
  // demandas/repos de um período e sintetizam aprendizados). Default OFF:
  // rotas /api/retrospective respondem 404 até validar custo/qualidade.
  retrospectiveModuleEnabled: z.boolean().default(false),
  // Demanda 10089 (item 1): gate técnico — POST de demandas retorna 400 quando
  // não há repositório vinculado. Default OFF: enforcement destrutivo no endpoint
  // principal é opt-in; ligar só depois de validar que o fluxo sempre manda repo.
  enforceRepoUrlOnDemands: z.boolean().default(false),
  // Demanda 10089 (item 2): exige causa técnica (failure_category) ao parar uma
  // demanda. Default OFF — ligar só quando a UI mandar o campo, senão o botão
  // "parar" quebra para quem já está com a tela aberta.
  enforceFailureCategory: z.boolean().default(false),
  // Demanda 10089 (item 3): exige learning_log ao fechar uma demanda como completed.
  // Default OFF — enforcement é opt-in até o time adaptar o processo.
  enforceLearningLogOnComplete: z.boolean().default(false),
  // Demanda 10089 (item 4): exige qa_evidence (1 cenário negativo) ao fechar completed.
  // Default OFF — rollout controlado.
  enforceQaChecklistOnComplete: z.boolean().default(false),
  // Demanda 10089 (item 5): expõe classificação de esforço P/M/G no formulário.
  // Default OFF — campo é sempre aceito pela API, mas a UI pode optar por mostrar.
  enableDemandSizeClassification: z.boolean().default(false),
  // Demanda 10092: análise por LLM da retrospectiva. Default OFF — só ligar
  // depois de 3-5 retros "puras" (snapshot + ações), para ter com o que comparar.
  retro_llm_analysis: z.boolean().default(false),
  // Demanda 10081 parte A: seleção semântica de agentes para a mesa redonda
  // (substitui a squad fixa de 7 quando o cliente não manda lista explícita).
  // Default OFF: rollout controlado, mesmo padrão das flags acima.
  enableDynamicAgentTriage: z.boolean().default(false),
  // Demanda 10081 parte B: permite que um agente não selecionado inicialmente
  // seja acionado no meio do refinamento se a discussão revelar necessidade.
  enableDynamicAgentEscalation: z.boolean().default(false),
  // ── Seção 14 — Otimização de custo e tokens ──────────────────────────────
  // 1g: Feature flag para cache do roundtable (default false → rollout controlado)
  enableRoundtableCache: z.boolean().default(false),
  // TTL do cache do moderador em ms (default 1h)
  roundtableCacheModeratorTtlMs: z.number().int().min(0).default(3_600_000),
  // TTL do cache da consolidação em ms (default 24h)
  roundtableCacheConsolidationTtlMs: z.number().int().min(0).default(86_400_000),
  // 6b: N de self-consistency para nível 2 (default 2, menor que nível 3)
  // .int(): N amostras deve ser inteiro; max(5) impede custo explosivo
  selfConsistencyNLevel2: z.number().int().min(1).max(5).default(2),
  // 4a: Histórico máximo do moderador em turnos (default 3)
  // max(20): acima disso o prompt do moderador fica muito longo
  moderatorMaxHistoryTurns: z.number().int().min(1).max(20).default(3),
  // 4c: maxTokens do moderador.
  // Bug #10141: deepseek-v4-flash-202605 consome ~156 tokens em reasoning_content;
  // com max_tokens=180 restavam ~24 tokens para o JSON, que saía truncado/vazio.
  // max(500): teto de segurança; JSON do moderador cabe confortavelmente em ~265.
  moderatorMaxTokens: z.number().int().min(50).max(500).default(500),
  // Spec 10126: timeout por turno de agente (ms). 0 desabilita.
  agentTurnTimeoutMs: z.number().int().min(0).default(60_000),
  // Spec 10126: TTL em dias para limpeza da tabela agent_memory. 0 desabilita.
  agentMemoryTtlDays: z.number().int().min(0).default(90),
  // Spec 10126 T3: redirecionar demand-classifier.ts para agent-router.ts.
  // Default false até validação completa em produção.
  demandClassifierUseAgentRouter: z.boolean().default(false),
  // ── Spec 007 — Política de evidência e baseline por tipo de demanda ──────
  // Defaults CONSERVADORES (FR-005): sem config, todo tipo exige baseline e
  // evidência verificada; alucinação de paths nunca é permitida.
  demandTypeRules: demandTypeRulesSchema.default({}),
  evidenceExtensions: z
    .array(z.string())
    .default(['.ts', '.tsx', '.json', '.js', '.jsx', '.css', '.md']),
});

const featureFlagsOverrideSchema = featureFlagsSchema.partial();

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
export type DemandTypeRuleConfig = FeatureFlags['demandTypeRules'][string];

/**
 * Overrides de runtime: flags alteradas pela UI admin são gravadas em um arquivo
 * separado (NÃO versionado), e têm precedência sobre o `feature-flags.json` base.
 *
 * Motivo de ser arquivo (e não DB): o projeto não tem migração para isso e o
 * padrão de config mutável já existente é em memória/arquivo. O arquivo de base
 * permanece sob git como "default"; os overrides são o estado operacional.
 */
class FeatureFlagsService {
  private flags: FeatureFlags = featureFlagsSchema.parse({});
  private lastLoaded = 0;
  private readonly TTL_MS = 60_000; // 1 minute TTL
  private flagsPath = resolvePath('config/feature-flags.json');
  private overridesPath = resolvePath('config/feature-flags.overrides.json');

  private overrides: Partial<FeatureFlags> = {};
  private overridesLoaded = false;

  private validateAndLog(raw: unknown, source: string): FeatureFlags {
    const result = featureFlagsSchema.safeParse(raw);
    if (!result.success) {
      logger.warn(`Feature flags validation failed for ${source}`, {
        context: {
          source,
          errors: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      // Fallback to defaults for invalid values; keep partial valid data when possible
      return featureFlagsSchema.parse({});
    }
    return result.data;
  }

  private validateOverrides(raw: unknown, source: string): Partial<FeatureFlags> {
    const result = featureFlagsOverrideSchema.safeParse(raw);
    if (!result.success) {
      logger.warn(`Feature flag overrides validation failed for ${source}`, {
        context: {
          source,
          errors: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return {};
    }
    return result.data;
  }

  private loadOverrides(): void {
    if (this.overridesLoaded) return;
    try {
      if (fs.existsSync(this.overridesPath)) {
        const raw = JSON.parse(fs.readFileSync(this.overridesPath, 'utf8'));
        // Overrides são parciais: aplicar defaults aqui faria chaves ausentes
        // sobrescreverem silenciosamente a configuração base.
        this.overrides = this.validateOverrides(raw, 'overrides');
      }
    } catch (error) {
      logger.warn('Failed to load feature-flags.overrides.json', {
        error: error instanceof Error ? error : undefined,
      });
    }
    this.overridesLoaded = true;
  }

  private loadBaseFlags(): void {
    const now = Date.now();
    if (now - this.lastLoaded > this.TTL_MS) {
      try {
        if (fs.existsSync(this.flagsPath)) {
          const raw = JSON.parse(fs.readFileSync(this.flagsPath, 'utf8'));
          this.flags = this.validateAndLog(raw, 'base');
        }
        this.lastLoaded = now;
      } catch (error) {
        logger.warn('Failed to load feature-flags.json', {
          error: error instanceof Error ? error : undefined,
        });
        // Use last known flags on failure
      }
    }
  }

  /** Flags efetivas: base do arquivo + overrides de runtime (override vence). */
  public getFlags(): FeatureFlags {
    this.loadBaseFlags();
    this.loadOverrides();
    return { ...this.flags, ...this.overrides };
  }

  /** Define (ou atualiza) um override de runtime e persiste no arquivo de overrides. */
  public setOverride<K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]): void {
    this.loadOverrides();
    const testPayload = { ...this.overrides, [key]: value };
    const validated = this.validateOverrides(testPayload, 'override-set');
    this.overrides = validated;
    this.persistOverrides();
  }

  /** Remove um override; a flag volta a seguir o valor do arquivo base. */
  public clearOverride<K extends keyof FeatureFlags>(key: K): void {
    this.loadOverrides();
    if (key in this.overrides) {
      delete this.overrides[key];
      this.persistOverrides();
    }
  }

  /** True se a chave tem um override de runtime ativo (vs. valor do arquivo base). */
  public hasOverride<K extends keyof FeatureFlags>(key: K): boolean {
    this.loadOverrides();
    return key in this.overrides;
  }

  private persistOverrides(): void {
    // Sob teste, os overrides valem só em memória. `setOverride` gravava no
    // config/feature-flags.overrides.json REAL do projeto: foi assim que
    // `maxDelegationCostPerTask: 0.0001` (fixture de tests/unit/
    // subagent-delegation.test.ts) acabou no arquivo de configuração, contra o
    // 2.0 do arquivo base. Mesmo padrão do banco isolado em database-policy.
    if (isTestEnvironment()) return;

    try {
      fs.mkdirSync(path.dirname(this.overridesPath), { recursive: true });
      fs.writeFileSync(this.overridesPath, JSON.stringify(this.overrides, null, 2) + '\n', 'utf8');
    } catch (error) {
      logger.error('Failed to persist feature-flags.overrides.json', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }
}

export const featureFlags = new FeatureFlagsService();
