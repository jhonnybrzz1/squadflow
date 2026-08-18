import {
  type Demand,
  type ChatMessage,
  type RefinementType,
  type EvidenceBlock,
} from '@shared/schema';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { agentResponseSchemaResult, discPromptTokensInjected } from '../metrics';
import { openAIService } from './openai-ai';
import { aiUsageTracker, estimateTextTokens } from './ai-usage-tracker';
import { frameworkManager } from '../frameworks';
import { gitHubService } from './github';
import { contextBuilder } from './context-builder';
import type { ValidationIssue } from './improvement-execution';
import { renderFewShotBlock } from './few-shot-bank';
import { RealityBasedRefinement } from '../cognitive-core/reality-based-refinement';
import { featureFlags } from './feature-flags';
import { getDemandTypeConfig } from '@shared/demand-types';
import { canonicalAgentKey } from './agent-identity';
import { sseManager } from './sse/manager';
import { demandRepository } from '../repositories/demand-repository';
import { resolvePromptVersion, executeAgentWithGenericTools } from './ai-squad-utils';
import { isAgentToolsEnabled } from './agent-tools-registry';
import { eventBus } from '../events/event-bus';
import { orchestrationRuntimeService } from './orchestration-runtime';
import { initializeAgentTools } from './agent-tools-init';
import { promptVersionService } from './prompt-version';
import { resolveModel } from './llm-model-router';
import {
  AgentFactory,
  applySoloBuilderPrompt,
  applyKnowledgeCutoffPrompt,
  type SquadAgent,
  type SquadAgentConfig,
} from './ai-squad/AgentFactory';
import { SquadCoordinator } from './ai-squad/squad-coordinator';
import { DocumentGenerator } from './ai-squad/document-generator';
import { buildRoundtablePRDContent } from './ai-squad/roundtable-prd';
import {
  applyDiscPersonalityToAgentConfigs,
  applyPmInnovationAgentActivation,
  detectPmInnovationTrigger,
  type AgentPromptConfig,
  type PmInnovationActivation,
} from './disc-personality';

// Piloto Fase 2 / Faixa B: instrução do Response Contract (bloco JSON estruturado
// emitido ALÉM do markdown). Ativada apenas atrás de flag para o agente piloto.
const RESPONSE_CONTRACT_INSTRUCTION = `=== CONTRATO DE RESPOSTA (OBRIGATÓRIO) ===
Ao final da sua resposta, mantenha o texto em markdown e adicione um bloco "Response Contract" em JSON válido com EXATAMENTE estes campos:

**Response Contract:**
\`\`\`json
{
  "analysis": "string",
  "problem": "string",
  "impact": "string",
  "recommendation": "string",
  "roi": "string (formato X:1)",
  "effort": "string (ex: 3 dias)",
  "priority": "Crítico|Importante|Desejável"
}
\`\`\`
Não omita nenhum campo. O campo "priority" deve ser exatamente Crítico, Importante ou Desejável.`;

export class AISquadService {
  public coordinator: SquadCoordinator;
  public documentGenerator: DocumentGenerator;
  public agents: SquadAgent[] = [];
  public agentConfigs: Record<string, SquadAgentConfig> = {};
  public realityBasedRefinement: RealityBasedRefinement;
  public githubLoginCache: { login: string | null; fetchedAt: number } = {
    login: null,
    fetchedAt: 0,
  };

  constructor() {
    this.coordinator = new SquadCoordinator(this);
    this.documentGenerator = new DocumentGenerator(this);
    this.realityBasedRefinement = new RealityBasedRefinement();
    this.loadAgentConfigurations();
    this.initializeCognitiveCore();
    this.initializeFrameworkManager();
    initializeAgentTools();
  }

  // ============================================
  // SSE Methods (agora delegados ao sseManager)
  // ============================================

  public addSSEConnection(
    demandId: number,
    connection: { res: unknown; lastEventId: number },
  ): string {
    return sseManager.addConnection(
      demandId,
      connection.res as Parameters<typeof sseManager.addConnection>[1],
    );
  }

  public removeSSEConnection(demandId: number): void {
    sseManager.removeConnection(demandId);
  }

  public sendSSEUpdate(demandId: number, data: Record<string, unknown>): void {
    sseManager.sendProgress(demandId, 0, { demand: data });
  }

