/**
 * Spec "Ajustes claude" F2 — parecer SÍNCRONO e OPCIONAL do TechLead sobre a
 * atuação de uma execução específica do agente Claude.
 *
 * Endpoint chama `requestTechLeadReview(jobId)`:
 *  - 404 quando a execução do Claude não existe;
 *  - 5xx quando o LLM falha (o chamador traduz).
 *
 * O caráter "não bloqueia o fluxo de relatório" (critério F2) é garantido no
 * front: o botão de parecer é independente do de relatório; uma falha aqui não
 * impede gerar o relatório. Este módulo apenas reporta o erro com clareza.
 */
import { agentJobsService, type AgentJob } from './agent-jobs';
import { openAIService } from './openai-ai';
import { AgentFactory } from './ai-squad/AgentFactory';
import { logger } from '../utils/logger';
import { NotFoundError } from '../middleware/error-handler';
import type { TechLeadReview } from '@shared/tech-lead-review';
import type { AgentJobStep } from '@shared/agent-job';

const FALLBACK_TECH_LEAD_PROMPT =
  'Você é o Tech Lead do time. Avalie criticamente a atuação de um agente de código ' +
  '(Claude) numa demanda: qualidade técnica, riscos, cobertura de testes e aderência ao ' +
  'escopo. Seja objetivo e acionável. Responda em markdown, com seções curtas: ' +
  '**Resumo**, **Pontos fortes**, **Riscos**, **Recomendação** (aprovar / ajustar / rejeitar).';

const MAX_STEPS_IN_PROMPT = 40;
const MAX_FILES_IN_PROMPT = 40;

function renderStep(step: AgentJobStep): string {
  const detail = step.detail?.trim() ? ` — ${step.detail.trim()}` : '';
  return `- [${step.kind}] ${step.label}${detail}`;
}

/** Monta o prompt de usuário exclusivamente com a execução do Claude avaliada. */
function buildUserPrompt(job: AgentJob): string {
  const steps = job.steps.slice(0, MAX_STEPS_IN_PROMPT).map(renderStep).join('\n');
  const files = job.filesModified.slice(0, MAX_FILES_IN_PROMPT).join('\n');
  const typecheck =
    job.typecheckPassed === null ? 'não medido' : job.typecheckPassed ? 'ok' : 'falhou';

  return [
    '# Atuação do agente Claude (a avaliar)',
    `- execução: ${job.id}`,
    `- status: ${job.status}`,
    `- typecheck: ${typecheck}`,
    `- arquivos modificados: ${job.filesModified.length}`,
    job.errorMessage ? `- erro: ${job.errorMessage}` : '',
    '',
    '## Passos',
    steps || '(sem passos registrados)',
    '',
    '## Arquivos',
    files || '(nenhum)',
    '',
    'Produza o parecer do Tech Lead conforme instruído no system prompt.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

interface TechLeadConfig {
  systemPrompt: string;
  model?: string;
  modelFallback?: string;
  temperature: number;
  maxTokens: number;
}

/** Carrega a persona real do Tech Lead (YAML); degrada para um prompt padrão. */
function loadTechLeadConfig(): TechLeadConfig {
  try {
    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const config = agentConfigs['tech_lead'];
    if (config?.system_prompt) {
      return {
        systemPrompt: config.system_prompt,
        model: config.model,
        modelFallback: config.model_fallback,
        temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
        maxTokens: typeof config.max_tokens === 'number' ? config.max_tokens : 1200,
      };
    }
  } catch (error) {
    logger.warn('F2: falha ao carregar config do tech_lead — usando prompt padrão', {
      error: error instanceof Error ? error : undefined,
    });
  }
  return { systemPrompt: FALLBACK_TECH_LEAD_PROMPT, temperature: 0.3, maxTokens: 1200 };
}

/**
 * Solicita, de forma síncrona, o parecer do TechLead sobre uma execução
 * específica do Claude. Lança `NotFoundError` (404) se o job não existe e
 * propaga a falha do LLM (5xx) para o chamador.
 */
export async function requestTechLeadReview(jobId: string): Promise<TechLeadReview> {
  const job = await agentJobsService.findById(jobId);
  if (!job) {
    throw new NotFoundError('Agent job', jobId);
  }

  const config = loadTechLeadConfig();
  const userPrompt = buildUserPrompt(job);

  const result = await openAIService.generateChatCompletionWithMetadata(
    config.systemPrompt,
    userPrompt,
    {
      agentName: 'tech_lead',
      operation: 'tech_lead_review',
      demandId: job.demandId,
      model: config.model,
      modelFallback: config.modelFallback,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      // Demanda 10086: o parecer analisa a saída de um job do próprio agente
      // (conteúdo interno, não input adversarial de terceiro) — mesma convenção
      // de document-generator.ts / roundtable-orchestrator.ts. Sem isto, um soluço
      // transitório do classificador semântico (JSON malformado/timeout) derrubava
      // o parecer inteiro com "Guardrail pipeline unavailable", surfaçado como 502.
      failOpenOnError: true,
    },
  );

  const parecer = result.content?.trim();
  if (!parecer) {
    throw new Error('O parecer do TechLead veio vazio.');
  }

  const model = result.metadata?.modelUsed ?? config.model ?? null;
  logger.info('F2: parecer do TechLead gerado', {
    context: { demandId: job.demandId, jobId: job.id, model },
  });

  return {
    demandId: job.demandId,
    jobId: job.id,
    parecer,
    model,
    generatedAt: new Date().toISOString(),
  };
}
