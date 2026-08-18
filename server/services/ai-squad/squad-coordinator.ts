import { AISquadService } from '../ai-squad';
import { type Demand, type ChatMessage } from '@shared/schema';
import { demandRepository } from '../../repositories/demand-repository';
import { logger } from '../../utils/logger';
import { cognitiveCoreBuildFailureTotal } from '../../metrics';
import { contextAssembler } from './context-assembler';
import { beginGoLiveScope, endGoLiveScope } from '../go-live-scope';
import {
  RoundtableOrchestrator,
  type RoundtableConfig,
  type RoundtableResult,
  type RoundtableRuntimeContext,
} from './roundtable-orchestrator';
import type { CognitiveCoreOutput, OrchestrationPlan } from '../../orchestration-contracts';
import {
  collectRepoEvidence,
  formatEvidenceForPrompt,
  type RepoEvidencePackage,
} from '../repo-evidence-collector';
import { evaluateFactualClaims, type FactualGateResult } from '../factual-claims-gate';

export class SquadCoordinator {
  private parent: AISquadService;
  private roundtableOrchestrator: RoundtableOrchestrator;
  /** Pacote de evidência por demanda, consumido pelo gate do documento final. */
  private readonly evidenceByDemand = new Map<number, RepoEvidencePackage>();

  constructor(parent: AISquadService) {
    this.parent = parent;
    this.roundtableOrchestrator = new RoundtableOrchestrator(parent);
  }

  /**
   * Paralelizado: `contextBuilder.buildContext()` e `refinementRAGService.buildContext()`
   * são independentes (o repoLock é síncrono, derivado de `demand`). Antes eram
   * sequenciais (~2× latência). Agora rodam em paralelo via Promise.allSettled,
   * preservando o fallback degradado (RAG falha → continua com base context).
   */
  public async assembleInternalContext(
    demand: Demand,
    cognitiveOutput?: CognitiveCoreOutput,
  ): Promise<string> {
    return contextAssembler.assembleInternalContext(demand, cognitiveOutput);
  }

  /**
   * Spec 10145: monta contexto interno para o caminho roundtable, injetando
   * RealityConstraints no contexto evolutivo.
   */
  private async assembleInternalContextForRoundtable(
    demand: Demand,
    cognitiveOutput?: CognitiveCoreOutput,
  ): Promise<string> {
    return contextAssembler.assembleInternalContext(
      demand,
      cognitiveOutput,
      this.parent.realityBasedRefinement,
    );
  }

  /**
   * Spec 10144: constrói o output cognitivo unificado a partir do pipeline
   * declarado (agent-orchestrator + reality-constraints), servindo de ponte
   * para o pipeline vivo.
   */
  async buildCognitiveCoreOutput(demand: Demand): Promise<CognitiveCoreOutput | null> {
    try {
      const { agentOrchestrator } = await import('../../cognitive-core/agent-orchestrator');
      const plan: OrchestrationPlan = await agentOrchestrator.createOrchestrationPlan(demand.id);

      const constraints = await this.parent.realityBasedRefinement.getConstraintsForDemandType(
        demand.type,
      );

      // Lazy import para evitar dependência circular estática ai-squad → cognitive-core.
      // Spec 10149: cognitive-config-adapter é consumido apenas no runtime do caminho
      // roundtable, quando o plano já foi gerado pelo agent-orchestrator.
      const { adaptCognitiveCoreOutput } =
        await import('../../cognitive-core/cognitive-config-adapter');
      return adaptCognitiveCoreOutput({
        demand,
        classification: plan.classification,
        constraints,
      });
    } catch (error) {
      cognitiveCoreBuildFailureTotal.labels(String(demand.id)).inc();
      logger.warn(
        '[SquadCoordinator] Falha ao construir cognitive core output; seguindo sem adapter',
        {
          error: error instanceof Error ? error : undefined,
          context: { demandId: demand.id },
        },
      );
      return null;
    }
  }

  public notifyDemandUpdate(demandId: number): void {
    logger.debug('Notificando atualização da demanda via SSE', { context: { demandId } });

    // Obter a demanda atualizada e enviar via SSE
    demandRepository
      .findByIdOrNull(demandId)
      .then((demand) => {
        if (demand) {
          this.parent.sendSSEUpdate(demandId, demand as Record<string, unknown>);
        }
      })
      .catch((error) => {
        logger.warn('Erro ao obter demanda para notificação SSE', {
          error: error instanceof Error ? error : undefined,
          context: { demandId },
        });
      });
  }

  /**
   * Persiste o gate factual SEMPRE — inclusive `passed`.
   *
   * A versão anterior era fail-open em dois pontos: retornava cedo quando
   * passava (deixando `qualityGateStatus` null, indistinguível de "nunca
   * avaliado") e engolia erro de persistência, permitindo `completed` sem gate
   * gravado. Agora o erro PROPAGA: um refinamento cujo veredito não pôde ser
   * registrado não pode ser apresentado como aprovado.
   */
  private async persistFactualGate(demandId: number, gate: FactualGateResult): Promise<void> {
    if (gate.status !== 'passed') {
      logger.warn('roundtable: gate factual não passou', {
        context: {
          demandId,
          status: gate.status,
          reason: gate.reason,
          unsupportedClaims: gate.unsupportedClaims.length,
          reasons: gate.unsupportedClaims.map((c) => c.reason),
        },
      });
    }

    await demandRepository.update(demandId, {
      qualityGateStatus: gate.status,
      requiresHumanReview: gate.requiresHumanReview,
    } as never);
  }

