import { demandRepository } from '../repositories/demand-repository';
import { demandClassifier } from './demand-classifier';
import { agentInteractionService } from '../services/agent-interaction';
import { contextBuilder } from '../services/context-builder';
import { featureFlags } from '../services/feature-flags';
import {
  buildSquadGraph,
  linearizeSquadGraph,
  type SquadGraph,
  type DemandClassification,
  type AgentExecutionResult,
  type CrossValidationResult,
  type OrchestrationPlan,
} from '../orchestration-contracts';
import { logger } from '../utils/logger';
import { aggregateDeterministicAgentValidations } from './agent-validation-policy';
import { generateRequestId } from '../utils/request-id';
import { env } from '../config/env';
import { agentFailureLogger } from '../services/agent-failure-logger';
import { eventBus } from '../events/event-bus';
import { AgentRole } from '../../shared/agent-roles';
import {
  squadGraphSize,
  squadGraphBuilt,
  squadAgentNodeDuration,
  squadGraphFlagDegradedTotal,
  squadGraphBuildFailureTotal,
} from '../metrics';

export type {
  AgentExecutionResult,
  CrossValidationResult,
  OrchestrationPlan,
  DemandClassification,
  SquadGraph,
} from '../orchestration-contracts';

/**
 * Avaliação de fluxo de agentes (2026-07-26, C-1): dependências stateful
 * injetáveis. `AgentOrchestrator` importava 13 módulos diretamente — os 6
 * abaixo são os que têm estado/IO real (repositório, classificador,
 * execução de agente, contexto, flags, eventos) e por isso valem a pena
 * mockar em teste sem precisar de `vi.mock` no nível do módulo inteiro.
 * Funções puras e utilitários cross-cutting (logger, métricas,
 * `buildSquadGraph`, `AgentRole`) continuam import estático — não têm
 * comportamento a substituir.
 */
export interface AgentOrchestratorDeps {
  demandRepository: typeof demandRepository;
  demandClassifier: typeof demandClassifier;
  agentInteractionService: typeof agentInteractionService;
  contextBuilder: typeof contextBuilder;
  featureFlags: typeof featureFlags;
  eventBus: typeof eventBus;
}

const defaultAgentOrchestratorDeps: AgentOrchestratorDeps = {
  demandRepository,
  demandClassifier,
  agentInteractionService,
  contextBuilder,
  featureFlags,
  eventBus,
};

/**
 * Agent Orchestrator - Manages the execution order of agents and cross-validation
 */
export class AgentOrchestrator {
  constructor(private readonly deps: AgentOrchestratorDeps = defaultAgentOrchestratorDeps) {}

  /**
   * Creates an orchestration plan for a demand
   * @param demandId - The ID of the demand
   * @returns Orchestration plan
   */
  async createOrchestrationPlan(demandId: number): Promise<OrchestrationPlan> {
    const requestId = generateRequestId();
    const startTime = Date.now();

    logger.info('Creating orchestration plan', {
      context: { requestId, demandId, step: 'plan_start' },
    });

    // Step 1: Fetch demand
    let stepStart = Date.now();
    const demand = await this.deps.demandRepository.findById(demandId);
    const fetchMs = Date.now() - stepStart;

    // Step 2: Classify the demand
    stepStart = Date.now();
    const classification = await this.deps.demandClassifier.classifyDemand(demand);
    const classifyMs = Date.now() - stepStart;

    // Step 3: Determine agent execution order
    stepStart = Date.now();
    const agentExecutionOrder = this.determineAgentExecutionOrder(classification);
    const orderMs = Date.now() - stepStart;

    // Step 3b (Fase 5 / slice 3): grafo explícito da squad, atrás de flag (default
    // off). Construído de forma consistente com `agentExecutionOrder`; só é anexado
    // ao plano se a linearização reproduzir a ordem (equivalente por construção).
    // Divergência nunca quebra: loga warning e segue sem grafo.
    const graph = this.buildSquadGraphIfEnabled(
      classification,
      agentExecutionOrder,
      demandId,
      requestId,
    );

    // Step 4: Determine if cross-validation is required
    const crossValidationRequired = this.isCrossValidationRequired(classification);

    // Step 5: Determine validation agents
    const validationAgents = this.getValidationAgents(classification);

    // Step 6: Estimate completion time
    const estimatedCompletionTime = this.estimateCompletionTime(
      classification,
      agentExecutionOrder.length,
    );

    // Step 7: Generate notes
    const notes = this.generateOrchestrationNotes(
      classification,
      agentExecutionOrder,
      crossValidationRequired,
    );

    const totalMs = Date.now() - startTime;

    logger.info('Orchestration plan created', {
      context: {
        requestId,
        demandId,
        step: 'plan_complete',
        category: classification.category,
        agentCount: agentExecutionOrder.length,
        agents: agentExecutionOrder.join(','),
        crossValidation: crossValidationRequired,
        estimatedMinutes: estimatedCompletionTime,
        durationMs: totalMs,
        steps: {
          fetch_ms: fetchMs,
          classify_ms: classifyMs,
          order_ms: orderMs,
        },
      },
    });

    return {
      demandId,
      classification,
      agentExecutionOrder,
      crossValidationRequired,
      validationAgents,
      estimatedCompletionTime,
      notes,
      graph,
    };
  }

