import { projectRoot } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { Demand, EvidenceBlock, RepoContext } from '@shared/schema';
import { repoService } from './repo-service';
import { gitHubService } from './github';
import { logger } from '../utils/logger';
import { featureFlags } from './feature-flags';
import { selectSalientInsights } from './context-engineering';
import { scoreAgentResponseStructure } from './context-response-scoring';
import type { ValidationIssue } from './improvement-execution';
import { createHash } from 'crypto';
import { contextSummarizationTokensSaved } from '../metrics';
import { screenAndFormat } from './retrieval-guardrail';
import { resolveDemandRepoFullName } from '../utils/repo-context';
import { contextCache } from './context-cache';
import {
  resolveDemandTypeRule,
  emitBaselineRequirementSkipped,
  emitHallucinatedPathBlocked,
  emitContractFalsePositiveObservation,
  pathValidationCache,
  emptyPathValidationResult,
  getEvidenceExtensions,
  type PathValidationResult,
} from './evidence-policy';

interface EvidenceValidationOptions {
  demandType?: string;
  repoAvailable?: boolean;
  repoId?: string;
  demandId?: number;
}

function isUnsafeRepoPath(filePath: string): boolean {
  const decoded = (() => {
    try {
      return decodeURIComponent(filePath);
    } catch (_) {
      return filePath;
    }
  })();
  const normalized = decoded.replace(/\\/g, '/');
  return (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(decoded) ||
    normalized.split('/').includes('..') ||
    /[*?[\]]/.test(normalized) ||
    normalized.includes('\0')
  );
}

