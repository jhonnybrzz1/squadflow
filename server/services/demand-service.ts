import { demands } from '@shared/schema';
import type { Demand, InsertFile, DemandType, DemandPriority, DemandDomain } from '@shared/schema';
import {
  demandRepository,
  type DemandRepository as DemandRepositoryType,
} from '../repositories/demand-repository';
import type { RefinementType } from '@shared/schema';
import { getDemandTypeConfig } from '@shared/demand-types';
import type { DemandStatus } from '@shared/demand-status';
import { DEFAULT_ROUNDTABLE_AGENTS } from '../orchestration-contracts';
import { MIN_ROUNDTABLE_AGENTS } from '@shared/agent-roles';
import { featureFlags } from './feature-flags';
import { selectAgentsForDemand } from './dynamic-agent-triage';
import { resolveRefinementInput } from './refinement-input';
import { repoService } from './repo-service';
import {
  buildRepoFullName,
  parseAdditionalRepos,
  formatAdditionalReposBlock,
} from '../utils/repo-context';
import { resolveDemandStartContract, type CreateDemandPayload } from './demand-start-contract';
import { fetchSkillRawContent, wrapSkillContentAsUntrusted } from './skill-raw-fetch';
import { demandGenerationJobsService } from './demand-generation-jobs';
import { enqueueDemandGenerationJob } from '../workers/demand-generation-worker';
import { aiSquadService } from './ai-squad';
import { logger } from '../utils/logger';
import { insertFileSchema } from '@shared/schema';
import { ValidationError } from '../middleware/error-handler';
import { storage } from '../storage';
import { demandCreatedTotal, demandTerminalStateTotal } from '../metrics';

/** Estados que encerram o ciclo de vida de uma demanda. */
const TERMINAL_STATUSES = new Set(['completed', 'error', 'stopped']);

/**
 * Demanda 10321 — contabiliza desfechos para dar baseline ao throughput.
 *
 * Telemetria nunca pode derrubar a transição de estado: qualquer falha aqui é
 * engolida com log, seguindo o padrão da spec 10122 para degradação silenciosa.
 */
function recordDemandTerminalState(status: string, demand: { type?: string | null }): void {
  if (!TERMINAL_STATUSES.has(status)) return;
  try {
    demandTerminalStateTotal.inc({ status, demand_type: demand?.type ?? 'unknown' });
  } catch (error) {
    logger.warn('[metrics] falha ao contabilizar estado terminal da demanda', {
      error: error instanceof Error ? error : undefined,
      context: { status },
    });
  }
}

/** Contabiliza a criação. Mesma regra: não pode quebrar o fluxo. */
function recordDemandCreated(demand: {
  type?: string | null;
  refinementType?: string | null;
}): void {
  try {
    demandCreatedTotal.inc({
      demand_type: demand?.type ?? 'unknown',
      refinement_type: demand?.refinementType ?? 'unknown',
    });
  } catch (error) {
    logger.warn('[metrics] falha ao contabilizar criação de demanda', {
      error: error instanceof Error ? error : undefined,
    });
  }
}

export interface CreateDemandInput {
  title: string;
  description: string;
  originalDescription: string;
  type: DemandType;
  priority: DemandPriority;
  domain?: DemandDomain;
  refinementType?: RefinementType | null;
  repoFullName?: string | null;
  skillRawUrl?: string | null;
  origin?: string | null;
  originMetadata?: Record<string, unknown> | null;
  files?: InsertFile[];
  roundtableConfig?: Record<string, unknown>;
  // Spec 10015 (FR-001): flag go-live opt-in por demanda.
  goLiveMode?: boolean | null;
}

export interface DemandGenerationConfig {
  agentIds: string[];
  maxRounds: number;
  refinementLevel: 1 | 2 | 3;
}

export interface EnrichedCreateInput {
  createInput: CreateDemandInput;
  roundtableConfig: Record<string, unknown>;
  generationConfig: DemandGenerationConfig;
  refinementMetadata: {
    refinementInputSource: string;
    documentTextLength: number;
    ideaTextLength: number;
  };
}