  /**
   * Constrói o grafo explícito da squad quando `squadGraphEnabled` está ligada.
   * Retorna `undefined` quando a flag está off (caminho idêntico ao legado) ou
   * quando, por qualquer motivo, a linearização não reproduzir `agentExecutionOrder`
   * — nesse caso loga warning e segue sem grafo, preservando o comportamento.
   */
  private buildSquadGraphIfEnabled(
    classification: DemandClassification,
    agentExecutionOrder: string[],
    demandId: number,
    operationId: string,
  ): SquadGraph | undefined {
    let enabled = false;
    try {
      enabled = this.deps.featureFlags.getFlags().squadGraphEnabled === true;
    } catch (error) {
      squadGraphFlagDegradedTotal
        .labels({ flag_name: 'squadGraphEnabled', component: 'agent-orchestrator' })
        .inc();
      logger.error('Squad graph flag read failed — fail-closed', {
        context: {
          operationId,
          component: 'agent-orchestrator',
          flag_name: 'squadGraphEnabled',
          fallback_action: 'fail_closed',
          demandId,
        },
        error,
      });
      enabled = false;
    }
    if (!enabled) return undefined;

    try {
      const graph = buildSquadGraph(classification, agentExecutionOrder);
      const linearized = linearizeSquadGraph(graph, agentExecutionOrder);
      const preservesOrder =
        linearized.length === agentExecutionOrder.length &&
        linearized.every((id, i) => id === agentExecutionOrder[i]);

      if (!preservesOrder) {
        logger.warn('Squad graph divergiu da ordem linear — anexação ignorada (fallback)', {
          context: {
            demandId,
            linearOrder: agentExecutionOrder.join(','),
            graphOrder: linearized.join(','),
          },
        });
        return undefined;
      }

      // B2: instrumenta composição do grafo (tamanho da squad + deliberação).
      const agentNodeCount = graph.nodes.filter((n) => n.kind === 'agent').length;
      const hasDeliberation = graph.nodes.some((n) => n.kind === 'deliberation');
      squadGraphSize.observe(agentNodeCount);
      squadGraphBuilt.labels(String(hasDeliberation)).inc();

      logger.info('Squad graph construído (equivalente à ordem linear)', {
        context: { demandId, nodes: graph.nodes.length, edges: graph.edges.length },
      });
      return graph;
    } catch (error) {
      squadGraphBuildFailureTotal.labels(String(demandId)).inc();
      logger.error('Falha ao construir squad graph — seguindo sem grafo', {
        error: error instanceof Error ? error : undefined,
        context: { demandId, operationId: generateRequestId() },
      });
      return undefined;
    }
  }