  /**
   * Avalia o texto FINAL (PRD/Tasks) contra a evidência e persiste o veredito.
   *
   * Exposto porque o PRD é montado em `ai-squad.ts` DEPOIS que
   * `processRoundtable` retorna: gatear só `result.consolidation` deixava o
   * documento efetivamente entregue fora da verificação.
   */
  public async gateFinalDocuments(demandId: number, documents: string): Promise<FactualGateResult> {
    const evidencePackage = this.evidenceByDemand.get(demandId);
    if (!evidencePackage) {
      // Fail-CLOSED: o pacote sumir do mapa é violação de invariante — quem
      // chegou aqui passou por processRoundtable, que sempre o registra quando
      // há inspeção. Devolver null deixava o fluxo concluir sem campos de gate.
      logger.error('roundtable: pacote de evidência ausente no gate final', {
        context: { demandId, reason: 'evidence_package_missing' },
      });
      const gate: FactualGateResult = Object.freeze({
        status: 'warning' as const,
        requiresHumanReview: true,
        unsupportedClaims: Object.freeze([]),
        reason: 'pacote de evidência ausente no gate final (invariante violada)',
      });
      await this.persistFactualGate(demandId, gate);
      return gate;
    }
    try {
      const gate = evaluateFactualClaims(documents, evidencePackage);
      await this.persistFactualGate(demandId, gate);
      return gate;
    } finally {
      // Sempre — inclusive quando a persistência lança. Sem isto o mapa crescia
      // sem limite e uma execução seguinte podia ser gateada contra evidência
      // obsoleta da anterior.
      this.evidenceByDemand.delete(demandId);
    }
  }

  /** Descarta evidência pendente (caminhos que não chegam ao gate final). */
  public discardEvidence(demandId: number): void {
    this.evidenceByDemand.delete(demandId);
  }

  async processRoundtable(
    demandId: number,
    config: RoundtableConfig,
    onProgress?: (message: ChatMessage) => void,
    runtimeContext?: RoundtableRuntimeContext,
  ): Promise<RoundtableResult> {
    const demand = await demandRepository.findById(demandId);

    // Spec 10015 US2/US4: ativa o escopo go-live para esta demanda enquanto dura
    // o processamento. Camadas fundas (ex.: llm-guardrails) leem via
    // isDemandGoLive(demandId). `finally` garante limpeza mesmo em exceção —
    // sem vazar estado entre demandas. Fail-safe: ausente ⇒ modo COMPLETO.
    beginGoLiveScope(demandId, demand?.goLiveMode === true);
    try {
      // Spec 10144: constrói cognitive-core SEMPRE para injetar reality
      // constraints e contexto enriquecido no roundtable (C1/H1/H2). A derivação
      // de agentIds a partir do cognitive-core só acontece quando config.agentIds
      // está vazio.
      const cognitiveOutput = await this.buildCognitiveCoreOutput(demand);

      // Lazy import: toRoundtableConfig precisa de CognitiveCoreOutput (contrato puro)
      // e vive junto ao adaptador no cognitive-core. Import dinâmico mantém ai-squad
      // livre de dependência estática com cognitive-core (spec 10149).
      const cognitiveConfig = cognitiveOutput
        ? (await import('../../cognitive-core/cognitive-config-adapter')).toRoundtableConfig(
            cognitiveOutput,
          )
        : null;

      const effectiveConfig = cognitiveConfig
        ? {
            ...cognitiveConfig,
            // Spec 10144: merge com agentIds já configurados (ex: DEFAULT_ROUNDTABLE_AGENTS
            // ou roundtableAgentIds vindo de demands.ts) para que specialists derivados do
            // cognitive-core (ex: security_specialist) sempre cheguem ao roundtable.
            agentIds:
              config.agentIds && config.agentIds.length > 0
                ? [...new Set([...config.agentIds, ...cognitiveConfig.agentIds])]
                : cognitiveConfig.agentIds,
            // Se a config original explicitou maxRounds/refinementLevel, respeita.
            maxRounds: config.maxRounds ?? cognitiveConfig.maxRounds,
            refinementLevel: config.refinementLevel ?? cognitiveConfig.refinementLevel,
          }
        : config;

      const internalContext = await this.assembleInternalContextForRoundtable(
        demand,
        cognitiveOutput ?? undefined,
      );

      // P0 grounding: etapa ÚNICA de coleta de evidência real antes da mesa.
      // O pacote é imutável e vira um bloco do contexto; sem ele, "confirmado no
      // código" não tinha nada contra o que ser verificado (demanda 10330).
      const evidencePackage = demand
        ? await collectRepoEvidence(demand)
        : await Promise.resolve(null);
      if (evidencePackage) this.evidenceByDemand.set(demandId, evidencePackage);
      const contextWithEvidence = evidencePackage
        ? `${internalContext}${formatEvidenceForPrompt(evidencePackage)}`
        : internalContext;

      const result = await this.roundtableOrchestrator.runRoundTable(
        demandId,
        effectiveConfig,
        contextWithEvidence,
        onProgress,
        runtimeContext,
      );

      // O veredito definitivo sai em `gateFinalDocuments`, sobre o PRD/Tasks
      // montados em ai-squad.ts. Aqui o gate roda sobre a consolidação para não
      // deixar o intervalo sem avaliação alguma.
      if (evidencePackage) {
        await this.persistFactualGate(
          demandId,
          evaluateFactualClaims(JSON.stringify(result.consolidation ?? {}), evidencePackage),
        );
      }
      return result;
    } finally {
      endGoLiveScope(demandId);
    }
  }
}