  public async initializeCognitiveCore(): Promise<void> {
    try {
      logger.info('AICHATflow Cognitive Core inicializado', {
        context: { components: ['DemandClassifier', 'AgentOrchestrator'] },
      });
    } catch (error) {
      logger.error('Erro ao inicializar Cognitive Core', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  public async initializeFrameworkManager(): Promise<void> {
    try {
      await frameworkManager.initialize();
      logger.info('Framework Manager inicializado', {
        context: {
          frameworks: [
            'JTBD',
            'HEART',
            'Severity x Priority',
            'Double Diamond',
            'CRISP-DM',
            'AI Framework Suggestion',
          ],
        },
      });
    } catch (error) {
      logger.error('Erro ao inicializar Framework Manager', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  public loadAgentConfigurations(): void {
    const factory = new AgentFactory();
    const { agents, agentConfigs } = factory.loadConfigurations();
    this.agents = agents;
    this.agentConfigs = agentConfigs;
  }

  public getIconForAgent(agentName: string): string {
    return new AgentFactory().getIconForAgent(agentName);
  }

  public async getAuthenticatedGitHubLogin(): Promise<string | null> {
    const now = Date.now();
    if (now - this.githubLoginCache.fetchedAt < 10 * 60 * 1000) {
      return this.githubLoginCache.login;
    }

    try {
      const response = await gitHubService.client.users.getAuthenticated();
      const login = response.data.login || null;
      this.githubLoginCache = { login, fetchedAt: now };
      return login;
    } catch (_) {
      this.githubLoginCache = { login: null, fetchedAt: now };
      return null;
    }
  }

  public extractReferencedRepositories(description: string): string[] {
    const repos: string[] = [];
    const repoRegex = /Reposit[oó]rio:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = repoRegex.exec(description)) !== null) {
      repos.push(match[1].toLowerCase());
    }
    return [...new Set(repos)];
  }

  public stopRequests = new Set<number>();
  private activeProcessingCounts = new Map<number, number>();

  // Incidente 2026-07-17: uma demanda foi reprocessada 387× em loop, pagando
  // rerank/LLM a cada tentativa. Circuit breaker por demanda: após
  // MAX_CONSECUTIVE_FAILURES falhas seguidas, novas execuções são recusadas
  // até o cooldown expirar (ou até uma execução bem-sucedida zerar o contador).
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
  private consecutiveFailures = new Map<number, { count: number; blockedUntil: number }>();
  private autoRecoveryTimers = new Map<number, NodeJS.Timeout>();

  /** Lança se a demanda estourou o limite de falhas consecutivas (fail-fast barato). */
  private assertNotInFailureCooldown(demandId: number): void {
    const state = this.consecutiveFailures.get(demandId);
    if (!state) return;
    if (state.count >= AISquadService.MAX_CONSECUTIVE_FAILURES && Date.now() < state.blockedUntil) {
      const retryInSeconds = Math.ceil((state.blockedUntil - Date.now()) / 1000);
      throw new Error(
        `Demanda ${demandId} falhou ${state.count}x consecutivas — reprocessamento bloqueado por ${retryInSeconds}s para evitar gasto em loop. Use stop/reset explícito ou aguarde o cooldown.`,
      );
    }
  }

  private recordProcessingOutcome(demandId: number, succeeded: boolean): void {
    if (succeeded) {
      this.resetFailureCooldown(demandId);
      return;
    }
    const state = this.consecutiveFailures.get(demandId) ?? { count: 0, blockedUntil: 0 };
    state.count += 1;
    if (state.count >= AISquadService.MAX_CONSECUTIVE_FAILURES) {
      state.blockedUntil = Date.now() + AISquadService.FAILURE_COOLDOWN_MS;
      logger.error('Circuit breaker de reprocessamento aberto para a demanda', {
        context: {
          demandId,
          consecutiveFailures: state.count,
          cooldownMs: AISquadService.FAILURE_COOLDOWN_MS,
        },
      });
      this.scheduleAutoRecovery(demandId, AISquadService.FAILURE_COOLDOWN_MS);
    }
    this.consecutiveFailures.set(demandId, state);
  }

  private scheduleAutoRecovery(demandId: number, delayMs: number): void {
    if (this.autoRecoveryTimers.has(demandId)) {
      clearTimeout(this.autoRecoveryTimers.get(demandId)!);
    }

    const timer = setTimeout(async () => {
      this.autoRecoveryTimers.delete(demandId);
      this.resetFailureCooldown(demandId);

      try {
        const demand = await demandRepository.findByIdOrNull(demandId);
        if (!demand || demand.status !== 'error') return;

        const { demandGenerationJobsService } = await import('./demand-generation-jobs');
        const { enqueueDemandGenerationJob } = await import('../workers/demand-generation-worker');

        const latestJob = await demandGenerationJobsService.findLatestByDemandId(demandId);
        if (!latestJob) return;

        logger.info(
          'Circuit breaker cooldown expirado — re-enfileirando automaticamente demanda para reprocessamento',
          {
            context: { demandId, jobId: latestJob.id },
          },
        );

        const newJobId = await demandGenerationJobsService.enqueue(demandId, latestJob.config);
        // 'routed' é o estado ATIVO de demanda aguardando/iniciando processamento
        // (union fechado em shared/demand-status.ts não inclui 'pending').
        await demandRepository.update(demandId, { status: 'routed', errorMessage: null });
        enqueueDemandGenerationJob({
          id: newJobId,
          demandId,
          config: latestJob.config,
          status: 'pending',
          attempts: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (err) {
        logger.error('Erro ao tentar auto-reprocessar demanda após cooldown do circuit breaker', {
          error: err instanceof Error ? err : undefined,
          context: { demandId },
        });
      }
    }, delayMs + 1000);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.autoRecoveryTimers.set(demandId, timer);
  }

  /** Reset interno (testes / reset explícito do operador). */
  resetFailureCooldown(demandId: number): void {
    if (this.autoRecoveryTimers.has(demandId)) {
      clearTimeout(this.autoRecoveryTimers.get(demandId)!);
      this.autoRecoveryTimers.delete(demandId);
    }
    this.consecutiveFailures.delete(demandId);
  }

  isStopRequested(demandId: number): boolean {
    return this.stopRequests.has(demandId);
  }

  isProcessingActive(demandId: number): boolean {
    return this.activeProcessingCounts.has(demandId);
  }

  private markProcessingActive(demandId: number): void {
    this.activeProcessingCounts.set(demandId, (this.activeProcessingCounts.get(demandId) ?? 0) + 1);
  }

  private markProcessingInactive(demandId: number): void {
    const current = this.activeProcessingCounts.get(demandId) ?? 0;
    if (current <= 1) {
      this.activeProcessingCounts.delete(demandId);
      return;
    }
    this.activeProcessingCounts.set(demandId, current - 1);
  }

  async stopProcessing(demandId: number): Promise<void> {
    if (this.isProcessingActive(demandId)) {
      this.stopRequests.add(demandId);
    } else {
      this.stopRequests.delete(demandId);
    }

    await demandRepository.update(demandId, {
      status: 'stopped',
      currentAgent: null,
      errorMessage: null,
    });
    sseManager.sendProgress(demandId, 100, {
      demand: await demandRepository.findByIdOrNull(demandId),
      agent: 'system',
      message: 'Stop request accepted',
      type: 'completed',
      timestamp: new Date().toISOString(),
    });
    this.notifyDemandUpdate(demandId);
  }

  async assembleInternalContext(demand: Demand): Promise<string> {
    return await this.coordinator.assembleInternalContext(demand);
  }

  async processDemandRoundtable(
    demandId: number,
    config: { agentIds: string[]; maxRounds: number; refinementLevel?: 1 | 2 | 3 },
    onProgress?: (message: ChatMessage) => void,
  ): Promise<void> {
    this.assertNotInFailureCooldown(demandId);
    const pipelineId = randomUUID();
    const startedAt = Date.now();
    let runId: string | undefined;
    let succeeded = false;
    this.markProcessingActive(demandId);
    try {
      await demandRepository.updateStatus(demandId, 'processing');
      const demandForRuntime = await demandRepository.findById(demandId);

      runId = orchestrationRuntimeService.startRun({
        demandId,
        pipelineId,
        mode: 'roundtable',
        agentOrder: config.agentIds,
        regulatoryContext: demandForRuntime.domain ?? null,
        sensitivityLevel: null,
        normaReferencia: null,
        metadata: {
          maxRounds: config.maxRounds,
          refinementLevel: config.refinementLevel ?? 3,
          source: 'processDemandRoundtable',
        },
      });

      eventBus.publish('ORCHESTRATION_STARTED', {
        timestamp: new Date().toISOString(),
        pipelineId,
        runId,
        demandId,
        status: 'started',
        metadata: {
          totalAgents: config.agentIds.length,
          mode: 'roundtable',
          maxRounds: config.maxRounds,
          refinementLevel: config.refinementLevel ?? 3,
        },
      });

      const throwIfStopped = async () => {
        if (!this.isStopRequested(demandId)) return;
        await demandRepository.updateStatus(demandId, 'stopped');
        throw new Error('Execution stopped by user');
      };

      const result = await this.coordinator.processRoundtable(demandId, config, onProgress, {
        runId,
        pipelineId,
      });

      await throwIfStopped();

      const demand = await demandRepository.findById(demandId);
      const realityConstraints = contextBuilder.getRealityConstraints(demandId);
      const consolidationText = buildRoundtablePRDContent(result.consolidation, {
        demandTitle: demand.title,
        demandType: demand.type,
        demandDescription: demand.description,
        refinementType: demand.refinementType,
        rounds: result.rounds,
        totalDivergences: result.totalDivergences,
        agentsFailed: result.agentsFailed,
        typeRequirements: realityConstraints?.typeRequirements,
      });

      await throwIfStopped();

      const prdPath = await this.saveDocument(demandId, 'PRD', consolidationText);
      await throwIfStopped();
      const tasksContent = await this.generateTasksWithPM(demand, consolidationText);
      await throwIfStopped();
      const tasksPath = await this.saveDocument(demandId, 'Tasks', tasksContent);

      await throwIfStopped();

      // P0 grounding: o veredito factual roda sobre os documentos ENTREGUES
      // (PRD + Tasks), não só sobre a consolidação interna — eles são montados
      // aqui, depois que processRoundtable já retornou. A persistência do gate
      // acontece antes do `completed` e PROPAGA em caso de erro: um refinamento
      // cujo veredito não pôde ser gravado não sai como aprovado.
      const factualGate = await this.coordinator.gateFinalDocuments(
        demandId,
        `${consolidationText}\n\n${tasksContent}`,
      );

      await demandRepository.update(demandId, {
        status: 'completed',
        progress: 100,
        prdUrl: prdPath,
        tasksUrl: tasksPath,
        // Sem condicional: `gateFinalDocuments` sempre devolve veredito (pacote
        // ausente vira warning + revisão humana). O spread condicional que havia
        // aqui era a última forma do fail-open — deixava `completed` sair sem
        // campos de gate.
        qualityGateStatus: factualGate.status,
        requiresHumanReview: factualGate.requiresHumanReview,
        ...this.getDemandCostTelemetry(demandId),
        roundtableSummary: {
          totalRounds: result.rounds.length,
          divergences: result.totalDivergences,
          agentContributions: Object.fromEntries(
            Object.entries(
              result.rounds.reduce(
                (acc, r) => {
                  for (const agent of Object.keys(r.contributions)) {
                    acc[agent] = (acc[agent] || 0) + 1;
                  }
                  return acc;
                },
                {} as Record<string, number>,
              ),
            ),
          ),
          consolidation: result.consolidation.consolidacao,
          // Demanda 10081 parte B: agentes acionados no meio do refinamento.
          escalations: result.escalations ?? [],
        },
      });

      // Persiste o parecer do anti-overengineering, se ele participou da
      // rodada. Não-fatal por dentro: falha aqui não derruba a orquestração
      // que já concluiu.
      await this.persistAntiOverengineeringIntervention(
        demandId,
        result.rounds.flatMap((round) =>
          Object.entries(round.contributions).map(([agent, message]) => ({ agent, message })),
        ),
      );

      eventBus.publish('ORCHESTRATION_COMPLETED', {
        timestamp: new Date().toISOString(),
        pipelineId,
        runId,
        demandId,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        metadata: {
          totalAgents: config.agentIds.length,
          successCount: Math.max(0, config.agentIds.length - result.agentsFailed.length),
          failedCount: result.agentsFailed.length,
          totalDivergences: result.totalDivergences,
          totalRounds: result.rounds.length,
        },
      });

      this.notifyDemandUpdate(demandId);
      succeeded = true;
    } catch (err) {
      // Evidência pendente não pode sobreviver a um refinamento abortado: a
      // execução seguinte seria gateada contra o pacote da anterior. Envolvido
      // em try/catch porque limpeza dentro de um `catch` que lança MASCARA o
      // erro original — foi o que aconteceu com rerank-cost-guards, onde
      // 'no such table' virou 'discardEvidence is not a function'.
      try {
        this.coordinator.discardEvidence?.(demandId);
      } catch {
        /* limpeza best-effort: nunca pode substituir o erro real */
      }
      const msg = err instanceof Error ? err.message : 'unknown';
      const isStoppedByUser = msg === 'Execution stopped by user' || this.isStopRequested(demandId);
      if (isStoppedByUser) {
        this.stopRequests.delete(demandId);
        if (runId) {
          orchestrationRuntimeService.stopRun(runId, {
            metadata: { durationMs: Date.now() - startedAt },
          });
        }
        await demandRepository.updateStatus(demandId, 'stopped');
        this.notifyDemandUpdate(demandId);
        logger.info('Roundtable interrompido pelo usuario', { context: { demandId } });
        return;
      }

      if (runId) {
        eventBus.publish('ORCHESTRATION_FAILED', {
          timestamp: new Date().toISOString(),
          pipelineId,
          runId,
          demandId,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          error: msg,
        });
      }
      await demandRepository.markAsError(demandId, msg);
      throw err;
    } finally {
      this.markProcessingInactive(demandId);
      this.recordProcessingOutcome(demandId, succeeded);
    }
  }

  notifyDemandUpdate(demandId: number): void {
    return this.coordinator.notifyDemandUpdate(demandId);
  }

  private getDemandCostTelemetry(demandId: number): {
    promptTokens: number;
    completionTokens: number;
    custoEstimado: number;
  } {
    const usage = aiUsageTracker.getUsageForDemand(demandId);
    return {
      promptTokens: usage.tokensIn,
      completionTokens: usage.tokensOut,
      custoEstimado: Number(usage.costEstimated.toFixed(8)),
    };
  }

  private async syncDemandCostTelemetry(demandId: number): Promise<void> {
    await demandRepository.update(demandId, this.getDemandCostTelemetry(demandId));
    this.notifyDemandUpdate(demandId);
  }

  public getRefinementLevels(type: string): number {
    return getDemandTypeConfig(type).refinementLevel;
  }

  public isPromptVersioningEnabled(): boolean {
    try {
      const flags = featureFlags.getFlags();
      return !!flags.enablePromptVersioning;
    } catch (_) {
      return false;
    }
  }

  public isStreamingEnabledForAgent(agentName: string): boolean {
    try {
      const flags = featureFlags.getFlags();
      if (!flags.enableAgentStreaming) return false;
      const pilotAgents: string[] = flags.streamingPilotAgents || [];
      return pilotAgents.includes(agentName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Piloto Fase 2 / Faixa B: indica se o agente deve emitir e validar o Response
   * Contract (schema zod). Requer a master flag agentResponseSchemaPilot ligada E o
   * agente presente em agentResponseSchemaPilotAgents (default ['scrum_master'],
   * preservando o piloto original). Mesmo formato de gating do streaming.
   */
  public isResponseContractEnabledForAgent(agentName: string): boolean {
    try {
      const flags = featureFlags.getFlags();
      if (flags.agentResponseSchemaPilot !== true) return false;
      const pilotAgents: string[] = flags.agentResponseSchemaPilotAgents || ['scrum_master'];
      return pilotAgents.includes(agentName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Fase 4 / slice 3: injeção do banco de few-shot no prompt do agente, atrás da flag
   * fewShotInjectionEnabled (default off).
   */
  public isFewShotInjectionEnabled(): boolean {
    try {
      return featureFlags.getFlags().fewShotInjectionEnabled === true;
    } catch (_) {
      return false;
    }
  }

  public isDiscPersonalizationEnabled(): boolean {
    try {
      const flags = featureFlags.getFlags();
      return flags.enableDiscPersonalization !== false;
    } catch (_) {
      return true;
    }
  }

  public isPmInnovationAgentEnabled(): boolean {
    try {
      const flags = featureFlags.getFlags();
      return flags.enablePmInnovationAgent !== false;
    } catch (_) {
      return true;
    }
  }

  public resolvePmInnovationActivation(demand: Demand): PmInnovationActivation {
    if (!this.isPmInnovationAgentEnabled()) {
      return { triggered: false, matchedKeywords: [], confidence: 0 };
    }
    return detectPmInnovationTrigger(demand);
  }

  public prepareAgentConfigsForDemand<T extends AgentPromptConfig>(
    scopedConfigs: Record<string, T>,
    demand: Demand,
  ): {
    configs: Record<string, T>;
    personalityApplied: boolean;
    pmInnovation: PmInnovationActivation;
  } {
    const pmInnovation = this.resolvePmInnovationActivation(demand);
    const withInnovation = applyPmInnovationAgentActivation(
      scopedConfigs,
      this.agentConfigs as Record<string, T>,
      pmInnovation,
    );
    const personalized = applyDiscPersonalityToAgentConfigs(withInnovation, {
      enabled: this.isDiscPersonalizationEnabled(),
    });
    if (personalized.applied && personalized.promptBlock) {
      discPromptTokensInjected.inc(
        estimateTextTokens(personalized.promptBlock) * Object.keys(personalized.configs).length,
      );
    }

    return {
      configs: personalized.configs,
      personalityApplied: personalized.applied,
      pmInnovation,
    };
  }

  public async processWithAgent(
    agentName: string,
    demand: Demand,
    refinementLevels: number,
    internalContext: string, // New parameter
  ): Promise<{ message: string; evidence?: EvidenceBlock }> {
    const intensityLevel = this.getIntensityByType(demand.type);
    const agentConfig = this.agentConfigs[agentName];

    // Build operational orientation for context-aware agents
    const operationalOrientation = this.buildOperationalOrientationForAgent(
      demand.description || '',
    );

    // --- Dynamic Prompt Version Resolution ---
    // 🟢 Guard clause: usa filesystem config se versionamento falhar
    const versionResult = await resolvePromptVersion(
      agentName,
      demand.id,
      demand.executionId ?? undefined,
    );
    const { resolvedSystemPrompt, promptVersionUsed, abTestId } = versionResult;

    // Use resolved versioned prompt, or fall back to filesystem config
    // FR-004 (spec 10004): garante consciência de data de corte mesmo quando o prompt
    // vem do resolvedor de versão (A/B), que pode contornar a config já composta pelo
    // AgentFactory. Idempotente — não duplica se o suffix já estiver presente.
    const baseSystemPrompt = applyKnowledgeCutoffPrompt(
      applySoloBuilderPrompt(resolvedSystemPrompt || agentConfig?.system_prompt),
    );
    const fallbackSystemPrompt = applyKnowledgeCutoffPrompt(
      applySoloBuilderPrompt(
        `Você é um ${agentName} experiente em uma squad de desenvolvimento. Responda SEMPRE em português brasileiro. Seja objetivo e prático nas suas respostas. Tipo de demanda: ${demand.type}. Nível de refinamento: ${refinementLevels}/4. Intensidade de análise: ${intensityLevel}.`,
      ),
    )!;

    // Prepend the internal context to the agent's system prompt
    const composedSystemPrompt = `${internalContext}

${
  baseSystemPrompt
    ? `${baseSystemPrompt}

Contexto adicional: Tipo de demanda: ${demand.type}. Nível de refinamento: ${refinementLevels}/4. Intensidade de análise: ${intensityLevel}.`
    : fallbackSystemPrompt
}`;

    // Piloto Fase 2 / Faixa B: atrás de flag, os agentes piloto também emitem um
    // Response Contract (bloco JSON) validado por schema, que dirige o loop de reparo.
    const responseContractPilot = this.isResponseContractEnabledForAgent(agentName);
    // Fase 4 / slice 3: injeção de exemplos de referência (few-shot), atrás de flag.
    const fewShotBlock = this.isFewShotInjectionEnabled() ? renderFewShotBlock(agentName) : '';
    const systemPrompt = [
      composedSystemPrompt,
      responseContractPilot ? RESPONSE_CONTRACT_INSTRUCTION : '',
      fewShotBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Include operational orientation in user prompt when context signals are present
    const baseUserPrompt = agentConfig?.description
      ? `Para esta ${demand.type}, ${agentConfig.description.toLowerCase()}: ${demand.description}`
      : `Analise a demanda: ${demand.description}`;

    const userPrompt = operationalOrientation
      ? `${baseUserPrompt}

--- ORIENTAÇÃO OPERACIONAL (usar como contexto, NÃO perguntar sobre estes itens) ---
${operationalOrientation}`
      : baseUserPrompt;

    const llmStartTime = Date.now();
    const metricModel = agentConfig?.model ?? resolveModel({ taskType: 'analysis' });
    try {
      const defaultMaxTokens =
        intensityLevel === 'baixa' ? 1600 : intensityLevel === 'media' ? 3000 : 5000;
      let maxTokens = agentConfig?.max_tokens ?? defaultMaxTokens;

      // [Economia] Se o agente tem max_tokens fixo no YAML, calibra dinamicamente
      // de acordo com a intensidade estimada para evitar desperdício em tarefas simples.
      if (agentConfig?.max_tokens) {
        if (intensityLevel === 'baixa') {
          maxTokens = Math.min(agentConfig.max_tokens, 1200);
        } else if (intensityLevel === 'media') {
          maxTokens = Math.min(agentConfig.max_tokens, 2000);
        }
      }
      const temperature = agentConfig?.temperature ?? 0.7;
      const model = agentConfig?.model || undefined;
      const modelFallback = agentConfig?.model_fallback || undefined;

      let response = '';
      let agentToolsTrailer = '';
      let finalResponse = '';
      let validation: {
        isValid: boolean;
        score: number;
        issues: string[];
        structuredIssues?: ValidationIssue[];
        evidence?: EvidenceBlock;
        cleanMessage?: string;
      } = { isValid: false, score: 0, issues: [] };

      let iteration = 0;
      const maxIterations = 2;
      let currentUserPrompt = userPrompt;
      let lastScore = -1;

      while (iteration <= maxIterations) {
        if (iteration > 0) {
          // Prioriza pendências bloqueantes (severity 'error') no contrato unificado
          // e anota severidade/categoria; cai para issues simples se não houver
          // structuredIssues (ex.: estado inicial).
          const pendencias =
            validation.structuredIssues && validation.structuredIssues.length > 0
              ? [...validation.structuredIssues]
                  .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
                  .map(
                    (i) =>
                      `- [${i.severity === 'error' ? 'BLOQUEANTE' : 'aviso'}] [${i.category}] ${i.message}`,
                  )
                  .join('\n')
              : validation.issues.map((i: string) => `- ${i}`).join('\n');

          currentUserPrompt = `${userPrompt}

=== FEEDBACK DE AUTO-CORREÇÃO (REFLEXION) ===
Sua resposta anterior não atendeu totalmente aos critérios de validação de qualidade (Score atual: ${validation.score}/100).
Ajuste sua análise para resolver as seguintes pendências encontradas (resolva primeiro as marcadas como BLOQUEANTE):
${pendencias}

INSTRUÇÕES DE MELHORIA:
1. Certifique-se de que a resposta tenha uma estrutura clara com seções de **Análise:**, **Recomendação:**, **ROI:**, **Esforço:** e **Prioridade:**.
2. Cite dados concretos e referências reais a arquivos/linhas de código se cabível.
3. Não remova as seções e blocos que já estão corretos. Mantenha os blocos de evidências reais.`;
        }

        // Executar a chamada do LLM correspondente
        if (isAgentToolsEnabled(agentName)) {
          const toolsResult = await executeAgentWithGenericTools(
            systemPrompt,
            currentUserPrompt,
            agentName,
            model,
            modelFallback,
            temperature,
            maxTokens,
            demand.id,
            demand,
          );
          response = toolsResult.response;
          agentToolsTrailer = toolsResult.trailer;
        } else {
          response = '';
        }

        if (response) {
          // Já produziu resposta por tools ou fan-out
        } else if (this.isStreamingEnabledForAgent(agentName) && iteration === 0) {
          const demandId = demand.id;
          let firstChunkSent = false;

          response = await openAIService.generateChatCompletionStreaming(
            systemPrompt,
            currentUserPrompt,
            {
              demandId,
              demandDescription: demand.description,
              temperature,
              maxTokens,
              model,
              modelFallback,
              taskType: 'analysis',
              operation: `agent:${agentName}:streaming`,
              agentName,
              onChunk: (chunk: string) => {
                if (!firstChunkSent) {
                  firstChunkSent = true;
                  logger.info('First streaming chunk sent', {
                    context: { agentName, demandId, latencyFromStartMs: Date.now() },
                  });
                }
                const operationId = demand.executionId || String(demandId);
                sseManager.sendAgentChunk(demandId, agentName, chunk, undefined, {
                  operationId,
                  agent_id: agentName,
                });
              },
              onReasoningChunk: (reasoningChunk: string) => {
                const operationId = demand.executionId || String(demandId);
                sseManager.sendAgentReasoningChunk(demandId, agentName, reasoningChunk, undefined, {
                  operationId,
                  agent_id: agentName,
                });
              },
              onStreamEnd: () => {
                const operationId = demand.executionId || String(demandId);
                sseManager.sendEvent(
                  'agent_stream_end',
                  demandId,
                  { agent: agentName },
                  undefined,
                  {
                    operationId,
                    agent_id: agentName,
                  },
                );
              },
            },
          );
        } else {
          response = await openAIService.generateChatCompletion(systemPrompt, currentUserPrompt, {
            demandId: demand.id,
            demandDescription: demand.description,
            temperature,
            maxTokens,
            model,
            modelFallback,
            taskType: 'analysis',
            operation: `agent:${agentName}${iteration > 0 ? ':reflection' : ''}`,
            agentName,
          });
        }

        finalResponse = response || `${agentName} processou a demanda com sucesso.`;

        // Validar
        validation = await contextBuilder.validateAgentResponse(finalResponse, demand);

        // Piloto Faixa B: valida o Response Contract (schema zod) sobre o texto já
        // sem o Evidence Block e remove o bloco do conteúdo que segue ao downstream.
        // Falhas de schema viram erros bloqueantes que reabrem o loop de reparo.
        if (responseContractPilot) {
          const contract = contextBuilder.validateResponseContract(
            validation.cleanMessage ?? finalResponse,
          );
          // B4: taxa de falha de schema por agente (alimenta o A2).
          agentResponseSchemaResult.labels(agentName, contract.valid ? 'valid' : 'invalid').inc();
          validation = {
            ...validation,
            cleanMessage: contract.cleanMessage,
            ...(contract.valid
              ? {}
              : {
                  isValid: false,
                  issues: [...validation.issues, ...contract.issues.map((i) => i.message)],
                  structuredIssues: [...(validation.structuredIssues ?? []), ...contract.issues],
                }),
          };
        }

        if (validation.isValid) {
          if (iteration > 0) {
            logger.info('[Agent Reflection] Resposta corrigida e validada com sucesso', {
              context: { agentName, demandId: demand.id, score: validation.score, iteration },
            });
          }
          break;
        }

        logger.warn('[Agent Reflection] Resposta do agente falhou nos critérios de validação', {
          context: {
            agentName,
            demandId: demand.id,
            score: validation.score,
            issues: validation.issues,
            iteration,
          },
        });

        // Convergence Check: parar se o score não melhorar nas iterações adicionais
        if (lastScore !== -1 && validation.score <= lastScore) {
          logger.warn(
            '[Agent Reflection] Interrompendo reflexão precoce por falta de convergência de score',
            {
              context: { agentName, demandId: demand.id, score: validation.score, lastScore },
            },
          );
          break;
        }

        lastScore = validation.score;
        iteration++;
      }

      const llmEndTime = Date.now();

      // Record prompt version metric (async, fire-and-forget)
      promptVersionService.recordMetric({
        promptName: agentName,
        version: promptVersionUsed,
        sessionId: demand.executionId || String(demand.id),
        demandId: demand.id,
        model: metricModel,
        successFlag: validation.isValid,
        latencyMs: llmEndTime - llmStartTime,
        abTestId,
      });

      if (!validation.isValid) {
        logger.warn('Validação de resposta do agente falhou', {
          context: {
            agentName,
            demandId: demand.id,
            score: validation.score,
            issues: validation.issues,
          },
        });
        // Return structured response even if validation fails
        return {
          message:
            this.createStructuredResponse(
              agentName,
              validation.cleanMessage || finalResponse,
              validation,
            ) + agentToolsTrailer,
          evidence: validation.evidence,
        };
      }

      // Retorna mensagem limpa + evidência validada para o caller anexar ao metadata
      return {
        message: (validation.cleanMessage || finalResponse) + agentToolsTrailer,
        evidence: validation.evidence,
      };
    } catch (error) {
      // Record failure metric
      promptVersionService.recordMetric({
        promptName: agentName,
        version: promptVersionUsed,
        sessionId: demand.executionId || String(demand.id),
        demandId: demand.id,
        model: metricModel,
        successFlag: false,
        abTestId,
      });
      logger.error('Erro ao processar com agente', {
        error: error instanceof Error ? error : undefined,
        context: { agentName, demandId: demand.id },
      });
      return {
        message: `${agentName} encontrou um erro: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  public createStructuredResponse(
    agentName: string,
    rawResponse: string,
    validation: {
      score: number;
      issues: string[];
      evidence?: EvidenceBlock;
    },
  ): string {
    // Try to extract structured information from raw response
    const analysisMatch = rawResponse.match(/\*\*Análise:\*\*(.*?)(?=\*\*|$)/s);
    const problemMatch = rawResponse.match(/\*\*Problema Identificado:\*\*(.*?)(?=\*\*|$)/s);
    const impactMatch = rawResponse.match(/\*\*Impacto:\*\*(.*?)(?=\*\*|$)/s);
    const recommendationMatch = rawResponse.match(/\*\*Recomendação:\*\*(.*?)(?=\*\*|$)/s);
    const roiMatch = rawResponse.match(/\*\*ROI:\*\*(.*?)(?=\*\*|$)/s);
    const effortMatch = rawResponse.match(/\*\*Esforço:\*\*(.*?)(?=\*\*|$)/s);
    const priorityMatch = rawResponse.match(/\*\*Prioridade:\*\*(.*?)(?=\*\*|$)/s);

    const structuredResponse = `
**Análise:** ${analysisMatch ? analysisMatch[1].trim() : 'Análise não fornecida'}
**Problema Identificado:** ${problemMatch ? problemMatch[1].trim() : 'Problema não identificado'}
**Impacto:** ${impactMatch ? impactMatch[1].trim() : 'Impacto não especificado'}
**Recomendação:** ${recommendationMatch ? recommendationMatch[1].trim() : 'Nenhuma recomendação específica'}
**ROI:** ${roiMatch ? roiMatch[1].trim() : 'ROI não calculado'}
**Esforço:** ${effortMatch ? effortMatch[1].trim() : 'Esforço não estimado'}
**Prioridade:** ${priorityMatch ? priorityMatch[1].trim() : 'Desejável'}

---
**Validação:** Score ${validation.score}/100
**Problemas:** ${validation.issues.length > 0 ? validation.issues.join(', ') : 'Nenhum'}
**Nota:** Resposta estruturada automaticamente para conformidade`;

    return structuredResponse;
  }

  /**
   * Parses the anti-overengineering agent message and persists a structured
   * intervention record.  Called after every multi-agent interaction.
   * Non-fatal: logs warnings and returns silently on any error.
   */
  public async persistAntiOverengineeringIntervention(
    demandId: number,
    conversationHistory: Array<{
      agent: string;
      message: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const aoeMsg = conversationHistory
      .slice()
      .reverse()
      .find((m) => canonicalAgentKey(m.agent) === 'anti_overengineering');

    if (!aoeMsg) return; // agent didn't run for this demand type

    try {
      const { agentInterventionService } = await import('./agent-intervention-service');

      const text = aoeMsg.message;

      // ── Extract Problema Identificado (→ pontosOverengineering array) ──
      const problemaMatch = text.match(/\*\*Problema Identificado:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const problemaRaw = problemaMatch ? problemaMatch[1].trim() : '';
      const pontosOverengineering = problemaRaw
        ? problemaRaw
            .split(/\n+/)
            .map((l) => l.replace(/^[-•*]\s*/, '').trim())
            .filter(Boolean)
        : ['Ponto de overengineering não identificado'];

      // ── Extract Recomendação (→ escopoReduzido) ──
      const recomMatch = text.match(/\*\*Recomenda[çc][aã]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const escopoReduzido = recomMatch ? recomMatch[1].trim() : 'Escopo reduzido não especificado';

      // ── Extract ROI ──
      const roiMatch = text.match(/\*\*ROI:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      const roiEstimado = roiMatch ? roiMatch[1].trim() : 'N/A';

      // ── Extract Esforço (in days) ──
      //
      // O agente emite "12 dias -> 3 dias" (original -> reduzido). Os DOIS
      // números importam: `dias_economizados` é a diferença, então capturar só
      // um deixa a métrica nula — era o que acontecia antes.
      //
      // Formato antigo (um número só) continua aceito e é lido como o esforço
      // reduzido, sem original — aí a economia fica nula, corretamente: não dá
      // para medir economia sem saber de quanto se partiu.
      const esforcoMatch = text.match(/\*\*Esfor[çc]o:\*\*(.*?)(?=\*\*[A-Z]|$)/s);
      let esforcoOriginalDias: number | null = null;
      let esforcoReduzidoDias: number | null = null;
      if (esforcoMatch) {
        const numeros = [...esforcoMatch[1].matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) =>
          parseFloat(m[1].replace(',', '.')),
        );
        if (numeros.length >= 2) {
          [esforcoOriginalDias, esforcoReduzidoDias] = numeros;
        } else if (numeros.length === 1) {
          esforcoReduzidoDias = numeros[0];
        }
      }

      // ── Extract model from metadata ──
      const modelRouting = aoeMsg.metadata?.modelRouting as Record<string, unknown> | undefined;
      const modelo = (modelRouting?.modelUsed as string | undefined) ?? null;

      await agentInterventionService.create({
        demandId,
        pontosOverengineering,
        escopoReduzido,
        roiEstimado,
        esforcoOriginalDias,
        esforcoReduzidoDias,
        modelo,
      });

      logger.info('Parecer anti-overengineering persistido', {
        context: { demandId, pontosCount: pontosOverengineering.length, roiEstimado },
      });
    } catch (error) {
      logger.warn('Falha ao persistir parecer anti-overengineering (não-fatal)', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      });
    }
  }

  public getIntensityByType(type: string): 'baixa' | 'media' | 'alta' {
    return getDemandTypeConfig(type).intensity;
  }

  public isImprovementParallelEnabled(): boolean {
    try {
      const flags = featureFlags.getFlags();
      return flags.enableImprovementParallelSubset === true;
    } catch (_) {
      return false;
    }
  }

  public isGeneralParallelEnabled(): boolean {
    try {
      const flags = featureFlags.getFlags();
      return flags.enableParallelSubsetForAllTypes === true;
    } catch (_) {
      return false;
    }
  }

  public getDemandTypePrdGuidance(type: string): string {
    const config = getDemandTypeConfig(type);
    const requirements = config.typeRequirements
      .map((requirement) => `- ${requirement}`)
      .join('\n');

    return `Tipo de Demanda: ${config.label}
Template Esperado: ${config.prdTemplate}
Saída Esperada: ${config.outputType}
Esforço Máximo: ${config.maxEffortDays} dias
Requisitos Obrigatórios por Tipo:
${requirements}`;
  }

  public validatePilotQualityInvariants(
    demand: Demand,
    prdContent: string,
    templatePassed: boolean,
  ): {
    qaPassed: boolean;
    blockers: string[];
    invariants: Record<string, boolean>;
  } {
    return this.documentGenerator.validatePilotQualityInvariants(
      demand,
      prdContent,
      templatePassed,
    );
  }

  // ===== PROMPTS DIFERENCIADOS POR TIPO DE REFINAMENTO =====

  /**
   * Returns the mandatory `**Evidence Block:**` trailer to be appended to
   * every PRD/TDD-style prompt. Sharing this template across the three
   * document prompts guarantees the PM/Tech Lead emits a verifiable JSON
   * block at the end of the document, which `validateDocumentEvidence`
   * then parses and checks against the real repository.
   *
   * Without this block, the document prompts asked for "at least 3
   * concrete signals" in prose — which the model satisfied by inventing
   * plausible-sounding file paths (the very bug we're closing here).
   */
  public getDocumentEvidenceTrailer(): string {
    return `

--- EVIDENCE BLOCK (OBRIGATÓRIO NO FIM DO DOCUMENTO) ---
Anexe ao FINAL do documento, separado do conteúdo principal, este bloco em JSON
listando APENAS arquivos e referências verificados pelos agentes durante o
refinamento. Se nenhum arquivo concreto foi citado pela squad, use sourceType
"blocked" com evidenceFiles vazio.

NÃO invente nomes de arquivos para "preencher" a lista. É melhor um bloco
"blocked" do que um bloco com paths fabricados.

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read" | "fallback_rag" | "blocked",
  "repoContext": {
    "owner": "string",
    "repo": "string",
    "branch": "string"
  },
  "evidenceFiles": ["caminho/real/citado/pela/squad.ts"]
}
\`\`\``;
  }

  public getImprovementPRDPrompt(insightsSummary: string, isTechnical: boolean): string {
    return this.documentGenerator.getImprovementPRDPrompt(insightsSummary, isTechnical);
  }

  public getTechnicalPRDPrompt(insightsSummary: string): string {
    return this.documentGenerator.getTechnicalPRDPrompt(insightsSummary);
  }

  public getBusinessPRDPrompt(insightsSummary: string): string {
    return this.documentGenerator.getBusinessPRDPrompt(insightsSummary);
  }

  // ===== NOVOS MÉTODOS: Geração de PRD e Tasks com PM (FORA DO LOOP) =====
  // Agora com validação anti-overengineering integrada
  // ATUALIZADO: Suporta diferentes templates baseados no refinementType

  public async generatePRDWithPM(
    demand: Demand,
    refinementMessages: ChatMessage[],
    model?: string,
    forceIsTechnical?: boolean,
  ): Promise<string> {
    return await this.documentGenerator.generatePRDWithPM(
      demand,
      refinementMessages,
      model,
      forceIsTechnical,
    );
  }

  public buildOperationalOrientation(description: string): string {
    return this.documentGenerator.buildOperationalOrientation(description);
  }

  public resolveDocumentGenerationModel(model?: string, isTechnical?: boolean): string {
    return this.documentGenerator.resolveDocumentGenerationModel(model, isTechnical);
  }

  public resolveDocumentGenerationFallback(
    model?: string,
    isTechnical?: boolean,
  ): string | undefined {
    return this.documentGenerator.resolveDocumentGenerationFallback(model, isTechnical);
  }

  public resolveDemandRefinementType(demand: Demand): RefinementType {
    const direct = demand.refinementType as RefinementType;
    if (direct === 'technical' || direct === 'business') {
      return direct;
    }

    const classification = demand.classification as
      { refinementType?: unknown; category?: unknown; type?: unknown } | null | undefined;
    const candidates = [
      classification?.refinementType,
      classification?.category,
      classification?.type,
    ];
    if (candidates.some((candidate) => candidate === 'technical')) {
      return 'technical';
    }
    if (candidates.some((candidate) => candidate === 'business')) {
      return 'business';
    }

    return null;
  }

  public buildOperationalOrientationForAgent(description: string): string {
    return this.documentGenerator.buildOperationalOrientationForAgent(description);
  }

  public getImprovementTasksPrompt(insightsSummary: string): string {
    return this.documentGenerator.getImprovementTasksPrompt(insightsSummary);
  }

  public async generateTasksWithPM(
    demand: Demand,
    prdContent: string,
    model?: string,
  ): Promise<string> {
    return await this.documentGenerator.generateTasksWithPM(demand, prdContent, model);
  }

  public async saveDocument(demandId: number, type: string, content: string): Promise<string> {
    return await this.documentGenerator.saveDocument(demandId, type, content);
  }
}

export const aiSquadService = new AISquadService();