  /**
   * Determines the execution order of agents
   * @param classification - Demand classification
   * @returns Array of agent names in execution order
   */
  private determineAgentExecutionOrder(classification: DemandClassification): string[] {
    let agents = [...classification.recommendedAgents];

    // Enforcement Operacional de Nível (T3)
    const level = classification.progressiveRefinement?.recommendedLevel || 3;

    if (level === 1) {
      // Nível 1 (Rápido): PO/PM, preservando especialistas exigidos pelo tipo/domínio.
      const allowedLevel1: string[] = [AgentRole.product_owner, AgentRole.product_manager];
      agents = agents.filter((a) => allowedLevel1.includes(a));
      for (const specialist of [
        AgentRole.security_specialist,
        AgentRole.architect,
        AgentRole.financial_analyst,
      ]) {
        if (classification.recommendedAgents.includes(specialist)) agents.push(specialist);
      }
      if (!agents.includes(AgentRole.product_owner)) agents.unshift(AgentRole.product_owner);
    } else if (level === 2) {
      // Nível 2 (Funcional): Squad parcial (sem analista de dados, as vezes sem UX se não precisar)
      const allowedLevel2: string[] = [
        AgentRole.product_owner,
        AgentRole.scrum_master,
        AgentRole.qa,
        AgentRole.product_manager,
        AgentRole.tech_lead,
        AgentRole.security_specialist,
        AgentRole.architect,
        AgentRole.financial_analyst,
      ];
      agents = agents.filter((a) => allowedLevel2.includes(a));
    }
    // Nível 3 (Completo) mantém todos os recomendados

    // Always start with product_owner if it's in the list
    if (agents.includes(AgentRole.product_owner)) {
      agents.sort((a, b) =>
        a === AgentRole.product_owner ? -1 : b === AgentRole.product_owner ? 1 : 0,
      );
    }

    // For technical demands, tech_lead should come before qa
    if (classification.category === 'technical') {
      const techLeadIndex = agents.indexOf(AgentRole.tech_lead);
      const qaIndex = agents.indexOf(AgentRole.qa);

      if (techLeadIndex > qaIndex && techLeadIndex !== -1 && qaIndex !== -1) {
        agents[techLeadIndex] = AgentRole.qa;
        agents[qaIndex] = AgentRole.tech_lead;
      }
    }

    // For business demands, product_manager should come first
    if (classification.category === 'business' && agents.includes(AgentRole.product_manager)) {
      agents.sort((a, b) =>
        a === AgentRole.product_manager ? -1 : b === AgentRole.product_manager ? 1 : 0,
      );
    }

    // For high complexity, scrum_master should be near the end
    if (classification.criteria.complexity > 70 && agents.includes(AgentRole.scrum_master)) {
      const scrumMasterIndex = agents.indexOf(AgentRole.scrum_master);
      if (scrumMasterIndex !== -1 && scrumMasterIndex < agents.length - 1) {
        agents.splice(scrumMasterIndex, 1);
        agents.push(AgentRole.scrum_master);
      }
    }

    return agents;
  }

  /**
   * Determines if cross-validation is required
   * @param classification - Demand classification
   * @returns True if cross-validation is required
   */
  private isCrossValidationRequired(classification: DemandClassification): boolean {
    // Cross-validation is required for:
    // 1. High ambiguity
    // 2. High interpretation risk
    // 3. High complexity
    // 4. Critical priority demands

    const hasHighAmbiguity = classification.criteria.ambiguity > 60;
    const hasHighInterpretationRisk = classification.criteria.interpretationRisk > 60;
    const hasHighComplexity = classification.criteria.complexity > 70;
    const isCriticalPriority = classification.criteria.urgency > 80;

    // Enforcement Operacional (T3): Nível 1 NUNCA faz cross-validation para economizar custo
    const level = classification.progressiveRefinement?.recommendedLevel || 3;
    if (level === 1) return false;

    return hasHighAmbiguity || hasHighInterpretationRisk || hasHighComplexity || isCriticalPriority;
  }