export interface EnrichDemandInput {
  title: string;
  description: string;
  type: DemandType;
  priority: DemandPriority;
  domain?: DemandDomain;
  refinementType?: RefinementType | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
  additionalRepos?: unknown;
  skillRawUrl?: string | null;
  origin?: string | null;
  originMetadata?: Record<string, unknown> | null;
  roundtableAgentIds?: string[] | null;
  maxRounds?: number | null;
  refinementLevel?: number | null;
  demandStartContractPayload?: unknown;
  demandStartContract?: unknown;
  files?: Express.Multer.File[];
  // Spec 10015 (FR-001): flag go-live opt-in por demanda.
  goLiveMode?: boolean | null;
}

export class DemandService {
  /**
   * Cria uma demanda de forma atômica, encapsulando o insert principal,
   * a persistência dos arquivos e a gravação da config da roundtable
   * dentro da transação do repository.
   *
   * O service não conhece Express: recebe um input puro e retorna a demanda.
   */
  static async create(
    input: CreateDemandInput,
    repository: DemandRepositoryType = demandRepository,
  ): Promise<Demand> {
    const insertData: typeof demands.$inferInsert = {
      title: input.title,
      description: input.description,
      originalDescription: input.originalDescription,
      type: input.type,
      priority: input.priority,
      domain: input.domain ?? 'padrao',
      refinementType: input.refinementType ?? null,
      repoFullName: input.repoFullName ?? null,
      skillRawUrl: input.skillRawUrl ?? null,
      origin: input.origin ?? null,
      originMetadata: input.originMetadata ?? {},
      // Spec 10015 (FR-001): persiste goLiveMode. Default false (schema).
      goLiveMode: input.goLiveMode === true,
    };

    const created = await repository.create(insertData, {
      files: input.files,
      roundtableConfig: input.roundtableConfig,
    });
    recordDemandCreated(created);
    return created;
  }