export function localPathExistsWithinRoot(relativePath: string, root = projectRoot): boolean {
  if (isUnsafeRepoPath(relativePath)) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  const fullPath = path.resolve(root, normalized);
  if (!fullPath.startsWith(root + path.sep) && fullPath !== root) return false;
  if (!fs.existsSync(fullPath)) return false;

  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(fullPath);
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * Schema zod do Evidence Block emitido pelos agentes. Substitui o parsing manual
 * por validação estruturada: estrutura inválida vira issue no contrato unificado,
 * em vez de produzir um EvidenceBlock inconsistente. `repoContext` é opcional
 * (blocos `blocked` podem omiti-lo); a verificação de arquivos a jusante exige-o.
 */
const evidenceBlockSchema = z.object({
  sourceType: z.enum(['direct_read', 'fallback_rag', 'blocked']),
  repoContext: z
    .object({
      owner: z.string(),
      repo: z.string(),
      branch: z.string().optional(),
      commitSha: z.string().optional(),
    })
    .optional(),
  evidenceFiles: z.array(z.string()).default([]),
  evidenceNotes: z.string().optional(),
});

/**
 * Schema zod do "Response Contract" — bloco JSON estruturado que um agente piloto
 * emite além do markdown (Fase 2 / Faixa B). Modela os campos do antigo
 * JSON_RESPONSE_TEMPLATE; falhas viram ValidationIssue 'error' e dirigem o loop de
 * reparo por agente.
 */
const agentResponseContractSchema = z.object({
  analysis: z.string().min(1),
  problem: z.string().min(1),
  impact: z.string().min(1),
  recommendation: z.string().min(1),
  roi: z.string().min(1),
  effort: z.string().min(1),
  priority: z.enum(['Crítico', 'Importante', 'Desejável']),
});

/**
 * Agent insight for context evolution
 */
export interface AgentInsight {
  agentName: string;
  insight: string;
  timestamp: string;
}

/**
 * Registro tipado de uma decisão/recomendação ou divergência da squad (Fase 5 /
 * slices 1-2). Estado compartilhado tipado: decisões e divergências viram cidadãos
 * de primeira classe, preservados na evolução do contexto em vez de truncados.
 */
interface SquadStatement {
  agentName: string;
  text: string;
  timestamp: string;
}

/**
 * Reality constraints from project analysis
 */
interface RealityConstraints {
  maturityLevel: string;
  demandType?: string;
  canonicalDemandType?: string;
  allowedTechnologies: string[];
  forbiddenTechnologies: string[];
  maxEffortDays: number;
  minROI: string;
  outputType?: string;
  typeRequirements?: string[];
  /**
   * Spec P1 (auditoria 2026-07-26): true quando o reality-check falhou e os
   * demais campos são placeholders neutros, não valores reais. Consumidores
   * de texto devem renderizar um marcador explícito em vez de usar os campos.
   */
  unavailable?: boolean;
}

/**
 * Evolving context that grows with agent contributions
 */
interface EvolvingContext {
  baseContext: string;
  repoContext: string;
  repoAvailable: boolean;
  repoId: string | null;
  agentInsights: AgentInsight[];
  decisions: SquadStatement[];
  divergences: SquadStatement[];
  realityConstraints: RealityConstraints | null;
  lastUpdated: string;
  /**
   * File paths that have been verified (against the local repo cache or
   * GitHub API) during the refinement of this demand. Populated by
   * `recordVerifiedEvidence` after each successful agent-level evidence
   * validation. Consumed by `generatePRDWithPM` to constrain the PM/Tech
   * Lead to citing ONLY paths the squad actually examined — preventing
   * the "PM invents a plausible-sounding file" failure mode.
   */
  verifiedEvidenceFiles: Set<string>;
  /**
   * Enriquecimento externo ao par base/repo — RAG de refinamentos anteriores,
   * RAG de conhecimento de domínio, Repo Lock e briefs de discovery (Phase 0).
   * Populado via `setExternalContext`/`appendExternalContext` por quem monta
   * esse enriquecimento (ex.: ContextAssembler) e emitido em `getEvolvedContext`
   * para que TODO agente do caminho cognitivo o receba — sem isso, o RAG e o
   * conhecimento de domínio eram descartados silenciosamente (CRIT-4).
   */
  externalContext: string;
}

/**
 * Context Builder - Creates structured context for agents with anti-overengineering constraints
 * Now supports context evolution where insights from each agent enrich the context for subsequent agents
 */
export class ContextBuilder {
  /**
   * Teto de decisões/divergências tipadas mantidas por demanda. O bloco tipado é
   * re-emitido inteiro a cada turno (getEvolvedContext), então sem teto o custo de
   * token cresce ~O(turnos²) em runs longos. Mantemos as N mais recentes.
   */
  private static readonly MAX_TYPED_STATEMENTS = 12;
  private static readonly MAX_AGENT_INSIGHTS = 20;
  private static readonly RECENT_INSIGHTS_TO_PRESERVE = 5;
  private static readonly DEFAULT_MAX_CONTEXT_CHARS = 48_000;

  private evolvingContexts: Map<number, EvolvingContext> = new Map();
  private cleanupTimers: Map<number, NodeJS.Timeout> = new Map();
  private readonly contextTtlMs = this.parsePositiveInt(
    process.env.EVOLVING_CONTEXT_TTL_MS,
    60 * 60 * 1000,
  );
  private readonly maxContexts = this.parsePositiveInt(
    process.env.EVOLVING_CONTEXT_MAX_ENTRIES,
    100,
  );
  private readonly maxContextChars = this.parsePositiveInt(
    process.env.EVOLVING_CONTEXT_MAX_CHARS,
    ContextBuilder.DEFAULT_MAX_CONTEXT_CHARS,
  );
  private readonly summarizationInFlight = new Set<number>();
  private readonly summaryCache = new Map<string, string>();
  private cacheEnabled = process.env.CONTEXT_CACHE_ENABLED !== 'false';

  // Validation metrics counters
  private invalidFilesBlocked = 0;
  private totalFilesValidated = 0;

  /**
   * M-3: resolve branch e sha para a chave de cache, retornando null quando
   * a cache está desabilitada ou não é possível obter referência estável.
   */
  private async resolveRepoCacheKey(
    demand: Demand,
  ): Promise<{ branch: string; sha: string } | null> {
    if (!this.cacheEnabled) return null;

    const repoFullName = resolveDemandRepoFullName(demand);
    if (!repoFullName) return null;

    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) return null;

    try {
      const repoData = await repoService.getOrCreateRepo(owner, repo);
      if (!repoData) return null;

      const branch = repoData.defaultBranch || 'main';
      const sha = repoData.lastCommit || 'unknown';
      return { branch, sha };
    } catch (error) {
      logger.warn('M-3: falha ao resolver chave de cache do contexto', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: demand.id },
      });
      return null;
    }
  }

  /**
   * Creates a comprehensive context with project constraints and real data
   * @param demand - The demand being processed
   * @returns Structured context string
   */
  async buildContext(demand: Demand): Promise<string> {
    const baseContext = this.createBaseContext();

    // M-3: tenta acerto de cache intermediário para repoContext.
    const repoCacheKey = await this.resolveRepoCacheKey(demand);
    const startMs = Date.now();
    let repoContextRaw: string | undefined;

    if (repoCacheKey) {
      repoContextRaw = contextCache.get(demand, repoCacheKey.branch, repoCacheKey.sha);
      contextCache.logInstrumentation({
        timestamp: new Date().toISOString(),
        inputHash: contextCache.buildInputHash(demand),
        branch: repoCacheKey.branch,
        sha: repoCacheKey.sha,
        latencyMs: Date.now() - startMs,
        demandType: demand.type,
        hit: repoContextRaw !== undefined,
      });
    }

    if (repoContextRaw === undefined) {
      const missStart = Date.now();
      repoContextRaw = await this.createRepositoryContext(demand);
      if (repoCacheKey) {
        contextCache.set(demand, repoCacheKey.branch, repoCacheKey.sha, repoContextRaw);
      }
      contextCache.logInstrumentation({
        timestamp: new Date().toISOString(),
        inputHash: contextCache.buildInputHash(demand),
        branch: repoCacheKey?.branch ?? 'unknown',
        sha: repoCacheKey?.sha ?? 'unknown',
        latencyMs: Date.now() - missStart,
        demandType: demand.type,
        hit: false,
      });
    }

    // Spec 007: política por tipo de demanda — baseline proporcional (FR-018/019)
    // e regra de citação de paths conforme disponibilidade de repositório (FR-008).
    const repoAvailable =
      resolveDemandRepoFullName(demand) !== null &&
      !repoContextRaw.includes('CONTRATO DE AUSÊNCIA DE REPOSITÓRIO');
    const resolvedRule = resolveDemandTypeRule(demand.type);
    if (!resolvedRule.rule.requireBaseline) {
      emitBaselineRequirementSkipped({ demandType: demand.type, demandId: demand.id });
    }
    const repoContext = `${repoContextRaw}\n\n${this.buildEvidencePolicyDirective(
      resolvedRule.rule.requireBaseline,
      repoAvailable,
    )}`;

    // Initialize evolving context for this demand
    this.evolvingContexts.set(demand.id, {
      baseContext,
      repoContext,
      repoAvailable,
      repoId: resolveDemandRepoFullName(demand),
      agentInsights: [],
      decisions: [],
      divergences: [],
      realityConstraints: null,
      lastUpdated: new Date().toISOString(),
      verifiedEvidenceFiles: new Set<string>(),
      externalContext: '',
    });
    this.scheduleContextCleanup(demand.id);
    this.pruneOldContexts();

    return this.capContext(`${baseContext}\n\n${repoContext}`);
  }

  /**
   * Gets the evolved context for a demand, including all agent insights collected so far
   * @param demandId - The demand ID
   * @returns The current evolved context string
   */
  getEvolvedContext(demandId: number): string {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      return this.createBaseContext();
    }

    let evolvedContext = `${ctx.baseContext}\n\n${ctx.repoContext}`;

    // CRIT-4: RAG de refinamentos/domínio, Repo Lock e brief de Phase 0 —
    // enriquecimento montado externamente (ContextAssembler) e injetado aqui
    // para que todo agente do caminho cognitivo o receba.
    if (ctx.externalContext) {
      evolvedContext += `\n\n${ctx.externalContext}`;
    }

    // Add reality constraints if available
    const realityConstraintsText = this.getRealityConstraintsText(demandId);
    if (realityConstraintsText) {
      evolvedContext += `\n\n${realityConstraintsText}`;
    }

    // Add accumulated agent insights
    const agentInsights = this.getContextEngineeringInsights(ctx.agentInsights);
    if (agentInsights.length > 0) {
      evolvedContext += '\n\n--- INSIGHTS ACUMULADOS DOS AGENTES ---\n';
      evolvedContext +=
        'Use estes insights dos agentes anteriores para enriquecer sua análise:\n\n';

      for (const insight of agentInsights) {
        evolvedContext += `**${insight.agentName.toUpperCase()}** (${insight.timestamp}):\n`;
        evolvedContext += `${this.extractKeyInsights(insight.insight)}\n\n`;
      }
    }

    // Slice 2: superfície explícita de decisões/divergências preservadas, atrás de
    // flag (default off). Garante que decisões antigas e divergências em aberto
    // cheguem aos agentes seguintes sem serem truncadas pela summarização.
    if (this.isTypedStateContextEnabled()) {
      if (ctx.decisions.length > 0) {
        evolvedContext += '\n\n--- DECISÕES DA SQUAD (PRESERVADAS — NÃO RE-DECIDIR) ---\n';
        for (const decision of ctx.decisions) {
          evolvedContext += `- [${decision.agentName}] ${decision.text}\n`;
        }
      }
      if (ctx.divergences.length > 0) {
        evolvedContext += '\n--- DIVERGÊNCIAS EM ABERTO (RESOLVER OU REGISTRAR TRADE-OFF) ---\n';
        for (const divergence of ctx.divergences) {
          evolvedContext += `- [${divergence.agentName}] ${divergence.text}\n`;
        }
      }
    }

    return this.capContext(evolvedContext);
  }

  getRepositoryValidationContext(demandId: number): {
    repoAvailable: boolean;
    repoId: string | null;
  } | null {
    const context = this.evolvingContexts.get(demandId);
    return context ? { repoAvailable: context.repoAvailable, repoId: context.repoId } : null;
  }

  /**
   * Define (substituindo) o enriquecimento externo (RAG, Repo Lock etc.) que
   * `getEvolvedContext` emite para todos os agentes desta demanda.
   */
  setExternalContext(demandId: number, text: string): void {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      logger.warn(
        `Contexto evoluindo não encontrado para demanda ${demandId} ao definir contexto externo`,
      );
      return;
    }
    ctx.externalContext = text;
    ctx.lastUpdated = new Date().toISOString();
    this.evolvingContexts.set(demandId, ctx);
  }

  /**
   * Anexa (prefixando) conteúdo ao enriquecimento externo já definido — usado
   * por adições posteriores como o brief da Phase 0 Discovery.
   */
  appendExternalContext(demandId: number, text: string): void {
    if (!text) return;
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      logger.warn(
        `Contexto evoluindo não encontrado para demanda ${demandId} ao anexar contexto externo`,
      );
      return;
    }
    ctx.externalContext = ctx.externalContext ? `${text}\n\n${ctx.externalContext}` : text;
    ctx.lastUpdated = new Date().toISOString();
    this.evolvingContexts.set(demandId, ctx);
  }

  async validateAgentResponse(response: string, demand: Demand) {
    return this.validateResponse(response, this.getEvidenceValidationOptions(demand));
  }

  private getEvidenceValidationOptions(demand: Demand): EvidenceValidationOptions {
    const repoFullName = resolveDemandRepoFullName(demand);
    const repositoryContext = this.getRepositoryValidationContext(demand.id);

    return {
      demandType: demand.type,
      repoAvailable: repositoryContext?.repoAvailable ?? repoFullName !== null,
      repoId: repositoryContext?.repoId ?? repoFullName ?? 'none',
      demandId: demand.id,
    };
  }

  /**
   * Hard ceiling for prompt context. Keeps the beginning (system constraints and
   * repository identity) and the most recent tail (decisions/insights), marking
   * the omitted middle explicitly so callers never send an unbounded prompt.
   */
  capContext(context: string): string {
    const normalized = context.trim();
    if (normalized.length <= this.maxContextChars) return normalized;

    const marker = '\n\n--- CONTEXTO INTERMEDIÁRIO OMITIDO PELO TETO ---\n\n';
    const available = Math.max(0, this.maxContextChars - marker.length);
    const headLength = Math.ceil(available * 0.6);
    const tailLength = available - headLength;
    return `${normalized.slice(0, headLength)}${marker}${normalized.slice(-tailLength)}`;
  }

  private isTypedStateContextEnabled(): boolean {
    try {
      return featureFlags.getFlags().typedStateContextEnabled === true;
    } catch (_) {
      return false;
    }
  }

  private getContextEngineeringInsights(insights: AgentInsight[]): AgentInsight[] {
    try {
      const flags = featureFlags.getFlags();
      if (flags.contextEngineeringEnabled !== true) return insights;
      return selectSalientInsights(insights, flags.contextHistoryK);
    } catch (_) {
      return insights;
    }
  }

  /**
   * Adds an agent's insight to the evolving context
   * This is the core of the Context Evolution Loop
   * @param demandId - The demand ID
   * @param agentName - Name of the agent providing the insight
   * @param insight - The agent's response/insight
   */
  addAgentInsight(demandId: number, agentName: string, insight: string): void {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      logger.warn(`Contexto evoluindo não encontrado para demanda ${demandId}`);
      return;
    }

    const timestamp = new Date().toLocaleTimeString('pt-BR');
    ctx.agentInsights.push({ agentName, insight, timestamp });
    if (ctx.agentInsights.length > ContextBuilder.MAX_AGENT_INSIGHTS) {
      ctx.agentInsights.splice(0, ctx.agentInsights.length - ContextBuilder.MAX_AGENT_INSIGHTS);
    }

    // Slice 1: captura decisões/divergências como estado tipado a partir da resposta
    // do agente (que já emite **Recomendação:** / **Decisão:** / **Divergência:**).
    for (const text of this.extractStatementLines(insight, /\*\*\s*(Decisão|Recomendação)\b/i)) {
      this.pushStatement(ctx.decisions, { agentName, text, timestamp });
    }
    for (const text of this.extractStatementLines(insight, /\*\*\s*Diverg[êe]ncia\b/i)) {
      this.pushStatement(ctx.divergences, { agentName, text, timestamp });
    }

    ctx.lastUpdated = new Date().toISOString();
    this.evolvingContexts.set(demandId, ctx);
    this.scheduleContextCleanup(demandId);

    logger.debug(`Contexto evoluído: insight adicionado de ${agentName} para demanda ${demandId}`, {
      context: { demandId, agentName, totalInsights: ctx.agentInsights.length },
    });

    void this.maybeSummarizeOldInsights(demandId);
  }

  private async maybeSummarizeOldInsights(demandId: number): Promise<void> {
    let flags: ReturnType<typeof featureFlags.getFlags>;
    try {
      flags = featureFlags.getFlags();
    } catch (_) {
      return;
    }
    if (!flags.enableContextSummarization || this.summarizationInFlight.has(demandId)) return;

    const ctx = this.evolvingContexts.get(demandId);
    const threshold = flags.contextSummarizationThreshold;
    if (!ctx || ctx.agentInsights.length < threshold) return;

    const oldCount = ctx.agentInsights.length - ContextBuilder.RECENT_INSIGHTS_TO_PRESERVE;
    if (oldCount <= 1) return;
    const oldInsights = ctx.agentInsights.slice(0, oldCount);
    const sourceHash = this.hashInsights(oldInsights);
    this.summarizationInFlight.add(demandId);

    try {
      let compact = this.summaryCache.get(sourceHash);
      let originalTokens = oldInsights.reduce(
        (total, item) => total + Math.ceil(item.insight.length / 4),
        0,
      );
      if (!compact) {
        const { summaryBuilder } = await import('./structured-summary');
        const summary = await summaryBuilder.buildStructuredSummary(oldInsights, true);
        compact = summaryBuilder.formatAsCompactText(summary);
        originalTokens = summary.metadata.originalTokens;
        this.summaryCache.set(sourceHash, compact);
        if (this.summaryCache.size > 100) {
          this.summaryCache.delete(this.summaryCache.keys().next().value as string);
        }
      }

      if (!compact.trim()) {
        compact = oldInsights
          .map((item) => `[${item.agentName}] ${this.extractKeyInsights(item.insight)}`)
          .join('\n')
          .slice(0, 2_000);
      }

      const current = this.evolvingContexts.get(demandId);
      if (
        !current ||
        current !== ctx ||
        this.hashInsights(current.agentInsights.slice(0, oldCount)) !== sourceHash
      ) {
        return;
      }

      const compactTokens = Math.ceil(compact.length / 4);
      if (compactTokens >= originalTokens) return;
      current.agentInsights = [
        {
          agentName: 'system_summarizer',
          insight: compact,
          timestamp: new Date().toLocaleTimeString('pt-BR'),
        },
        ...current.agentInsights.slice(oldCount),
      ];
      current.lastUpdated = new Date().toISOString();
      contextSummarizationTokensSaved.inc(Math.max(0, originalTokens - compactTokens));
    } catch (error) {
      logger.warn('Context summarization failed; hard cap remains active', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      });
    } finally {
      this.summarizationInFlight.delete(demandId);
    }
  }

  private hashInsights(insights: AgentInsight[]): string {
    return createHash('sha256')
      .update(insights.map((item) => `${item.agentName}\u0000${item.insight}`).join('\u0001'))
      .digest('hex');
  }

  /**
   * Gets all insights from a specific agent for a demand
   */
  getAgentInsights(demandId: number, agentName: string): string[] {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) return [];

    return ctx.agentInsights
      .filter((insight) => insight.agentName === agentName)
      .map((insight) => insight.insight);
  }

  /**
   * Insere uma decisão/divergência no estado tipado deduplicando por texto
   * normalizado (evita repetir a mesma decisão a cada turno) e aplicando o teto
   * MAX_TYPED_STATEMENTS (mantém as mais recentes). Sem isso o bloco tipado
   * estoura tokens em runs longos.
   */
  private pushStatement(list: SquadStatement[], statement: SquadStatement): void {
    const key = this.normalizeStatementText(statement.text);
    if (key.length === 0) return;
    if (list.some((existing) => this.normalizeStatementText(existing.text) === key)) {
      return;
    }
    list.push(statement);
    if (list.length > ContextBuilder.MAX_TYPED_STATEMENTS) {
      list.splice(0, list.length - ContextBuilder.MAX_TYPED_STATEMENTS);
    }
  }

  private normalizeStatementText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Extrai linhas que casam um marcador (ex.: **Recomendação:**) de uma resposta. */
  private extractStatementLines(insight: string, marker: RegExp): string[] {
    return insight
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => marker.test(line));
  }

  /** Registra explicitamente uma decisão da squad (estado tipado, slice 1). */
  recordDecision(demandId: number, agentName: string, text: string): void {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) return;
    this.pushStatement(ctx.decisions, {
      agentName,
      text,
      timestamp: new Date().toLocaleTimeString('pt-BR'),
    });
    ctx.lastUpdated = new Date().toISOString();
  }

  /** Registra explicitamente uma divergência da squad (estado tipado, slice 1). */
  recordDivergence(demandId: number, agentName: string, text: string): void {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) return;
    this.pushStatement(ctx.divergences, {
      agentName,
      text,
      timestamp: new Date().toLocaleTimeString('pt-BR'),
    });
    ctx.lastUpdated = new Date().toISOString();
  }

  getDecisions(demandId: number): SquadStatement[] {
    return this.evolvingContexts.get(demandId)?.decisions ?? [];
  }

  getDivergences(demandId: number): SquadStatement[] {
    return this.evolvingContexts.get(demandId)?.divergences ?? [];
  }

  /**
   * Records the file paths from a validated EvidenceBlock so they can later
   * be used to constrain document-level generation (PRD/TDD).
   *
   * Only records non-empty evidence whose sourceType is NOT 'blocked' —
   * those are the paths the squad actually examined and that passed
   * `verifyFilesExist`.
   */
  recordVerifiedEvidence(demandId: number, evidence: EvidenceBlock | undefined): void {
    if (!evidence || evidence.sourceType === 'blocked') return;
    if (!evidence.evidenceFiles || evidence.evidenceFiles.length === 0) return;

    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      logger.warn(
        `Contexto evoluindo não encontrado para demanda ${demandId} ao registrar evidência`,
      );
      return;
    }

    for (const file of evidence.evidenceFiles) {
      ctx.verifiedEvidenceFiles.add(file);
    }
    ctx.lastUpdated = new Date().toISOString();
    this.scheduleContextCleanup(demandId);
  }

  /**
   * Returns the cumulative set of file paths verified by the squad during
   * the refinement of a demand. The document generators (PM/Tech Lead) use
   * this to bound their citations — the LLM is told it MUST only cite from
   * this list, and the server filters the output to enforce it.
   */
  getVerifiedEvidenceFiles(demandId: number): string[] {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) return [];
    return Array.from(ctx.verifiedEvidenceFiles);
  }

  /**
   * Returns the raw reality constraints for a demand, or null if none.
   */
  getRealityConstraints(demandId: number): RealityConstraints | null {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) return null;
    return ctx.realityConstraints;
  }

  /**
   * Returns the formatted reality constraints block for a demand, or null if none.
   * Centralizes formatting so both getEvolvedContext and callers like
   * ContextAssembler can inject the same block into prompts.
   */
  getRealityConstraintsText(demandId: number): string | null {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx || !ctx.realityConstraints) {
      return null;
    }
    const rc = ctx.realityConstraints;
    if (rc.unavailable) {
      return `--- REALITY CONSTRAINTS (MANDATORY) ---
[A DEFINIR — reality check indisponível]

IMPORTANTE: O reality-check para esta demanda falhou. NÃO assuma tecnologias
permitidas/proibidas, esforço máximo, ROI mínimo ou requisitos por tipo —
trate como não definido e sinalize a lacuna em vez de inventar valores.`;
    }
    return `--- REALITY CONSTRAINTS (MANDATORY) ---
Maturity Level: ${rc.maturityLevel}
Demand Type: ${rc.demandType || 'not specified'}
Expected Output: ${rc.outputType || 'standard refinement'}
Allowed Technologies: ${rc.allowedTechnologies.join(', ')}
Forbidden Technologies: ${rc.forbiddenTechnologies.join(', ')}
Max Effort: ${rc.maxEffortDays} days
Min ROI: ${rc.minROI}
Type Requirements: ${(rc.typeRequirements || []).join(', ') || 'none'}

IMPORTANTE: Todas as recomendações DEVEM respeitar estas constraints.`;
  }

  /**
   * Sets reality constraints for a demand's context
   */
  setRealityConstraints(demandId: number, constraints: RealityConstraints): void {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx) {
      logger.warn(
        `Contexto evoluindo não encontrado para demanda ${demandId} ao definir constraints`,
      );
      return;
    }

    ctx.realityConstraints = constraints;
    ctx.lastUpdated = new Date().toISOString();
    this.evolvingContexts.set(demandId, ctx);
    this.scheduleContextCleanup(demandId);

    logger.debug(`Reality constraints aplicadas para demanda ${demandId}`, {
      context: {
        demandId,
        maturityLevel: constraints.maturityLevel,
        demandType: constraints.demandType,
      },
    });
  }

  /**
   * Extracts key insights from an agent's response for context enrichment
   * Focuses on actionable items, decisions, and important findings
   */
  private extractKeyInsights(response: string): string {
    const lines = response.split('\n');
    const keyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Extract lines with key markers
      if (
        trimmed.startsWith('**') ||
        trimmed.startsWith('- ') ||
        trimmed.match(/^(Análise|Recomendação|Problema|Impacto|ROI|Esforço|Prioridade):/i) ||
        trimmed.match(/\d+:\d+/) || // ROI pattern
        trimmed.match(/\d+\s*(dia|semana)/i)
      ) {
        // Effort pattern
        keyLines.push(trimmed);
      }
    }

    // Return summary if we found key lines, otherwise return truncated original
    if (keyLines.length > 0) {
      // Slice 2: retenção por saliência — preserva decisões/recomendações/riscos/
      // divergências/prioridade ANTES de cortar, em vez de cortar por posição
      // (evita perder decisões críticas quando há muitas linhas).
      const isCritical = (line: string): boolean =>
        /\*\*\s*(Decisão|Recomendação|Risco|Diverg[êe]ncia|Prioridade)\b/i.test(line) ||
        /^(Decisão|Recomendação|Risco|Prioridade):/i.test(line);
      const critical = keyLines.filter(isCritical);
      const rest = keyLines.filter((line) => !isCritical(line));
      return [...critical, ...rest].slice(0, 8).join('\n');
    }

    // Fallback: return first 300 chars
    return response.substring(0, 300) + (response.length > 300 ? '...' : '');
  }

  /**
   * Clears the evolving context for a demand (call after processing completes)
   */
  clearEvolvingContext(demandId: number): void {
    this.evolvingContexts.delete(demandId);
    const timer = this.cleanupTimers.get(demandId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(demandId);
    }
  }

  getContextStats(): { activeContexts: number; maxContexts: number; ttlMs: number } {
    this.pruneOldContexts();
    return {
      activeContexts: this.evolvingContexts.size,
      maxContexts: this.maxContexts,
      ttlMs: this.contextTtlMs,
    };
  }

  /**
   * Gets summary of all agent insights for document generation
   */
  getInsightsSummary(demandId: number): string {
    const ctx = this.evolvingContexts.get(demandId);
    if (!ctx || ctx.agentInsights.length === 0) {
      return '';
    }

    let summary = '--- RESUMO DOS INSIGHTS DA SQUAD ---\n\n';

    for (const insight of ctx.agentInsights) {
      summary += `### ${insight.agentName.toUpperCase()}\n`;
      summary += `${insight.insight}\n\n`;
    }

    return this.capContext(summary);
  }

  /**
   * Creates base context with project constraints and pragmatic guidelines
   */
  private createBaseContext(): string {
    return `--- PROJECT CORE CONSTRAINTS ---
1. Baseie recomendações em dados concretos quando disponíveis
2. Prefira stack atual para manutenção; avalie alternativas para inovação
3. ROI > 2:1 é desejável, mas inovação estratégica pode ter ROI incerto
4. Esforço proporcional ao valor e nível de entrega
5. Seja específico e prático nas respostas

--- NÍVEIS DE ENTREGA (CALIBRAR ANTES DE COMEÇAR) ---
| Nível | Quando Usar | Formato |
|-------|-------------|---------|
| Quick Fix | Ajuste pontual, bug | 1 parágrafo |
| Feature | Funcionalidade clara | User story + critérios |
| Experimento | Hipótese a validar | Hipótese + métrica |
| MVP | Incerteza alta | PRD leve |
| Iniciativa | Grande escopo | PRD completo |

REGRA: Calibre o processo ao tamanho do problema.

--- PRAGMATIC GUIDELINES ---
1. Evite abstrações prematuras, mas não bloqueie refatorações justificadas
2. Avalie custo-benefício de ferramentas externas vs soluções nativas
3. Calibre a entrega ao nível (Quick Fix não precisa de MVP)
4. Balanceie simplicidade com qualidade de longo prazo
5. Hipóteses explícitas são ponto de partida válido

--- EQUILÍBRIO RIGOR vs OUSADIA ---
- Manutenção/Bug: foco em simplicidade e baixo risco
- Feature: equilíbrio entre praticidade e qualidade
- Inovação: aceitar incerteza, propor experimentos
- Diferenciação: ousadia calculada com guardrails

NÃO BLOQUEAR inovação por falta de baseline ou evidência histórica.
ACEITAR hipóteses explícitas como ponto de partida válido.

--- QUALITY CHECKLIST (PROPORCIONAL AO NÍVEL) ---
Para Quick Fix / Feature:
- [ ] Resolve o problema específico?
- [ ] Baixo risco de regressão?

Para MVP / Iniciativa:
- [ ] Baseado em dados reais do projeto?
- [ ] Stack: preferiu existente ou justificou alternativa?
- [ ] ROI estimado (mesmo aproximado)?
- [ ] Esforço razoável para o valor entregue?

--- REFINEMENT GUIDELINES ---
1. Seja específico: "Adicionar cache no Router" ✅
2. Evite generalizações: "Melhorar performance" ❌
3. Use métricas reais quando disponíveis
4. Priorize: Crítico > Importante > Desejável
5. Seja prático: Soluções implementáveis

--- OUTPUT FORMAT REQUIREMENTS ---
TODAS as respostas devem seguir este formato:

**Análise:** [Análise específica baseada em dados]
**Problema Identificado:** [Problema concreto com evidência]
**Impacto:** [Métrica de impacto mensurável]
**Recomendação:** [Solução específica e prática]
**ROI:** [Cálculo realista de retorno]
**Esforço:** [Tempo estimado em dias]
**Prioridade:** [Crítico/Importante/Desejável]

**Evidence Block (OBRIGATÓRIO):**
\`\`\`json
{
  "sourceType": "direct_read" | "fallback_rag" | "blocked",
  "repoContext": {
    "owner": "string",
    "repo": "string",
    "branch": "string"
  },
  "evidenceFiles": ["path/to/file1", "path/to/file2"]
}
\`\`\`

Exemplo:
**Análise:** O arquivo principal tem muitas responsabilidades
**Problema Identificado:** Alto acoplamento entre lógica de roteamento e serviços
**Impacto:** Dificuldade de manutenção
**Recomendação:** Extrair lógica de roteamento para um serviço dedicado
**ROI:** 4:1
**Esforço:** 2 dias
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": {
    "owner": "context_owner",
    "repo": "context_repo",
    "branch": "main"
  },
  "evidenceFiles": ["src/main.ts", "src/routes.ts"]
}
\`\`\``;
  }

  /**
   * Contrato explícito de ausência de repositório (spec 007/FR-007): o agente
   * DEVE emitir evidência bloqueada e NUNCA citar paths. Reforçado depois da
   * geração pela validação (defesa em profundidade).
   */
  private buildNoRepoEvidenceContract(reason: string): string {
    return `--- REPOSITORY CONTEXT ---
${reason}

CONTRATO DE AUSÊNCIA DE REPOSITÓRIO (OBRIGATÓRIO):
- NÃO existe repositório utilizável nesta demanda. NÃO cite nomes de arquivos, paths ou trechos de código como se existissem.
- O Evidence Block DEVE ser exatamente: "sourceType": "blocked" e "evidenceFiles": [].
- Prossiga com recomendação CONCEITUAL (hipóteses explícitas são ponto de partida válido).
- Qualquer path citado será rejeitado pela validação e marcado como alucinação.`;
  }

  /**
   * Diretiva de política por tipo (spec 007/FR-008/FR-018/FR-019): baseline
   * proporcional ao tipo e regra de citação de paths. A dispensa de baseline
   * NUNCA dispensa integridade numérica.
   */
  private buildEvidencePolicyDirective(requireBaseline: boolean, repoAvailable: boolean): string {
    const baselineDirective = requireBaseline
      ? '- BASELINE OBRIGATÓRIO: esta demanda exige baseline/comparador com fonte antes de conclusões numéricas.'
      : `- Baseline dispensado para este tipo de demanda; a demanda pode avançar sem baseline.
- INTEGRIDADE NUMÉRICA CONTINUA OBRIGATÓRIA: quando um valor não existe, escreva exatamente 'A MEDIR — sem baseline'. Para metas relativas, escreva 'Definir após coletar baseline'. NUNCA invente número, ROI ou meta.`;

    const pathDirective = repoAvailable
      ? `- PATHS: cite somente caminhos RELATIVOS à raiz do repositório e que você realmente verificou no contexto fornecido. Proibidos: paths absolutos (POSIX ou Windows), travessia com '..' e paths não verificados.`
      : `- PATHS: sem repositório utilizável, NENHUM path pode ser citado (ver contrato de ausência de repositório acima).`;

    return `--- POLÍTICA DE EVIDÊNCIA E BASELINE (POR TIPO DE DEMANDA) ---
${baselineDirective}
${pathDirective}`;
  }

  /**
   * Creates repository-specific context if available
   */
  private async createRepositoryContext(demand: Demand): Promise<string> {
    const repoFullName = resolveDemandRepoFullName(demand);
    const repoRef = repoFullName
      ? (() => {
          const [owner, repo] = repoFullName.split('/');
          return owner && repo ? { owner, repo } : null;
        })()
      : null;

    if (!repoRef) {
      return this.buildNoRepoEvidenceContract('Nenhum repositório especificado na demanda.');
    }

    const { owner, repo: repoName } = repoRef;

    try {
      const repo = await repoService.getOrCreateRepo(owner, repoName);
      if (!repo) {
        return this.buildNoRepoEvidenceContract('Repositório não encontrado.');
      }

      const briefing = repo.briefing ? `--- REPOSITORY BRIEFING ---\n${repo.briefing}\n\n` : '';
      const systemMap = repo.systemMap ? `--- SYSTEM MAP ---\n${repo.systemMap}\n\n` : '';

      let specificFilesContext = '';
      const searchQuery = this.buildRepositorySearchQuery(demand.title, demand.description);
      const searchResults = searchQuery
        ? await gitHubService.searchRepo(owner, repoName, searchQuery)
        : [];

      if (searchResults.length > 0) {
        const topFiles = searchResults.slice(0, 5);
        specificFilesContext += '--- DEMAND-SPECIFIC FILE CONTEXT (UNTRUSTED DATA) ---\n';
        const fileChunks: Array<{ sourceKey: string; content: string }> = [];
        for (const filePath of topFiles) {
          try {
            const content = await gitHubService.getRepoContent(owner, repoName, filePath);
            // Type guard: check if content is a file (not array/dir) with encoding
            if (
              content &&
              !Array.isArray(content) &&
              'encoding' in content &&
              content.encoding === 'base64' &&
              'content' in content &&
              content.content
            ) {
              const decodedContent = Buffer.from(content.content, 'base64').toString('utf8');
              fileChunks.push({ sourceKey: filePath, content: decodedContent });
            }
          } catch (error) {
            logger.warn(`Não foi possível ler arquivo ${filePath}`, {
              error: error instanceof Error ? error : undefined,
            });
          }
        }
        // Fronteira de confiança: conteúdo de arquivos do repo é DADO não-confiável.
        // Tria por detectPromptInjection + formata com delimitadores estruturais.
        // Um repo envenenado a montante não vira instrução no prompt.
        if (fileChunks.length > 0) {
          specificFilesContext += screenAndFormat(fileChunks, ` repo:${owner}/${repoName}`);
        }
      }

      return `${briefing}${systemMap}${specificFilesContext}`.trim();
    } catch (error) {
      logger.error(`Erro ao montar contexto do repositório para ${owner}/${repoName}`, {
        error: error instanceof Error ? error : undefined,
      });
      return '--- REPOSITORY CONTEXT ---\nFalha ao carregar contexto do repositório. Prosseguindo com cuidado.';
    }
  }

  private buildRepositorySearchQuery(title: string, description: string): string {
    const stopwords = new Set([
      'de',
      'da',
      'do',
      'das',
      'dos',
      'para',
      'com',
      'sem',
      'que',
      'como',
      'uma',
      'um',
      'e',
      'ou',
      'no',
      'na',
      'nos',
      'nas',
      'por',
      'em',
      'ao',
      'aos',
      'as',
      'os',
      'o',
      'a',
      'mvp',
      'agora',
      'cliente',
      'clientes',
    ]);

    const cleaned = `${title} ${description}`
      .replace(/repo:[^\s]+/gi, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
      .toLowerCase();

    const tokens = cleaned
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopwords.has(token));

    const unique = [...new Set(tokens)];
    if (unique.length === 0) {
      return '';
    }

    // Keep query short to avoid parser/rate issues in GitHub code search.
    // GitHub legacy code search has a limit of 5 operators (AND/OR/NOT).
    // 5 tokens = 4 AND operators, which is safely within the limit.
    return unique.slice(0, 5).join(' ');
  }

  /**
   * Extracts the `**Evidence Block:**` JSON from an LLM response, removes it
   * from the visible text, and verifies cited file paths against the local
   * repo cache (and GitHub API as fallback).
   *
   * Shared by `validateResponse` (used on agent messages, where structural
   * checks like `**Análise:**`/`**ROI:**` also apply) and
   * `validateDocumentEvidence` (used on aggregated documents like PRD/TDD,
   * where only the evidence portion is meaningful).
   *
   * Always succeeds — on missing / malformed / unverifiable evidence it
   * returns issues + scorePenalty for the caller to interpret.
   */
  private async extractAndVerifyEvidence(
    response: string,
    options: EvidenceValidationOptions = {},
  ): Promise<{
    evidence?: EvidenceBlock;
    cleanMessage: string;
    issues: string[];
    scorePenalty: number;
    pathValidation: PathValidationResult;
  }> {
    const issues: string[] = [];
    let scorePenalty = 0;
    const pathValidation = emptyPathValidationResult();
    const demandType = options.demandType ?? 'unknown';
    // `let` é necessário: `evidence` é lido (retornado como undefined nos early
    // returns abaixo) antes de ser atribuído, então não pode ser `const`.
    // eslint-disable-next-line prefer-const
    let evidence: EvidenceBlock | undefined;
    let cleanMessage = response;

    const evidenceMatch = response.match(
      /\*\*Evidence Block.*?\*\*.*?(?:```json)?\s*(\{[\s\S]*\})\s*(?:```|$)/is,
    );

    if (!evidenceMatch || !evidenceMatch[1]) {
      issues.push('Evidence Block: Bloco de evidência obrigatório não encontrado');
      scorePenalty += 30;
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    let rawEvidence: unknown;
    try {
      rawEvidence = JSON.parse(evidenceMatch[1]);
    } catch (_) {
      issues.push('Evidence Block: Falha no parsing do JSON de evidência');
      scorePenalty += 20;
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    // Validação estruturada via zod: estrutura inválida vira issue (mesma penalidade
    // do JSON malformado), evitando construir um EvidenceBlock inconsistente.
    const parsedEvidence = evidenceBlockSchema.safeParse(rawEvidence);
    if (!parsedEvidence.success) {
      const detail = parsedEvidence.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      issues.push(`Evidence Block: Estrutura inválida (${detail})`);
      scorePenalty += 20;
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    evidence = {
      sourceType: parsedEvidence.data.sourceType,
      repoContext: parsedEvidence.data.repoContext as RepoContext,
      evidenceFiles: parsedEvidence.data.evidenceFiles,
      evidenceNotes: parsedEvidence.data.evidenceNotes,
    };
    cleanMessage = response.replace(evidenceMatch[0], '').trim();

    // Spec 007/US1 (FR-007/FR-013): sem repositório utilizável, NENHUM path pode
    // virar evidência — rejeita todos, bloqueia a alegação e segue a orquestração.
    if (options.repoAvailable === false) {
      const repoId = options.repoId ?? 'none';
      if (evidence.evidenceFiles.length > 0) {
        for (const filePath of evidence.evidenceFiles) {
          emitHallucinatedPathBlocked({
            path: filePath,
            demandType,
            repoId,
            demandId: options.demandId,
          });
          emitContractFalsePositiveObservation({
            valid: false,
            demandType,
            repoId,
            path: filePath,
            demandId: options.demandId,
          });
        }
        issues.push(
          `Evidence Block: demanda sem repositório — ${evidence.evidenceFiles.length} path(s) citado(s) rejeitado(s): ${evidence.evidenceFiles.join(', ')}`,
        );
        scorePenalty += 30;
        pathValidation.rejectedPaths = [...evidence.evidenceFiles];
        pathValidation.block = true;
        pathValidation.reason = 'no_repository';
        this.invalidFilesBlocked += evidence.evidenceFiles.length;
        this.totalFilesValidated += evidence.evidenceFiles.length;
      }
      evidence.sourceType = 'blocked';
      evidence.evidenceFiles = [];
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    // Tanto direct_read quanto fallback_rag citam arquivos do repo, então
    // ambos passam pela verificação de existência (cache local + GitHub API).
    const requiresFileVerification =
      evidence.sourceType === 'direct_read' || evidence.sourceType === 'fallback_rag';

    if (!requiresFileVerification) {
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    if (evidence.evidenceFiles.length === 0) {
      if (evidence.sourceType === 'direct_read') {
        issues.push('Evidence Block: direct_read exige pelo menos 1 arquivo de evidência');
        scorePenalty += 20;
        evidence.sourceType = 'blocked';
      } else {
        // fallback_rag sem arquivos: aceitável, mas registra aviso de menor severidade
        issues.push('Evidence Block: fallback_rag sem arquivos citados');
        scorePenalty += 10;
      }
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    if (!evidence.repoContext) {
      const repoId = options.repoId ?? 'unknown';
      pathValidation.unverifiablePaths = [...evidence.evidenceFiles];
      issues.push(
        `Evidence Block: repoContext ausente — ${evidence.evidenceFiles.length} path(s) NÃO VERIFICÁVEL(is)`,
      );
      scorePenalty += 10;
      for (const filePath of evidence.evidenceFiles) {
        emitContractFalsePositiveObservation({
          valid: null,
          demandType,
          repoId,
          path: filePath,
          demandId: options.demandId,
        });
      }
      return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
    }

    // FR-015/SC-002: paths inseguros (absolutos, travessia, encoding) são
    // rejeitados ANTES de qualquer acesso à fonte.
    const allowedExtensions = new Set(
      getEvidenceExtensions().map((extension) => extension.toLowerCase()),
    );
    const unsafePaths = evidence.evidenceFiles.filter(
      (filePath) =>
        isUnsafeRepoPath(filePath) || !allowedExtensions.has(path.extname(filePath).toLowerCase()),
    );
    if (unsafePaths.length > 0) {
      const repoId = evidence.repoContext
        ? `${evidence.repoContext.owner}/${evidence.repoContext.repo}`
        : (options.repoId ?? 'none');
      for (const filePath of unsafePaths) {
        emitHallucinatedPathBlocked({
          path: filePath,
          demandType,
          repoId,
          demandId: options.demandId,
        });
        emitContractFalsePositiveObservation({
          valid: false,
          demandType,
          repoId,
          path: filePath,
          demandId: options.demandId,
        });
      }
      issues.push(`Evidence Block: paths inseguros rejeitados: ${unsafePaths.join(', ')}`);
      scorePenalty += 20;
      pathValidation.rejectedPaths.push(...unsafePaths);
      pathValidation.block = true;
      pathValidation.reason = 'unsafe_path';
      this.invalidFilesBlocked += unsafePaths.length;
      this.totalFilesValidated += unsafePaths.length;
      evidence.evidenceFiles = evidence.evidenceFiles.filter((f) => !unsafePaths.includes(f));
      if (evidence.evidenceFiles.length === 0) {
        evidence.sourceType = 'blocked';
        return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
      }
    }

    // Validar existência dos arquivos no repositório
    const { owner, repo } = evidence.repoContext;
    const repoId = `${owner}/${repo}`;
    const revision = evidence.repoContext.commitSha ?? evidence.repoContext.branch;

    // FR-016/FR-017: cache LRU/TTL evita consultas repetidas dentro da rodada.
    const cachedMissing: string[] = [];
    const cachedExisting: string[] = [];
    const toVerify: string[] = [];
    for (const filePath of evidence.evidenceFiles) {
      const cached = pathValidationCache.get(repoId, revision, filePath);
      if (cached === true) cachedExisting.push(filePath);
      else if (cached === false) cachedMissing.push(filePath);
      else toVerify.push(filePath);
    }

    let missingFiles: string[] = [...cachedMissing];
    let unverifiableFiles: string[] = [];
    let verifiedViaApi = false;

    if (toVerify.length > 0) {
      const repoData = await repoService.getRepoWithFiles(owner, repo);

      if (repoData && repoData.files.length > 0) {
        const filePaths = new Set(repoData.files.map((f) => f.path));
        for (const filePath of toVerify) {
          const exists = filePaths.has(filePath);
          pathValidationCache.set(repoId, revision, filePath, exists);
          if (!exists) missingFiles.push(filePath);
        }
      } else {
        const validFilesToVerify = toVerify.filter((f) => !f.includes('*') && !f.endsWith('/'));
        logger.info(
          `Evidence validation: verificando ${validFilesToVerify.length} arquivos via GitHub API para ${owner}/${repo} (sourceType=${evidence.sourceType})`,
        );
        try {
          const verification = await gitHubService.verifyFilesExist(
            owner,
            repo,
            validFilesToVerify,
          );
          missingFiles = [...missingFiles, ...verification.missing];
          const classified = new Set([...verification.existing, ...verification.missing]);
          unverifiableFiles.push(
            ...validFilesToVerify.filter((filePath) => !classified.has(filePath)),
          );
          for (const filePath of verification.missing) {
            pathValidationCache.set(repoId, revision, filePath, false);
          }
          for (const filePath of verification.existing) {
            pathValidationCache.set(repoId, revision, filePath, true);
          }
          verifiedViaApi = true;

          if (verification.existing.length > 0) {
            logger.info(
              `Evidence validation: ${verification.existing.length} arquivos verificados via API`,
            );
          }
        } catch (apiError) {
          // FR-012: indisponibilidade da fonte NÃO é inexistência. Os paths ficam
          // não verificáveis: não são removidos como falsos, nem promovidos a
          // válidos, e NÃO são cacheados.
          logger.warn(
            `Evidence validation: fonte indisponível — paths não verificáveis: ${apiError}`,
          );
          unverifiableFiles = [...toVerify];
        }
      }
    }

    // Track validation metrics
    this.totalFilesValidated += evidence.evidenceFiles.length;

    // Observações estruturadas (FR-020/FR-022): uma linha por path validado.
    for (const filePath of evidence.evidenceFiles) {
      const valid = missingFiles.includes(filePath)
        ? false
        : unverifiableFiles.includes(filePath)
          ? null
          : true;
      emitContractFalsePositiveObservation({
        valid,
        demandType,
        repoId,
        path: filePath,
        demandId: options.demandId,
      });
    }

    if (unverifiableFiles.length > 0) {
      pathValidation.unverifiablePaths = unverifiableFiles;
      issues.push(
        `Evidence Block: fonte indisponível — ${unverifiableFiles.length} path(s) NÃO VERIFICÁVEL(is) (não confirmados nem rejeitados): ${unverifiableFiles.join(', ')}`,
      );
      scorePenalty += 10;
      evidence.evidenceNotes = evidence.evidenceNotes
        ? `${evidence.evidenceNotes} ATENÇÃO: ${unverifiableFiles.length} path(s) não verificável(is) por indisponibilidade da fonte.`
        : `ATENÇÃO: ${unverifiableFiles.length} path(s) não verificável(is) por indisponibilidade da fonte.`;
    }

    if (missingFiles.length > 0) {
      // Increment blocked files counter
      this.invalidFilesBlocked += missingFiles.length;

      for (const filePath of missingFiles) {
        emitHallucinatedPathBlocked({
          path: filePath,
          demandType,
          repoId,
          demandId: options.demandId,
        });
      }

      const source = verifiedViaApi ? 'GitHub API' : 'cache local';
      issues.push(
        `Evidence Block: Arquivos NÃO EXISTEM (verificado via ${source}): ${missingFiles.join(', ')}`,
      );
      scorePenalty += 30;
      pathValidation.rejectedPaths.push(...missingFiles);
      pathValidation.block = true;
      pathValidation.reason = pathValidation.reason ?? 'path_not_found';

      evidence.evidenceFiles = evidence.evidenceFiles.filter((f) => !missingFiles.includes(f));

      if (evidence.evidenceFiles.length === 0) {
        evidence.sourceType = 'blocked';
        evidence.evidenceNotes =
          'ATENÇÃO: Nenhum arquivo de evidência pôde ser verificado. Os arquivos citados não existem no repositório.';
      } else {
        evidence.evidenceNotes = `ATENÇÃO: ${missingFiles.length} arquivo(s) removido(s) por não existirem no repositório.`;
      }
    }

    pathValidation.validPaths = evidence.evidenceFiles.filter(
      (f) => !unverifiableFiles.includes(f),
    );

    return { evidence, cleanMessage, issues, scorePenalty, pathValidation };
  }

  private extractFreeTextFileReferences(text: string): string[] {
    const references = new Set<string>();

    // A whitelist limita candidatos, mas cada candidato ainda passa pela
    // verificação real de existência (spec 007/FR-014).
    const extensionPattern = getEvidenceExtensions()
      .map((extension) => extension.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const fileRegex = new RegExp(
      `(?:^|[\\s\u0060'"(])((?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+\\.(?:${extensionPattern}))\\b`,
      'g',
    );

    // Regex para pastas (terminando em /) que comecem com diretorios-raiz conhecidos
    const dirRegex =
      /(?:^|[\s`'"(])((?:server|client|shared|agents|src|docs|tests|migrations|scripts|config)\/(?:[A-Za-z0-9_.-]+\/)*)/g;

    const denylist = [
      'ligado/desligado',
      'ligar/desligar',
      'sim/não',
      'sim/nao',
      'entrada/saída',
      'entrada/saida',
      'ativo/inativo',
      'verdadeiro/falso',
      'true/false',
      'on/off',
      'sucesso/erro',
      'x/y',
      'h/m',
      'h/mes',
      'h/mês',
      'v/f',
      '5h/m',
      '2h/m',
      '7h/m',
      '0h/m',
    ];

    const cleanCandidate = (raw: string): string => {
      return raw
        .replace(/[),.;:!?`'"]+$/g, '')
        .replace(/^\/+/, '')
        .trim();
    };

    let match: RegExpExecArray | null;
    fileRegex.lastIndex = 0;
    while ((match = fileRegex.exec(text)) !== null) {
      const candidate = cleanCandidate(match[1]);
      if (candidate) references.add(candidate);
    }

    dirRegex.lastIndex = 0;
    while ((match = dirRegex.exec(text)) !== null) {
      const candidate = cleanCandidate(match[1]);
      if (candidate) references.add(candidate);
    }

    const result: string[] = [];
    for (const candidate of references) {
      if (candidate.includes('://')) continue;
      if (candidate.includes('..')) continue;
      if (candidate.startsWith('node_modules/')) continue;

      // Guarda anti-fração (ex: 2/3, 5/5)
      if (/^\d+\/\d+$/.test(candidate)) continue;

      // Guarda: se nenhum segmento contiver letra (ex: 3/5 ou só números e barras)
      const segments = candidate.split('/');
      const hasLetters = segments.some((seg) => /[a-zA-Z]/.test(seg));
      if (!hasLetters) continue;

      // Denylist de termos comuns com barra
      const lowercaseCandidate = candidate.toLowerCase();
      if (denylist.some((term) => lowercaseCandidate.includes(term))) continue;

      result.push(candidate);
    }

    // Filtrar diretórios redundantes se o arquivo correspondente mais específico já foi capturado
    return result.filter((path) => {
      if (path.endsWith('/')) {
        return !result.some((other) => other !== path && other.startsWith(path));
      }
      return true;
    });
  }

  private localPathExists(relativePath: string): boolean {
    return localPathExistsWithinRoot(relativePath);
  }

  private async findMissingFreeTextReferences(
    references: string[],
    evidence?: EvidenceBlock,
  ): Promise<{ valid: string[]; missing: string[]; unverifiable: string[] }> {
    if (references.length === 0) return { valid: [], missing: [], unverifiable: [] };

    const localMissing = references.filter((reference) => !this.localPathExists(reference));
    const localValid = references.filter((reference) => !localMissing.includes(reference));
    if (localMissing.length === 0) {
      return { valid: localValid, missing: [], unverifiable: [] };
    }

    const repoContext = evidence?.repoContext;
    if (!repoContext?.owner || !repoContext?.repo) {
      return { valid: localValid, missing: localMissing, unverifiable: [] };
    }

    try {
      const repoData = await repoService.getRepoWithFiles(repoContext.owner, repoContext.repo);
      if (repoData && repoData.files.length > 0) {
        const filePaths = new Set(repoData.files.map((file) => file.path));
        const missing = localMissing.filter((reference) => {
          if (reference.endsWith('/')) {
            return !Array.from(filePaths).some((filePath) => filePath.startsWith(reference));
          }
          return !filePaths.has(reference);
        });
        return {
          valid: [
            ...localValid,
            ...localMissing.filter((reference) => !missing.includes(reference)),
          ],
          missing,
          unverifiable: [],
        };
      }

      const fileReferences = localMissing.filter((reference) => !reference.endsWith('/'));
      const directoryReferences = localMissing.filter((reference) => reference.endsWith('/'));
      const verification = await gitHubService.verifyFilesExist(
        repoContext.owner,
        repoContext.repo,
        fileReferences,
      );

      return {
        valid: [...localValid, ...verification.existing],
        missing: verification.missing,
        // A API de arquivos não confirma diretórios; não os declare inexistentes.
        unverifiable: directoryReferences,
      };
    } catch (error) {
      logger.warn('Free-text evidence validation failed', {
        error: error instanceof Error ? error : undefined,
        context: { references: localMissing },
      });
      return { valid: localValid, missing: [], unverifiable: localMissing };
    }
  }

  /**
   * Validates ONLY the evidence portion of a document-style response (PRD,
   * TDD, summaries) — without applying agent-message structural checks like
   * `**Análise:**` / `**ROI:**` / `**Esforço:**`.
   *
   * Used by `generatePRDWithPM` to catch hallucinated file paths in the
   * aggregated document, where the agent-level handshake doesn't reach.
   */
  async validateDocumentEvidence(
    response: string,
    options: EvidenceValidationOptions = {},
  ): Promise<{
    evidence?: EvidenceBlock;
    cleanMessage: string;
    issues: string[];
    pathValidation: PathValidationResult;
  }> {
    const result = await this.extractAndVerifyEvidence(response, options);
    const freeTextReferences = this.extractFreeTextFileReferences(result.cleanMessage);
    const freeTextValidation =
      options.repoAvailable === false
        ? { valid: [], missing: freeTextReferences, unverifiable: [] }
        : await this.findMissingFreeTextReferences(freeTextReferences, result.evidence);
    const missingFreeTextReferences = freeTextValidation.missing;
    const repoId =
      options.repoId ??
      (result.evidence?.repoContext
        ? `${result.evidence.repoContext.owner}/${result.evidence.repoContext.repo}`
        : 'none');
    const demandType = options.demandType ?? 'unknown';

    for (const filePath of freeTextValidation.valid) {
      emitContractFalsePositiveObservation({
        valid: true,
        demandType,
        repoId,
        path: filePath,
        demandId: options.demandId,
      });
    }

    for (const filePath of freeTextValidation.unverifiable) {
      emitContractFalsePositiveObservation({
        valid: null,
        demandType,
        repoId,
        path: filePath,
        demandId: options.demandId,
      });
    }

    if (freeTextValidation.unverifiable.length > 0) {
      result.pathValidation.unverifiablePaths.push(...freeTextValidation.unverifiable);
      result.issues.push(
        `Texto livre: ${freeTextValidation.unverifiable.length} referência(s) NÃO VERIFICÁVEL(is) por indisponibilidade da fonte: ${freeTextValidation.unverifiable.join(', ')}`,
      );
    }

    if (missingFreeTextReferences.length > 0) {
      for (const filePath of missingFreeTextReferences) {
        emitHallucinatedPathBlocked({
          path: filePath,
          demandType,
          repoId,
          demandId: options.demandId,
        });
        emitContractFalsePositiveObservation({
          valid: false,
          demandType,
          repoId,
          path: filePath,
          demandId: options.demandId,
        });
      }
      result.pathValidation.rejectedPaths.push(...missingFreeTextReferences);
      result.pathValidation.block = true;
      result.pathValidation.reason =
        options.repoAvailable === false ? 'no_repository' : 'path_not_found';
      result.issues.push(
        options.repoAvailable === false
          ? `Texto livre: demanda sem repositório — referências rejeitadas: ${missingFreeTextReferences.join(', ')}`
          : `Texto livre: Arquivos/pastas citados no corpo NÃO EXISTEM: ${missingFreeTextReferences.join(', ')}`,
      );

      if (result.evidence) {
        const note = `${missingFreeTextReferences.length} referência(s) inválida(s) no corpo do documento: ${missingFreeTextReferences.join(', ')}`;
        result.evidence.evidenceNotes = result.evidence.evidenceNotes
          ? `${result.evidence.evidenceNotes} ${note}`
          : `ATENÇÃO: ${note}`;
      }
    }

    return {
      evidence: result.evidence,
      cleanMessage: result.cleanMessage,
      issues: result.issues,
      pathValidation: result.pathValidation,
    };
  }

  /**
   * Validates agent response with pragmatic checks (reduced penalties)
   * @param response - Agent response to validate
   * @returns Validation result with score
   */
  async validateResponse(
    response: string,
    options: EvidenceValidationOptions = {},
  ): Promise<{
    isValid: boolean;
    score: number;
    issues: string[];
    structuredIssues: ValidationIssue[];
    evidence?: EvidenceBlock;
    cleanMessage?: string;
    pathValidation: PathValidationResult;
  }> {
    // Gate de resposta de agente expresso no MESMO contrato tiered (severity +
    // category) usado pelos validadores de improvement-execution. As penalidades
    // soft passam a ser issues 'warning'; o bloco de evidência obrigatório ausente
    // é o único 'error' (hard block) — preservando a semântica anterior.
    const structuredIssues: ValidationIssue[] = [];
    let score = 100;

    const evidenceResult = await this.extractAndVerifyEvidence(response, options);
    const evidence = evidenceResult.evidence;
    const cleanMessage = evidenceResult.cleanMessage;
    for (const message of evidenceResult.issues) {
      structuredIssues.push({
        section: 'Evidence Block',
        message,
        severity: message.includes('obrigatório não encontrado') ? 'error' : 'warning',
        category: 'semantic',
      });
    }
    // Reduced evidence penalty (was full scorePenalty, now 50%)
    score -= Math.floor(evidenceResult.scorePenalty * 0.5);

    const structureScore = scoreAgentResponseStructure(response);
    structuredIssues.push(...structureScore.structuredIssues);
    score += structureScore.scoreDelta;

    // issues (string[]) preservado para compatibilidade com os consumidores atuais;
    // isValid agora deriva da ausência de issues 'error' no contrato unificado
    // (equivalente à regra anterior de "bloco obrigatório não encontrado").
    const issues = structuredIssues.map((issue) => issue.message);
    const hasBlockingError = structuredIssues.some((issue) => issue.severity === 'error');

    return {
      isValid: score >= 50 && !hasBlockingError, // threshold 50; bloco de evidência obrigatório continua hard block
      score,
      issues,
      structuredIssues,
      evidence,
      cleanMessage,
      pathValidation: evidenceResult.pathValidation,
    };
  }

  /**
   * Valida o "Response Contract" (bloco JSON estruturado) de uma resposta de agente
   * contra o agentResponseContractSchema. Usado pelo piloto da Fase 2 / Faixa B:
   * falhas retornam ValidationIssue 'error' que alimentam o loop de reparo. Retorna
   * também o conteúdo sem o bloco, para não poluir o downstream (geração de PRD).
   */
  validateResponseContract(response: string): {
    valid: boolean;
    issues: ValidationIssue[];
    cleanMessage: string;
  } {
    const match = response.match(
      /\*\*Response Contract.*?\*\*.*?(?:```json)?\s*(\{[\s\S]*?\})\s*(?:```|$)/is,
    );

    if (!match || !match[1]) {
      return {
        valid: false,
        issues: [
          {
            section: 'Response Contract',
            message: 'Response Contract: bloco JSON obrigatório não encontrado',
            severity: 'error',
            category: 'structural',
          },
        ],
        cleanMessage: response,
      };
    }

    const cleanMessage = response.replace(match[0], '').trim();

    let raw: unknown;
    try {
      raw = JSON.parse(match[1]);
    } catch (_) {
      return {
        valid: false,
        issues: [
          {
            section: 'Response Contract',
            message: 'Response Contract: JSON inválido',
            severity: 'error',
            category: 'structural',
          },
        ],
        cleanMessage,
      };
    }

    const parsed = agentResponseContractSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        valid: false,
        issues: parsed.error.issues.map((issue) => ({
          section: 'Response Contract',
          message: `Response Contract — ${issue.path.join('.') || 'root'}: ${issue.message}`,
          severity: 'error' as const,
          category: 'semantic' as const,
        })),
        cleanMessage,
      };
    }

    return { valid: true, issues: [], cleanMessage };
  }

  private scheduleContextCleanup(demandId: number): void {
    const existingTimer = this.cleanupTimers.get(demandId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.evolvingContexts.delete(demandId);
      this.cleanupTimers.delete(demandId);
      logger.debug(`Contexto evoluindo expirado e limpo para demanda ${demandId}`);
    }, this.contextTtlMs);

    timer.unref?.();
    this.cleanupTimers.set(demandId, timer);
  }

  private pruneOldContexts(): void {
    if (this.evolvingContexts.size <= this.maxContexts) {
      return;
    }

    const sortedContexts = Array.from(this.evolvingContexts.entries()).sort(
      ([, left], [, right]) =>
        new Date(left.lastUpdated).getTime() - new Date(right.lastUpdated).getTime(),
    );

    const contextsToRemove = sortedContexts.slice(0, this.evolvingContexts.size - this.maxContexts);
    for (const [demandId] of contextsToRemove) {
      this.clearEvolvingContext(demandId);
    }
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * Returns validation metrics for monitoring
   * @returns Metrics object with counts of validated and blocked files
   */
  getValidationMetrics(): { invalidFilesBlocked: number; totalFilesValidated: number } {
    return {
      invalidFilesBlocked: this.invalidFilesBlocked,
      totalFilesValidated: this.totalFilesValidated,
    };
  }

  /**
   * Resets validation metrics (useful for testing)
   */
  resetValidationMetrics(): void {
    this.invalidFilesBlocked = 0;
    this.totalFilesValidated = 0;
  }
}

export const contextBuilder = new ContextBuilder();