  /**
   * Gets validation agents for cross-validation
   * @param classification - Demand classification
   * @returns Array of validation agent names
   */
  private getValidationAgents(classification: DemandClassification): string[] {
    const validationAgents: string[] = [];

    // For technical demands, include qa and tech_lead
    if (classification.category === 'technical') {
      if (!validationAgents.includes(AgentRole.qa)) validationAgents.push(AgentRole.qa);
      if (!validationAgents.includes(AgentRole.tech_lead))
        validationAgents.push(AgentRole.tech_lead);
    }

    // For business demands, include product_manager
    if (classification.category === 'business') {
      if (!validationAgents.includes(AgentRole.product_manager))
        validationAgents.push(AgentRole.product_manager);
    }

    // For high ambiguity, include product_owner
    if (
      classification.criteria.ambiguity > 60 &&
      !validationAgents.includes(AgentRole.product_owner)
    ) {
      validationAgents.push(AgentRole.product_owner);
    }

    // For high complexity, include scrum_master
    if (
      classification.criteria.complexity > 70 &&
      !validationAgents.includes(AgentRole.scrum_master)
    ) {
      validationAgents.push(AgentRole.scrum_master);
    }

    // Always include at least one validator
    if (validationAgents.length === 0) {
      validationAgents.push(AgentRole.qa);
    }

    return validationAgents;
  }

  /**
   * Estimates completion time
   * @param classification - Demand classification
   * @param agentCount - Number of agents in the execution order
   * @returns Estimated completion time in minutes
   */
  private estimateCompletionTime(classification: DemandClassification, agentCount: number): number {
    let baseTime = agentCount * 30; // 30 minutes per agent

    // Adjust based on complexity
    if (classification.criteria.complexity > 80) {
      baseTime *= 1.5;
    } else if (classification.criteria.complexity > 60) {
      baseTime *= 1.2;
    }

    // Adjust based on depth required
    if (classification.criteria.depthRequired > 80) {
      baseTime *= 1.3;
    }

    // Adjust based on ambiguity (more ambiguity = more time for clarification)
    if (classification.criteria.ambiguity > 70) {
      baseTime *= 1.4;
    }

    // Add time for cross-validation if required
    if (this.isCrossValidationRequired(classification)) {
      baseTime += 60; // Additional hour for validation
    }

    return Math.round(baseTime);
  }

  /**
   * Generates orchestration notes
   * @param classification - Demand classification
   * @param agentExecutionOrder - Agent execution order
   * @param crossValidationRequired - Whether cross-validation is required
   * @returns Orchestration notes
   */
  private generateOrchestrationNotes(
    classification: DemandClassification,
    agentExecutionOrder: string[],
    crossValidationRequired: boolean,
  ): string {
    const notes: string[] = [];

    notes.push(`Orchestration plan created for ${classification.category} demand`);
    notes.push(`Execution order: ${agentExecutionOrder.join(' → ')}`);
    notes.push(
      `Estimated completion time: ${this.estimateCompletionTime(classification, agentExecutionOrder.length)} minutes`,
    );

    if (crossValidationRequired) {
      notes.push(`✅ Cross-validation required for this demand`);
      notes.push(`Validation agents: ${this.getValidationAgents(classification).join(', ')}`);
    } else {
      notes.push(`❌ Cross-validation not required`);
    }

    if (classification.criteria.ambiguity > 60) {
      notes.push(`🔍 High ambiguity detected - clarification may be needed during execution`);
    }

    if (classification.criteria.complexity > 70) {
      notes.push(`🛠️ High complexity - consider breaking into smaller tasks`);
    }

    return notes.join('\n');
  }