  /**
   * Spec 10179: enriquece a descrição da demanda (repo context, start contract,
   * skill externa, dynamic triage) e monta os inputs puros para criação.
   * Não depende de req/res Express.
   */
  static async enrich(input: EnrichDemandInput): Promise<EnrichedCreateInput> {
    const {
      title,
      description,
      type,
      priority,
      domain,
      refinementType,
      githubRepoOwner,
      githubRepoName,
      additionalRepos: additionalReposRaw,
      skillRawUrl,
      origin,
      originMetadata,
      roundtableAgentIds: roundtableAgentIdsRaw,
      maxRounds: maxRoundsRaw,
      refinementLevel: refinementLevelRaw,
      demandStartContractPayload,
      demandStartContract,
      files,
    } = input;

    const additionalRepos = parseAdditionalRepos(additionalReposRaw);
    let resolvedRepoFullName: string | null = buildRepoFullName(githubRepoOwner, githubRepoName);

    const refinementInput = await resolveRefinementInput(description, files ?? []);
    let updatedDescription = refinementInput.ideaText;

    if (githubRepoOwner && githubRepoName) {
      try {
        const repoInfo = await repoService.getOrCreateRepo(githubRepoOwner, githubRepoName);
        if (repoInfo && repoInfo.description) {
          updatedDescription = `${refinementInput.ideaText}\n\n---\n**Contexto do Repositório GitHub:**\nRepositório: ${repoInfo.fullName}\nDescrição: ${repoInfo.description}\nLinguagem Principal: ${repoInfo.language || 'N/A'}\n${formatAdditionalReposBlock(additionalRepos)}`;
          resolvedRepoFullName = repoInfo.fullName ?? resolvedRepoFullName;
        } else {
          updatedDescription = `${refinementInput.ideaText}\n\n---\n**Contexto do Repositório GitHub:**\nRepositório: ${githubRepoOwner}/${githubRepoName}\n${formatAdditionalReposBlock(additionalRepos)}`;
        }
      } catch (repoError) {
        logger.warn(
          `Não foi possível buscar informações do repositório ${githubRepoOwner}/${githubRepoName}`,
          { error: repoError instanceof Error ? repoError : undefined },
        );
        updatedDescription = `${refinementInput.ideaText}\n\n---\n**Contexto do Repositório GitHub:**\nRepositório: ${githubRepoOwner}/${githubRepoName}\n${formatAdditionalReposBlock(additionalRepos)}`;
      }
    }

    const demandStartContractResult = resolveDemandStartContract(
      { demandStartContractPayload, demandStartContract } as CreateDemandPayload,
      { title, description, type },
    );

    if (demandStartContractResult?.markdown) {
      updatedDescription = `${updatedDescription}\n\n${demandStartContractResult.markdown}`;
    }

    if (skillRawUrl) {
      const skillResult = await fetchSkillRawContent(skillRawUrl);
      if (skillResult.content) {
        if (skillResult.injectionWarning) {
          logger.warn(`skill externa: injection warning: ${skillResult.injectionWarning}`, {
            context: { url: skillRawUrl },
          });
        }
        updatedDescription = `${updatedDescription}${wrapSkillContentAsUntrusted(skillResult.content)}`;
      } else {
        logger.warn(
          `Não foi possível buscar a skill externa: ${skillRawUrl} (reason: ${skillResult.rejectedReason ?? 'unknown'})`,
        );
      }
    }

    let roundtableAgentIds: string[] = roundtableAgentIdsRaw
      ? roundtableAgentIdsRaw
      : [...DEFAULT_ROUNDTABLE_AGENTS];
    let triageReasoning: string | undefined;
    if (!roundtableAgentIdsRaw && featureFlags.getFlags().enableDynamicAgentTriage) {
      const triage = await selectAgentsForDemand({
        title,
        description: updatedDescription,
        type,
      });
      if (!triage.fallback && triage.selectedAgents.length > 0) {
        roundtableAgentIds = triage.selectedAgents;
        triageReasoning = triage.reasoning;
      }
    }

    // Spec 10081: validação de quórum mínimo para mesa redonda. A triagem
    // dinâmica já garante o quórum (ver topUpToQuorum em dynamic-agent-triage),
    // então daqui pra frente isto vale sobretudo para lista explícita do cliente.
    if (roundtableAgentIds.length < MIN_ROUNDTABLE_AGENTS) {
      logger.warn('demand-service: quórum mínimo de agentes não atingido', {
        context: {
          reason: 'quorum_minimum_not_met',
          provided: roundtableAgentIds.length,
          minimum: MIN_ROUNDTABLE_AGENTS,
          demandId: undefined,
        },
      });
      throw new ValidationError(
        `Mesa redonda requer pelo menos ${MIN_ROUNDTABLE_AGENTS} agentes selecionados.`,
        [
          {
            path: 'roundtableAgentIds',
            message: `Selecione pelo menos ${MIN_ROUNDTABLE_AGENTS} agentes.`,
          },
        ],
      );
    }

    const demandTypeConfig = getDemandTypeConfig(type);
    const defaultMaxRounds = demandTypeConfig.constraints.maxRounds;
    const maxRounds = maxRoundsRaw ?? defaultMaxRounds;
    const defaultRefinementLevel = demandTypeConfig.constraints.defaultRefinementLevel;
    const refinementLevel: 1 | 2 | 3 =
      refinementLevelRaw === 1 || refinementLevelRaw === 2 || refinementLevelRaw === 3
        ? refinementLevelRaw
        : defaultRefinementLevel;

    const roundtableConfig = {
      agentIds: roundtableAgentIds,
      maxRounds,
      ...(triageReasoning ? { triageReasoning } : {}),
    };

    const fileData = (files ?? []).map((file) =>
      insertFileSchema.parse({
        demandId: null,
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: file.path,
      }),
    );

    const createInput: CreateDemandInput = {
      title,
      description: updatedDescription,
      originalDescription: description,
      type,
      priority,
      domain,
      refinementType: refinementType || null,
      repoFullName: resolvedRepoFullName ?? undefined,
      skillRawUrl: skillRawUrl ?? undefined,
      origin: origin ?? undefined,
      originMetadata: originMetadata ?? undefined,
      files: fileData,
      roundtableConfig,
      // Spec 10015 (FR-015): go-live só é persistido se a feature flag estiver
      // ligada; caso contrário, forçado a false (fail-safe — rollout gradual).
      goLiveMode: featureFlags.getFlags().goLiveEnabled && input.goLiveMode === true,
    };

    const generationConfig: DemandGenerationConfig = {
      agentIds: roundtableAgentIds,
      maxRounds,
      refinementLevel,
    };

    return {
      createInput,
      roundtableConfig,
      generationConfig,
      refinementMetadata: {
        refinementInputSource: refinementInput.refinementInputSource,
        documentTextLength: refinementInput.documentTextLength,
        ideaTextLength: updatedDescription.length,
      },
    };
  }

