import { logger } from '../utils/logger';
import { promptVersionService, type VersionResolutionResult } from './prompt-version';
import { runAgentWithTools, renderAgentToolCallsTrailer } from './agent-tools-runtime';
import { resolveDemandRepoFullName } from '../utils/repo-context';
import type { Demand } from '@shared/schema';

export interface PromptResolutionResult {
  resolvedSystemPrompt: string | null;
  promptVersionUsed: string;
  promptVersionSource: string;
  abTestId: number | undefined;
}

export interface ToolExecutionResult {
  response: string;
  trailer: string;
}

export interface OrchestrationToolContext {
  runId?: string;
  turnId?: string;
  turnIndex?: number;
  pipelineId?: string;
}

/**
 * Resolve a versão do prompt para um agente, tentando versionamento primeiro
 * e fallback para filesystem config
 *
 * 🟢 Guard clause: retorna filesystem config se versionamento falhar
 */
export async function resolvePromptVersion(
  agentName: string,
  demandId: number,
  executionId: string | undefined,
): Promise<PromptResolutionResult> {
  let resolvedSystemPrompt: string | null = null;
  let promptVersionUsed: string = 'filesystem';
  let promptVersionSource: string = 'filesystem';
  let abTestId: number | undefined;

  const promptVersioningEnabled = true; // Simplificado - pode ser configurável
  try {
    if (!promptVersioningEnabled) throw new Error('skip');
    const sessionId = executionId || String(demandId);
    const versionResult: VersionResolutionResult | null = await promptVersionService.resolveVersion(
      agentName,
      sessionId,
    );

    if (versionResult) {
      resolvedSystemPrompt = versionResult.content;
      promptVersionUsed = versionResult.version;
      promptVersionSource = versionResult.source;
      abTestId = versionResult.abTestId;
      logger.debug('Using versioned prompt', {
        context: { agentName, version: promptVersionUsed, source: promptVersionSource },
      });
    }
  } catch (error) {
    // Non-fatal: fall back to filesystem prompt
    logger.warn('Prompt version resolution failed, falling back to filesystem', {
      error: error instanceof Error ? error : undefined,
      context: { agentName },
    });
  }

  return { resolvedSystemPrompt, promptVersionUsed, promptVersionSource, abTestId };
}

/**
 * Executa o agente com tools genéricas (Tech Lead, PM, QA, etc.)
 *
 * 🔵 Early return: retorna string vazia se tools falharem
 */
export async function executeAgentWithGenericTools(
  systemPrompt: string,
  userPrompt: string,
  agentName: string,
  model: string | undefined,
  modelFallback: string | undefined,
  temperature: number,
  maxTokens: number,
  demandId: number,
  demand: Demand,
  orchestration?: OrchestrationToolContext,
): Promise<ToolExecutionResult> {
  try {
    const repoFullName = resolveDemandRepoFullName(demand);
    const userPromptWithRepo = repoFullName
      ? `${userPrompt}\n\n--- REPOSITÓRIO DA DEMANDA ---\nrepoFullName: ${repoFullName}\nUse este valor como parâmetro "repoFullName" em todas as tool calls que exigirem o repositório.`
      : userPrompt;

    const toolsResult = await runAgentWithTools({
      systemPrompt,
      userPrompt: userPromptWithRepo,
      agentName,
      model,
      modelFallback,
      temperature,
      maxTokens,
      demandId,
      orchestrationRunId: orchestration?.runId,
      orchestrationTurnId: orchestration?.turnId,
      orchestrationTurnIndex: orchestration?.turnIndex,
      orchestrationPipelineId: orchestration?.pipelineId,
    });
    if (toolsResult.enabled && toolsResult.text && toolsResult.text.trim().length > 0) {
      const trailer =
        process.env.AGENT_TOOLS_TRAILER !== 'false'
          ? renderAgentToolCallsTrailer(agentName, toolsResult)
          : '';
      return { response: toolsResult.text, trailer };
    }
    return { response: '', trailer: '' };
  } catch (err) {
    logger.warn('Agent tools runtime falhou — caindo no fluxo padrão', {
      error: err instanceof Error ? err : undefined,
      context: { demandId, agentName },
    });
    return { response: '', trailer: '' };
  }
}