  /**
   * Executes the orchestration plan
   * @param plan - The orchestration plan
   * @param onProgress - Callback for progress updates
   * @returns Array of agent execution results
   */
  async executeOrchestrationPlan(
    plan: OrchestrationPlan,
    onProgress: (progress: number, message: string) => void,
    checkStop?: () => boolean,
    onAgentComplete?: (agentName: string, result: AgentExecutionResult) => void,
    runId?: string,
  ): Promise<AgentExecutionResult[]> {
    const requestId = generateRequestId();
    const executionStart = Date.now();
    const results: AgentExecutionResult[] = [];
    const totalAgents = plan.agentExecutionOrder.length;
    const agentDurations: Record<string, number> = {};

    // Emit ORCHESTRATION_STARTED event
    this.deps.eventBus.publish('ORCHESTRATION_STARTED', {
      timestamp: new Date().toISOString(),
      pipelineId: requestId,
      runId,
      demandId: plan.demandId,
      status: 'started',
      metadata: {
        totalAgents,
      },
    });

    logger.info('Orchestration execution started', {
      context: {
        requestId,
        demandId: plan.demandId,
        step: 'execution_start',
        event: 'ORCHESTRATION_STARTED',
        totalAgents,
        agents: plan.agentExecutionOrder.join(','),
        crossValidation: plan.crossValidationRequired,
      },
    });

    try {
      // Execute agents in order
      for (let i = 0; i < totalAgents; i++) {
        const agentName = plan.agentExecutionOrder[i];
        const progress = Math.round(((i + 1) / totalAgents) * 100);
        const agentStart = Date.now();

        if (checkStop && checkStop()) {
          logger.warn('Orchestration stopped by user', {
            context: {
              requestId,
              demandId: plan.demandId,
              step: 'execution_stopped',
              agentIndex: i,
            },
          });
          onProgress(progress, 'Execução interrompida pelo usuário.');
          await this.deps.demandRepository.updateStatus(plan.demandId, 'stopped');
          throw new Error('Execution stopped by user');
        }

        onProgress(progress, `Executing agent: ${agentName} (${i + 1}/${totalAgents})`);

        // Emit AGENT_STARTED for the persistent audit trail.
        this.deps.eventBus.publish('AGENT_STARTED', {
          timestamp: new Date().toISOString(),
          pipelineId: requestId,
          runId,
          demandId: plan.demandId,
          agentName,
          turnIndex: i,
          status: 'started',
        });

        try {
          // Execute the agent
          const executionResult = await this.executeAgent(plan.demandId, agentName);
          const agentMs = Date.now() - agentStart;
          agentDurations[agentName] = agentMs;

          if (checkStop && checkStop()) {
            logger.warn('Orchestration stopped by user after agent execution', {
              context: {
                requestId,
                demandId: plan.demandId,
                step: 'execution_stopped_after_agent',
                agentName,
                agentIndex: i,
              },
            });
            onProgress(progress, 'Execucao interrompida pelo usuario.');
            await this.deps.demandRepository.updateStatus(plan.demandId, 'stopped');
            throw new Error('Execution stopped by user');
          }
          // B2: latência por nó-agente da squad.
          squadAgentNodeDuration.labels(agentName).observe(agentMs / 1000);

          logger.info('Agent executed', {
            context: {
              requestId,
              demandId: plan.demandId,
              step: 'agent_complete',
              agentName,
              agentIndex: i + 1,
              totalAgents,
              success: executionResult.success,
              durationMs: agentMs,
            },
          });

          results.push(executionResult);

          // Emit AGENT_COMPLETED for the persistent audit trail.
          this.deps.eventBus.publish('AGENT_COMPLETED', {
            timestamp: new Date().toISOString(),
            pipelineId: requestId,
            runId,
            demandId: plan.demandId,
            agentName,
            turnIndex: i,
            status: 'completed',
            durationMs: agentMs,
          });

          if (onAgentComplete) {
            try {
              onAgentComplete(agentName, executionResult);
            } catch (err) {
              logger.error('Error in onAgentComplete callback', {
                error: err instanceof Error ? err : undefined,
                context: { demandId: plan.demandId, agentName },
              });
            }
          }

          // Update demand status
          await this.deps.demandRepository.update(plan.demandId, {
            status: 'processing',
            progress: progress,
            currentAgent: agentName,
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'Execution stopped by user') {
            throw error;
          }

          const agentMs = Date.now() - agentStart;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          logger.error('Agent execution failed', {
            context: {
              requestId,
              demandId: plan.demandId,
              step: 'agent_error',
              agentName,
              agentIndex: i + 1,
              error: errorMessage,
              durationMs: agentMs,
            },
          });

          results.push({
            agentName,
            success: false,
            message: `Agent execution failed: ${errorMessage}`,
            timestamp: new Date().toISOString(),
          });

          // Emit AGENT_FAILED for the persistent audit trail.
          this.deps.eventBus.publish('AGENT_FAILED', {
            timestamp: new Date().toISOString(),
            pipelineId: requestId,
            runId,
            demandId: plan.demandId,
            agentName,
            turnIndex: i,
            status: 'failed',
            durationMs: agentMs,
            error: errorMessage,
          });

          // Update demand status to error
          await this.deps.demandRepository.markAsError(
            plan.demandId,
            `Agent ${agentName} failed: ${errorMessage}`,
          );

          throw new Error(`Agent ${agentName} execution failed: ${errorMessage}`);
        }
      }

      // Perform cross-validation if required
      if (plan.crossValidationRequired) {
        onProgress(90, 'Performing cross-validation');

        const validationResult = this.performCrossValidation(plan, results);

        if (!validationResult.validationPassed) {
          await this.deps.demandRepository.update(plan.demandId, {
            status: 'validation_failed',
            validationNotes: validationResult.validationNotes.join('\n'),
          });

          throw new Error(
            'Cross-validation failed: ' + validationResult.validationNotes.join(', '),
          );
        }

        results.push({
          agentName: 'cross_validation',
          success: true,
          message: 'Cross-validation completed successfully',
          data: validationResult as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        });
      }

      // Update demand status to completed
      await this.deps.demandRepository.update(plan.demandId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date(),
      });

      const totalMs = Date.now() - executionStart;
      const successCount = results.filter((r) => r.success).length;

      // Emit ORCHESTRATION_COMPLETED event
      this.deps.eventBus.publish('ORCHESTRATION_COMPLETED', {
        timestamp: new Date().toISOString(),
        pipelineId: requestId,
        runId,
        demandId: plan.demandId,
        status: 'completed',
        durationMs: totalMs,
        metadata: {
          totalAgents,
          successCount,
          failedCount: results.length - successCount,
          agentDurations,
        },
      });

      logger.info('Orchestration execution completed', {
        context: {
          requestId,
          demandId: plan.demandId,
          step: 'execution_complete',
          event: 'ORCHESTRATION_COMPLETED',
          totalAgents,
          successCount,
          failedCount: results.length - successCount,
          crossValidation: plan.crossValidationRequired,
          durationMs: totalMs,
          agentDurations,
        },
      });

      onProgress(100, 'Orchestration completed successfully');

      return results;
    } catch (error) {
      const durationMs = Date.now() - executionStart;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Emit ORCHESTRATION_FAILED event
      this.deps.eventBus.publish('ORCHESTRATION_FAILED', {
        timestamp: new Date().toISOString(),
        pipelineId: requestId,
        runId,
        demandId: plan.demandId,
        status: 'failed',
        durationMs,
        error: errorMessage,
        metadata: {
          totalAgents,
        },
      });

      logger.error('Orchestration execution failed', {
        context: {
          requestId,
          demandId: plan.demandId,
          step: 'execution_failed',
          event: 'ORCHESTRATION_FAILED',
          error: errorMessage,
          durationMs,
          totalAgents,
        },
      });

      // Re-throw the error to propagate it
      throw error;
    }
  }