  /**
   * Spec 10179: despacha uma demanda recém-criada, persistindo o job de
   * geração e enfileirando-o para processamento em background.
   */
  static async dispatch(
    demandId: number,
    generationConfig: DemandGenerationConfig,
  ): Promise<{ generationJobId: string }> {
    aiSquadService.resetFailureCooldown?.(demandId);
    const generationJobId = await demandGenerationJobsService.enqueue(demandId, generationConfig);
    enqueueDemandGenerationJob({
      id: generationJobId,
      demandId,
      config: generationConfig,
      status: 'pending',
      attempts: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { generationJobId };
  }

  // --- Batch 1/2 (10211): métodos de persistência encapsulados ---

  static async findById(id: number): Promise<Demand> {
    return demandRepository.findById(id);
  }

  static async findByIdOrNull(id: number): Promise<Demand | undefined> {
    return demandRepository.findByIdOrNull(id);
  }

  static async findAll(): Promise<Demand[]> {
    return demandRepository.findAll();
  }

  static async update(
    id: number,
    updates: Parameters<typeof demandRepository.update>[1],
  ): Promise<Demand> {
    return demandRepository.update(id, updates);
  }

  static async deleteById(id: number): Promise<boolean> {
    return demandRepository.deleteById(id);
  }

  static async clearHistory(): Promise<{ deleted: number }> {
    return demandRepository.clearHistory();
  }

  static async addLearningLog(
    id: number,
    entry: string | Record<string, unknown>,
  ): Promise<Demand> {
    const demand = await demandRepository.findByIdOrNull(id);
    if (!demand) throw new Error(`Demand ${id} not found`);
    const current = Array.isArray(demand.learningLog) ? (demand.learningLog as unknown[]) : [];
    const updated = [...current, entry];
    return demandRepository.update(id, { learningLog: updated as unknown });
  }

  static async getLearningLog(id: number): Promise<unknown[]> {
    const demand = await demandRepository.findByIdOrNull(id);
    if (!demand) throw new Error(`Demand ${id} not found`);
    return Array.isArray(demand.learningLog) ? (demand.learningLog as unknown[]) : [];
  }

  static async updateStatus(
    id: number,
    status: DemandStatus,
    options?: { learningLog?: unknown[]; qaEvidence?: unknown },
  ): Promise<Demand> {
    const updates: Parameters<typeof demandRepository.update>[1] = { status };
    if (options?.learningLog) {
      updates.learningLog = options.learningLog as unknown as (typeof updates)['learningLog'];
    }
    if (options?.qaEvidence !== undefined) {
      updates.qaEvidence = options.qaEvidence as unknown as (typeof updates)['qaEvidence'];
    }
    const updated = await demandRepository.update(id, updates);
    recordDemandTerminalState(status, updated);
    return updated;
  }

  static async updateProgress(
    id: number,
    message: { progress?: number; status?: string; details?: string },
  ): Promise<boolean> {
    const current = await demandRepository.findByIdOrNull(id);
    if (!current || current.status !== 'processing') {
      return false;
    }
    await demandRepository.update(id, {
      status: 'processing',
      progress: message.progress || current.progress || 0,
      ...(message.details ? { statusDetails: message.details } : {}),
    });
    return true;
  }

  static async updateMaxEffortOverride(
    id: number,
    override: {
      maxEffortOverrideDias: number;
      maxEffortOverrideBy: string;
      maxEffortOverrideJustification: string;
    },
  ): Promise<Demand | undefined> {
    return storage.updateDemand(id, override);
  }
}