  /**
   * A-1: categoriza erros de agente para log estruturado.
   */
  private categorizeAgentError(error: unknown): string {
    if (error instanceof Error) {
      if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        return 'timeout';
      }
      if (error.message.includes('schema') || error.message.includes('validation')) {
        return 'schema_validation';
      }
      if (error.message.includes('rate') || error.message.includes('429')) {
        return 'rate_limit';
      }
      return 'runtime';
    }
    return 'unknown';
  }

  /**
   * A-1: aplica backoff exponencial simples entre tentativas de agente.
   */
  private async agentRetryDelay(attempt: number): Promise<number> {
    const delay = Math.min(100 * 2 ** attempt, 1000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  }

  /**
   * A-1: wrapper withRetry no ponto de chamada do agente.
   * Limita a MAX_RETRIES, aplica backoff e persiste falha estruturada.
   */
  private async executeAgentWithRetry(
    demandId: number,
    agentName: string,
    executionId: string,
  ): Promise<AgentExecutionResult> {
    const maxRetries = env.orchestratorAgentMaxRetries;
    let lastError: unknown;
    let lastDelay = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeAgentCore(demandId, agentName);
      } catch (error) {
        lastError = error;
        const category = this.categorizeAgentError(error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (attempt < maxRetries) {
          lastDelay = await this.agentRetryDelay(attempt);
          logger.warn('A-1: agent execution failed, retrying', {
            error: error instanceof Error ? error : undefined,
            context: {
              agent_id: agentName,
              task_id: String(demandId),
              execution_id: executionId,
              attempt,
              max_retries: maxRetries,
              delay_applied: lastDelay,
              error_category: category,
              timestamp: new Date().toISOString(),
            },
          });
        } else {
          const stackShort =
            error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 3).join('\n') : '';
          await agentFailureLogger.log({
            agentId: agentName,
            taskId: String(demandId),
            executionId,
            errorCategory: category,
            errorMessage,
            stackShort,
            delayApplied: lastDelay,
            attempt,
          });
        }
      }
    }

    const finalMessage =
      lastError instanceof Error ? lastError.message : 'Unknown error after retries';
    return {
      agentName,
      success: false,
      message: `Agent ${agentName} execution failed after ${maxRetries + 1} attempts: ${finalMessage}`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * A-1: executa o agente com retry e log estruturado.
   */
  async executeAgent(demandId: number, agentName: string): Promise<AgentExecutionResult> {
    const executionId = generateRequestId();
    return this.executeAgentWithRetry(demandId, agentName, executionId);
  }

  /**
   * Core de execução de um agente (antes A-1 era executeAgent).
   * @param demandId - Demand ID
   * @param agentName - Agent name
   * @returns Agent execution result
   */
  private async executeAgentCore(
    demandId: number,
    agentName: string,
  ): Promise<AgentExecutionResult> {
    const demand = await this.deps.demandRepository.findById(demandId);

    // Use the agent interaction service to execute the agent, then enforce
    // the same Context Handshake used by the legacy orchestration path.
    const result = await this.deps.agentInteractionService.executeAgent(agentName, demand);
    const validation = await this.deps.contextBuilder.validateAgentResponse(result, demand);
    const cleanMessage = validation.cleanMessage || result;
    this.deps.contextBuilder.recordVerifiedEvidence(demandId, validation.evidence);

    return {
      agentName,
      success: true,
      message: cleanMessage,
      data: {
        rawMessage: result,
        validation: {
          isValid: validation.isValid,
          score: validation.score,
          issues: validation.issues,
        },
      },
      evidence: validation.evidence,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Performs cross-validation
   * @param plan - Orchestration plan
   * @returns Cross-validation result
   */
  private performCrossValidation(
    plan: OrchestrationPlan,
    results: AgentExecutionResult[],
  ): CrossValidationResult {
    // Every output already passed contextBuilder.validateResponse in executeAgent().
    // Reuse that deterministic evidence instead of paying for a generic LLM validation.
    const validations = results.flatMap((result) => {
      const validation = result.data?.validation as
        { isValid?: boolean; score?: number; issues?: unknown[] } | undefined;
      return validation ? [{ agentName: result.agentName, ...validation }] : [];
    });

    return aggregateDeterministicAgentValidations(plan.validationAgents, validations);
  }

  /**
   * Updates demand with orchestration information
   * @param demandId - Demand ID
   * @param plan - Orchestration plan
   */
  async updateDemandWithOrchestration(demandId: number, plan: OrchestrationPlan): Promise<void> {
    await this.deps.demandRepository.update(demandId, {
      orchestration: {
        plan: {
          agentExecutionOrder: plan.agentExecutionOrder,
          crossValidationRequired: plan.crossValidationRequired,
          validationAgents: plan.validationAgents,
          estimatedCompletionTime: plan.estimatedCompletionTime,
          notes: plan.notes,
        },
        classification: plan.classification,
        orchestratedAt: new Date().toISOString(),
      },
    });
  }
}

// Create a singleton instance
export const agentOrchestrator = new AgentOrchestrator();
