import { projectRoot } from '@shared/utils/paths';
import { Router, Request, Response, NextFunction } from 'express';
import { toNext } from '../middleware/result-to-express';
import { getPrdContent } from '../services/governance-service';
import { z } from 'zod';
import {
  asyncHandler,
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { paramIdSchema, type Demand } from '@shared/schema';
import { demandStatusSchema, type DemandStatus } from '@shared/demand-status';
import type { CostBreakdownResponse } from '@shared/cost-breakdown';
import path from 'path';
import { demandClassifier, agentOrchestrator } from '../cognitive-core';
import { frameworkManager, FrameworkDomainError } from '../frameworks';
import { canOverride, getUserContext } from '../middleware/auth-stub';
import { DemandService } from '../services/demand-service';
import { aiSquadService } from '../services/ai-squad';
import { featureFlags } from '../services/feature-flags';
import { failureReasonSchema, FAILURE_CATEGORIES } from '@shared/failure-category';
import { reformulateDemand } from '../services/demand-reformulation';
import { reformulateRequestSchema } from '@shared/reformulation';
import { llmAuditLogService } from '../services/llm-audit-log';
import { aggregateDemandCosts } from '../services/demand-cost-aggregator';
import { modelRoutingService } from '../services/model-routing';
import { buildHandoffFiles } from '../services/handoff-bundle';
import { validateSpeckitManifest } from '@shared/handoff-manifest';
import { enqueueCodeAgentJob } from '../workers/code-agent-worker';
import { sseManager } from '../services/sse';
import { webSocketOriginPolicy } from '../services/websocket/origin-policy';
import { logger } from '../utils/logger';
import { buildRepoFullName } from '../utils/repo-context';
import {
  upload,
  enforceUploadBudget,
  uploadErrorHandler,
  cleanupUploadedFiles,
  toDemandCreationError,
  isPdfBytesAsText,
  toSseSafeDemand,
  toRestSafeDemand,
  parseInsertDemand,
} from './shared';
import { toDemandListItems } from './demand-presenter';
import { toDemandMetadata } from '@shared/demand-metadata';
import type { AgentJobView } from '@shared/agent-job';
import { agentJobsService } from '../services/agent-jobs';
import { requestTechLeadReview } from '../services/tech-lead-review';
import { openMergeRequest } from '../services/merge-to-main';
import { mergeToMainRequestSchema } from '@shared/merge-to-main';
import { loadDocumentContent } from './demands-utils';
import { docuMenteExportService } from '../services/docusmente-export';
import { recordClassifierSubmission } from '../services/classifier-observability';
// (Add other necessary imports here)

const router = Router();

// Spec 10020 US1 / 10028: reformulação assistida — reescreve um rascunho, consulta
// o RAG do repositório e extrai contratos + título (validados por Zod). Rota
// literal declarada antes das rotas `:id`. Payload legado (`{ draft }` apenas)
// continua funcional — os demais campos são opcionais (FR-003/retrocompat).
router.post(
  '/api/demands/reformulate',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = reformulateRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Payload de reformulação inválido', [
        { path: parsed.error.issues[0]?.path.join('.') ?? 'draft', message: 'Payload inválido' },
      ]);
    }
    const result = await reformulateDemand(parsed.data);
    res.json(result);
  }),
);

router.get(
  '/api/demands/:id/model-routing',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const stageRuns = await modelRoutingService.getDemandStageRuns(id, demand.executionId);
    res.json({
      demandId: id,
      executionId: demand.executionId,
      stageRuns,
    });
  }),
);

router.get(
  '/api/demands/:id/costs',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Spec 10056: fonte DURÁVEL (llm_audit_logs), não o tracker em memória —
    // que subcontava ~10× após restart/eviction do ring buffer de 1000.
    const usage = await llmAuditLogService.getDemandUsage(id);

    // Spec 008 / US4: parsing centralizado dos rótulos de operation — reconhece
    // todas as variantes de agente (agent_interaction:, agent:, agent_execution:,
    // roundtable:) e declara o resto em `unattributed` em vez de sumir em silêncio.
    const { byAgent, byTool, byModel, unattributed } = aggregateDemandCosts(usage.records);

    // Contrato compartilhado com o frontend — spec 014 S2 / H-09.
    const payload: CostBreakdownResponse = {
      demandId: id,
      totalCost: usage.totalCost,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      totalRecords: usage.records.length,
      byAgent,
      byTool,
      byModel,
      unattributed,
      unpriced: { count: usage.unpricedCount, tokens: usage.unpricedTokens },
    };
    res.json(payload);
  }),
);

// Spec 10064 (Batch 1): metadados curados da demanda para o front. Projeção
// enxuta e tipada — não vaza chatMessages/documentVersions/blobs pesados.
router.get(
  '/api/demands/:id/metadata',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }
    res.json(toDemandMetadata(demand));
  }),
);

// Spec 10064 (Batch 2): passo a passo da atuação do agente de código por demanda.
router.get(
  '/api/demands/:id/agent-jobs',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const jobs = await agentJobsService.listForDemand(id);
    // Projeção: não vaza o prompt_sent_hash interno.
    const view: AgentJobView[] = jobs.map((job) => ({
      id: job.id,
      demandId: job.demandId,
      speckitPath: job.speckitPath,
      status: job.status,
      filesModified: job.filesModified,
      typecheckPassed: job.typecheckPassed,
      apiCostUsd: job.apiCostUsd,
      humanEditsCount: job.humanEditsCount,
      cancelledAt: job.cancelledAt,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      steps: job.steps,
    }));
    res.json(view);
  }),
);

// Spec "Ajustes claude" F2: parecer síncrono e OPCIONAL do TechLead sobre a
// execução específica do agente Claude. Falha aqui não bloqueia o fluxo de relatório
// (o front trata os botões de forma independente).
router.post(
  '/api/agent-jobs/:jobId/tech-lead-review',
  asyncHandler(async (req: Request, res: Response) => {
    const jobId = req.params.jobId;
    try {
      const review = await requestTechLeadReview(jobId);
      res.json(review);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('F2: falha ao gerar parecer do TechLead', {
        error: error instanceof Error ? error : undefined,
        context: { jobId },
      });
      throw new AppError(
        'Não foi possível gerar o parecer do TechLead. Tente novamente.',
        502,
        'TECH_LEAD_REVIEW_FAILED',
      );
    }
  }),
);

// Spec "Ajustes claude" F3: abre um PULL REQUEST da branch de trabalho para a
// main (NUNCA merge/push direto). Idempotente por operationId; pré-condições
// (404/422) lançam; falhas na escrita retornam state 'failed' + rollback.
router.post(
  '/api/demands/:id/merge-to-main',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const parsed = mergeToMainRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Payload de merge inválido', [
        { path: 'operationId', message: 'operationId é obrigatório' },
      ]);
    }
    const result = await openMergeRequest(id, parsed.data.operationId);
    res.json(result);
  }),
);

router.get(
  '/api/demands',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const demands = await DemandService.findAll();
    res.json(toDemandListItems(demands));
  }),
);

router.delete(
  '/api/demands/history',
  asyncHandler(async (_req: Request, res: Response) => {
    const demands = await DemandService.findAll();
    const activeDemands = demands.filter((demand) => aiSquadService.isProcessingActive(demand.id));

    if (activeDemands.length > 0) {
      throw new AppError('Cannot clear history while demands are processing', 409, 'CONFLICT', {
        activeDemandIds: activeDemands.map((demand) => demand.id),
      });
    }

    const result = await DemandService.clearHistory();
    res.json({ success: true, ...result });
  }),
);

// Spec 10013 (FR-004): exclusão individual de uma demanda do histórico.
router.delete(
  '/api/demands/:id',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    if (aiSquadService.isProcessingActive(id)) {
      throw new AppError('Cannot delete a demand while it is processing', 409, 'CONFLICT', {
        demandId: id,
      });
    }
    const removed = await DemandService.deleteById(id);
    if (!removed) {
      throw new NotFoundError('Demand', id);
    }
    res.json({ success: true, demandId: id });
  }),
);

router.get(
  '/api/demands/:id/classification',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Classify the demand using cognitive core
    const classification = await demandClassifier.classifyDemand(demand);

    res.json({
      demandId: id,
      classification: classification,
    });
  }),
);

router.get(
  '/api/demands/:id',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }
    // H-18: project to safe fields — exclude internal-only fields (snapshot
    // hashes, approval session internals, cost telemetry, learning log) that
    // no client code reads but could leak internal state.
    res.json(toRestSafeDemand(demand));
  }),
);

router.post(
  '/api/demands',
  upload.array('files'),
  uploadErrorHandler(),
  enforceUploadBudget(),
  asyncHandler(async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) || [];
    try {
      const {
        task_type: _taskType,
        additionalRepos: additionalReposRaw,
        githubRepoOwner,
        githubRepoName,
        repo_url,
        skillRawUrl,
        roundtableAgentIds: roundtableAgentIdsRaw,
        maxRounds: maxRoundsRaw,
        refinementLevel: refinementLevelRaw,
        demandStartContractPayload,
        demandStartContract,
        ...demandData
      } = parseInsertDemand(req.body);
      recordClassifierSubmission({
        title: demandData.title,
        description: demandData.description,
        selectedType: demandData.type,
        requestId:
          typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
      });

      // Demanda 10089 (item 1): gate técnico opt-in — bloqueia demanda sem
      // repositório vinculado. Default OFF (flag enforceRepoUrlOnDemands), então
      // não altera o fluxo atual até ser ligado deliberadamente. Sem esforço
      // retroativo: só afeta novas demandas neste endpoint.
      const resolvedRepoFullName = buildRepoFullName(githubRepoOwner, githubRepoName);
      if (
        featureFlags.getFlags().enforceRepoUrlOnDemands &&
        !resolvedRepoFullName &&
        !(typeof repo_url === 'string' && repo_url.trim())
      ) {
        res.status(400).json({
          error: 'Repositório vinculado é obrigatório (repo_url ausente).',
          code: 'REPO_URL_REQUIRED',
        });
        return;
      }

      // Spec 10179: enriquecimento e despacho são responsabilidade do
      // DemandService; a rota permanece como transporte puro.
      const enriched = await DemandService.enrich({
        title: demandData.title,
        description: demandData.description,
        type: demandData.type,
        priority: demandData.priority,
        domain: demandData.domain,
        refinementType: demandData.refinementType,
        githubRepoOwner,
        githubRepoName,
        additionalRepos: additionalReposRaw,
        skillRawUrl,
        origin: demandData.origin,
        originMetadata: demandData.originMetadata,
        roundtableAgentIds: roundtableAgentIdsRaw,
        maxRounds: maxRoundsRaw,
        refinementLevel: refinementLevelRaw,
        demandStartContractPayload,
        demandStartContract,
        files,
        // Spec 10015: repassa goLiveMode validado pelo Zod para o service.
        goLiveMode: demandData.goLiveMode === true,
      });

      const demand = await DemandService.create(enriched.createInput);
      const { generationJobId } = await DemandService.dispatch(
        demand.id,
        enriched.generationConfig,
      );

      res.status(201).json({
        ...demand,
        generationJobId,
        refinementInputSource: enriched.refinementMetadata.refinementInputSource,
        documentTextLength: enriched.refinementMetadata.documentTextLength,
        ideaTextLength: enriched.refinementMetadata.ideaTextLength,
      });
    } catch (error) {
      cleanupUploadedFiles(files);
      throw toDemandCreationError(error);
    }
  }),
);

/**
 * Spec 10044 — disparo MANUAL do agente de código (Claude Code) para uma demanda.
 *
 * O botão "Enviar ao Claude" no front é o consentimento explícito, então este
 * endpoint NÃO depende de `AGENT_AUTORUN_ENABLED` (que gateia apenas o disparo
 * automático). Constrói o handoff, valida o manifest e enfileira o job — o
 * worker executa em background e registra o resultado em `agent_jobs`.
 */
router.post(
  '/api/demands/:id/send-to-claude',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Gera o handoff (lança 422 se não houver PRD válido — guard da 018).
    const { files, manifest } = await buildHandoffFiles(id);
    const specPath = `specs/${id}-handoff/spec.md`;
    const spec = files.find((f) => f.path === specPath);
    if (!spec) {
      throw new AppError('spec.md ausente no handoff', 422, 'HANDOFF_SPEC_MISSING', {
        demandId: id,
      });
    }

    const validation = validateSpeckitManifest(manifest);
    if (!validation.success) {
      throw new AppError('Manifest do speckit inválido', 422, 'HANDOFF_MANIFEST_INVALID', {
        demandId: id,
        errors: validation.errors,
      });
    }

    enqueueCodeAgentJob({ demandId: id, speckitPath: specPath, prompt: spec.content });
    logger.info('Agente de código enfileirado manualmente (send-to-claude)', {
      context: { demandId: id, specPath },
    });

    res.status(202).json({ enqueued: true, demandId: id, speckitPath: specPath });
  }),
);

router.get(
  '/api/demands/:id/orchestration',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Create orchestration plan using cognitive core
    const orchestrationPlan = await agentOrchestrator.createOrchestrationPlan(id);

    res.json({
      demandId: id,
      orchestrationPlan: orchestrationPlan,
    });
  }),
);

router.get(
  '/api/demands/:id/framework-recommendation',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Get AI-powered framework recommendation
    const recommendation = await frameworkManager.recommendFramework(demand);

    res.json({
      demandId: id,
      recommendation: recommendation,
    });
  }),
);

router.post(
  '/api/demands/:id/frameworks/:frameworkId/execute',
  validateRequest(
    z.object({
      params: z.object({ id: z.coerce.number().positive(), frameworkId: z.string().min(1) }),
    }),
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.id);
    const frameworkId = req.params.frameworkId;
    const demand = await DemandService.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    // Execute the framework
    let executionResult;
    try {
      executionResult = await frameworkManager.executeFramework(
        demandId,
        frameworkId,
        (progress: number, message: string) => {
          logger.debug(`Progresso de execução do framework`, { context: { progress, message } });
        },
      );
    } catch (error) {
      // Spec 013 (US2-AS3): erro de domínio estável, não falha genérica.
      if (error instanceof FrameworkDomainError) {
        throw new NotFoundError('Framework', frameworkId);
      }
      throw error;
    }

    res.json({
      success: true,
      executionResult: executionResult,
    });
  }),
);

router.get(
  '/api/demands/:id/framework-executions',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const history = await frameworkManager.getExecutionHistoryAsync(id);

    res.json({
      demandId: id,
      executionCount: history.length,
      executions: history,
    });
  }),
);

router.get(
  '/api/demands/:id/messages',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }
    res.json(demand.chatMessages || []);
  }),
);

router.get(
  '/api/demands/:id/export/json',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);

    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const exportData = {
      demandId: demand.id,
      title: demand.title,
      description: demand.description,
      type: demand.type,
      priority: demand.priority,
      status: demand.status,
      createdAt: demand.createdAt,
      updatedAt: demand.updatedAt,
      chatHistory: demand.chatMessages || [],
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dialogo_demanda_${id}_${Date.now()}.json"`,
    );
    res.json(exportData);
  }),
);

router.get(
  '/api/demands/:id/export/txt',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);

    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const agentNames: Record<string, string> = {
      product_owner: 'Product Owner',
      scrum_master: 'Scrum Master',
      qa: 'QA',
      ux: 'UX Designer',
      analista_de_dados: 'Analista de Dados',
      tech_lead: 'Tech Lead',
      pm: 'Product Manager',
    };

    let txtContent = `HISTÓRICO DE DIÁLOGO - DEMANDA #${demand.id}\n`;
    txtContent += `${'='.repeat(60)}\n\n`;
    txtContent += `Título: ${demand.title}\n`;
    txtContent += `Tipo: ${demand.type}\n`;
    txtContent += `Prioridade: ${demand.priority}\n`;
    txtContent += `Status: ${demand.status}\n`;
    txtContent += `Criado em: ${demand.createdAt}\n`;
    txtContent += `\nDescrição:\n${demand.description}\n\n`;
    txtContent += `${'='.repeat(60)}\n`;
    txtContent += `MENSAGENS DO CHAT\n`;
    txtContent += `${'='.repeat(60)}\n\n`;

    const messages = demand.chatMessages || [];
    messages.forEach((message, index) => {
      const agentName = agentNames[message.agent] || message.agent;
      const timestamp = new Date(message.timestamp).toLocaleString('pt-BR');
      const status =
        message.type === 'completed' ? '✓' : message.type === 'processing' ? '⏳' : '✗';

      txtContent += `[${index + 1}] ${agentName} ${status}\n`;
      txtContent += `Data/Hora: ${timestamp}\n`;
      txtContent += `${'-'.repeat(60)}\n`;
      txtContent += `${message.message}\n\n`;
    });

    txtContent += `${'='.repeat(60)}\n`;
    txtContent += `FIM DO HISTÓRICO\n`;
    txtContent += `Exportado em: ${new Date().toLocaleString('pt-BR')}\n`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dialogo_demanda_${id}_${Date.now()}.txt"`,
    );
    res.send(txtContent);
  }),
);

// Spec 018: handoff export bundle — zip no layout spec-kit consumível por
// coding agents. Contrato: specs/018-handoff-export-bundle/contracts/export-bundle.md
router.get(
  '/api/demands/:id/export/bundle',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const { buildHandoffBundle } = await import('../services/handoff-bundle');
    const { handoffBundleTotal, handoffBundleFailureTotal } = await import('../metrics');

    try {
      const { buffer, filename, manifest } = await buildHandoffBundle(id);
      handoffBundleTotal.inc();
      logger.info('Handoff bundle exported', {
        context: {
          demandId: id,
          documents: manifest.documents.length,
          eventType: 'handoff_export',
        },
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      const reason =
        err instanceof NotFoundError
          ? 'not_found'
          : err instanceof AppError && err.errorCode === 'HANDOFF_PRD_MISSING'
            ? 'prd_missing'
            : 'internal';
      handoffBundleFailureTotal.labels({ reason }).inc();
      throw err;
    }
  }),
);

// Spec 10006: metadados do handoff (só o manifest, sem o zip) para a tela do
// AiChatFlow contextualizar. Forma simplificada, sem hashes/URLs internas.
router.get(
  '/api/demands/:id/export/bundle/manifest',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const { buildHandoffFiles } = await import('../services/handoff-bundle');
    const { toHandoffMetadata } = await import('@shared/handoff-manifest');

    const { manifest } = await buildHandoffFiles(id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(toHandoffMetadata(manifest));
  }),
);

// Spec 026: commitar o handoff (spec-kit) DENTRO do repositório destino da
// demanda. Escrita real via caminho da spec 024 (exige GITHUB_WRITE_TOKEN).
router.post(
  '/api/demands/:id/export/github',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const { commitHandoffToRepo } = await import('../services/handoff-commit');

    const result = await commitHandoffToRepo(id);
    logger.info('Handoff committed to target repo', {
      context: {
        demandId: id,
        repo: `${result.owner}/${result.repo}`,
        commit: result.sha,
        files: result.fileCount,
        eventType: 'handoff_commit',
      },
    });
    res.json({
      demandId: id,
      repo: `${result.owner}/${result.repo}`,
      branch: result.branch,
      commitSha: result.sha,
      treeSha: result.treeSha,
      fileCount: result.fileCount,
    });
  }),
);

const documentTypeSchema = z.object({
  params: z.object({
    id: z.coerce.number().positive(),
    type: z.enum(['prd', 'tasks', 'tdd']),
  }),
  body: z.object({
    content: z.string(),
    // Bug 4: opcional na validação. Ausente num documento existente vira 412
    // (Precondition Failed) no serviço, não 400 (parâmetro incorreto).
    ifMatchVersion: z.number().int().nonnegative().optional(),
    force: z.boolean().optional().default(false),
  }),
});

router.post(
  '/api/demands/:id/documents/:type',
  validateRequest(documentTypeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const type = req.params.type as 'prd' | 'tasks' | 'tdd';

    const payload = req.body;

    logger.info('Document save attempted', {
      context: {
        demandId: id,
        type,
        ifMatchVersion: payload.ifMatchVersion,
        force: payload.force,
        eventType: 'document_save_attempted',
      },
    });

    const { documentVersioningService } = await import('../services/document-versioning');
    const result = await documentVersioningService.save(
      id,
      type,
      payload.content,
      payload.ifMatchVersion,
      payload.force,
    );

    // Trigger PDF regeneration after saving markdown
    const demand = await DemandService.findByIdOrNull(id);
    let pdfJobId: string | null = null;
    if (demand) {
      const urlPath =
        type === 'prd' ? demand.prdUrl : type === 'tdd' ? demand.tddUrl : demand.tasksUrl;
      if (urlPath) {
        const filename = urlPath.split('/').pop() || '';
        const pdfFilepath = path.join(projectRoot, 'documents', filename);
        // Spec 015 B2 (H-10): job durável persistido ANTES da resposta —
        // um crash entre a resposta e o worker não perde a regeneração.
        const { documentJobsService } = await import('../services/document-jobs');
        pdfJobId = await documentJobsService.enqueue(
          id,
          type === 'tasks' ? 'Tasks' : type.toUpperCase(),
          pdfFilepath,
        );
        const { eventBus } = await import('../events/event-bus');
        eventBus.publish('DOCUMENT_GENERATION_REQUESTED', {
          demandId: id,
          type: type === 'tasks' ? 'Tasks' : type.toUpperCase(),
          content: payload.content,
          targetFilepath: pdfFilepath,
          jobId: pdfJobId,
        });
        logger.info('PDF regeneration triggered after document edit', {
          context: { demandId: id, type, filename, jobId: pdfJobId },
        });
      }
    }

    res.json({ ...result, pdfJobId });
  }),
);

const revertDocumentSchema = z.object({
  params: z.object({
    id: z.coerce.number().positive(),
    type: z.enum(['prd', 'tasks', 'tdd']),
  }),
});

router.post(
  '/api/demands/:id/documents/:type/revert',
  validateRequest(revertDocumentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const type = req.params.type as 'prd' | 'tasks' | 'tdd';
    const { documentVersioningService } = await import('../services/document-versioning');
    const result = await documentVersioningService.revert(id, type);
    res.json(result);
  }),
);

router.get(
  '/api/demands/:id/documents/:type',
  validateRequest(revertDocumentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const type = req.params.type as 'prd' | 'tasks' | 'tdd';

    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    // Use new versioning service (handles legacy fallback by file prefix)
    const { documentVersioningService } = await import('../services/document-versioning');
    const result = await documentVersioningService.load(id, type);

    // Legacy fallback: if no content found via versioning service, try prdUrl/tasksUrl
    let content = result.content;
    if (content && isPdfBytesAsText(content)) {
      logger.warn(
        'Document endpoint received PDF bytes as editable content; using legacy markdown fallback',
        {
          context: { demandId: id, type },
        },
      );
      content = '';
    }

    if (!content) {
      const fileContent = loadDocumentContent(type, demand.prdUrl, demand.tasksUrl, demand.tddUrl);
      if (fileContent && !isPdfBytesAsText(fileContent)) {
        content = fileContent;
      }
    }

    logger.debug('Document loaded', {
      context: { demandId: id, type, version: result.version, eventType: 'document_load' },
    });

    // Spec 015 B2 (US2-AS3): frescor do PDF visível — nunca apresentar um
    // PDF antigo como atualizado após falha permanente do worker.
    const { documentJobsService } = await import('../services/document-jobs');
    const latestJob = await documentJobsService
      .latestFor(id, type === 'tasks' ? 'Tasks' : type.toUpperCase())
      .catch((err) => {
        // CRIT-18: log em vez de engolir silenciosamente.
        logger.warn('Failed to fetch latest document job', {
          error: err instanceof Error ? err : undefined,
          context: { demandId: id, type },
        });
        return null;
      });

    res.json({
      demandId: id,
      type,
      content,
      version: result.version,
      hash: result.hash,
      updatedAt: result.updatedAt,
      hasPreviousVersion: result.hasPreviousVersion,
      pdfJob: latestJob ? { status: latestJob.status, updatedAt: latestJob.updatedAt } : null,
    });
  }),
);

const learningLogEntrySchema = z.object({
  params: paramIdSchema,
  body: z.object({
    entry: z.string().trim().min(1, 'Learning log não pode ser vazio'),
  }),
});

const updateDemandStatusSchema = z.object({
  params: paramIdSchema,
  body: z.object({
    status: demandStatusSchema,
    learningLog: z.string().trim().min(1).optional(),
    qaEvidence: z.string().trim().min(1).optional(),
    failureCategory: z.string().optional(),
    otherDetail: z.string().trim().min(1).optional(),
  }),
});

router.post(
  '/api/demands/:id/stop',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);

    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    if (demand.status !== 'processing') {
      throw new ValidationError('Demand is not being processed');
    }

    // Demanda 10089 (item 2): parar é uma transição para `stopped` — exige causa
    // técnica para não repetir o padrão de demandas paradas sem diagnóstico.
    // Opt-in por flag: sem ela, o comportamento atual é preservado.
    if (featureFlags.getFlags().enforceFailureCategory) {
      const parsed = failureReasonSchema.safeParse({
        failureCategory: req.body?.failureCategory,
        otherDetail: req.body?.otherDetail,
      });
      if (!parsed.success) {
        res.status(400).json({
          error: 'Causa técnica obrigatória ao parar a demanda.',
          code: 'FAILURE_CATEGORY_REQUIRED',
          categories: FAILURE_CATEGORIES,
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      logger.info('Demanda parada com causa técnica', {
        context: {
          demandId: id,
          failureCategory: parsed.data.failureCategory,
          hasOtherDetail: !!parsed.data.otherDetail,
        },
      });
    }

    await aiSquadService.stopProcessing(id);
    const updatedDemand = await DemandService.findByIdOrNull(id);
    res.json({ message: 'Stop request sent', demand: updatedDemand });
  }),
);

/**
 * Demanda 10089 (item 3): anexar uma linha ao learning_log da demanda.
 * Endpoint independente do fechamento, para que o time possa registrar
 * aprendizados antes ou depois da conclusão sem depender de PATCH de status.
 */
router.post(
  '/api/demands/:id/learning-log',
  validateRequest(learningLogEntrySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const entry = req.body.entry as string;
    const updatedDemand = await DemandService.addLearningLog(id, entry);
    const updated = Array.isArray(updatedDemand.learningLog) ? updatedDemand.learningLog : [];
    res.json({ demandId: id, added: entry, learningLog: updated });
  }),
);

/**
 * Demanda 10089 (itens 2, 3, 4): endpoint genérico de transição de status.
 *
 * Como o fluxo principal completa a demanda automaticamente em `ai-squad.ts`,
 * este endpoint é o ponto manual de fechamento para cenários em que o time
 * deseja enforcear learning log, causa técnica e evidência QA.
 */
router.patch(
  '/api/demands/:id/status',
  validateRequest(updateDemandStatusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await DemandService.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const { status, learningLog, qaEvidence, failureCategory, otherDetail } = req.body as {
      status: string;
      learningLog?: string;
      qaEvidence?: string;
      failureCategory?: string;
      otherDetail?: string;
    };

    const flags = featureFlags.getFlags();

    // Item 2: causa técnica obrigatória para stopped/error.
    if ((status === 'stopped' || status === 'error') && flags.enforceFailureCategory) {
      const parsed = failureReasonSchema.safeParse({ failureCategory, otherDetail });
      if (!parsed.success) {
        res.status(400).json({
          error: 'Causa técnica obrigatória para stopped/error.',
          code: 'FAILURE_CATEGORY_REQUIRED',
          categories: FAILURE_CATEGORIES,
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
    }

    // Item 3: learning log obrigatório no fechamento completed.
    if (status === 'completed' && flags.enforceLearningLogOnComplete) {
      const hasExistingLog = Array.isArray(demand.learningLog) && demand.learningLog.length > 0;
      if (!learningLog && !hasExistingLog) {
        res.status(400).json({
          error: 'Learning log é obrigatório ao fechar a demanda como completed.',
          code: 'LEARNING_LOG_REQUIRED',
        });
        return;
      }
    }

    // Item 4: evidência QA obrigatória no fechamento completed.
    if (status === 'completed' && flags.enforceQaChecklistOnComplete) {
      if (!qaEvidence) {
        res.status(400).json({
          error: 'Evidência de QA é obrigatória ao fechar a demanda como completed.',
          code: 'QA_EVIDENCE_REQUIRED',
        });
        return;
      }
    }

    const updatedLearningLog = learningLog
      ? [...(Array.isArray(demand.learningLog) ? demand.learningLog : []), learningLog]
      : undefined;

    const updatedDemand = await DemandService.updateStatus(id, status as DemandStatus, {
      learningLog: updatedLearningLog,
      qaEvidence,
    });
    logger.info('Status da demanda atualizado manualmente', {
      context: { demandId: id, status, hasLearningLog: !!learningLog, hasQaEvidence: !!qaEvidence },
    });
    res.json({ demandId: id, status, demand: updatedDemand });
  }),
);

router.get(
  '/api/demands/:id/events',
  validateRequest(paramIdSchema),
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };

    // CRIT-7: `*` deixava qualquer site abrir um EventSource e ler dados de
    // processamento em tempo real (progresso, mensagens dos agentes, PRD).
    // O próprio frontend consome este endpoint com URL relativa (same-origin,
    // não precisa de CORS); só refletimos o header para uma origem que já
    // esteja na allowlist compartilhada com o WebSocket (mesma política de
    // "conexões long-lived" — Spec 012/H-05), nunca com wildcard.
    const origin = req.headers.origin;
    if (origin && webSocketOriginPolicy.decide(origin) === 'accept') {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }

    res.writeHead(200, headers);

    // Adiciona a conexão usando o novo sseManager
    const connectionId = sseManager.addConnection(id, res);

    // Enviar evento 'started' imediatamente (primeiro evento obrigatório)
    sseManager.sendStarted(id, { connectionId, message: 'SSE connection established' });

    // Enviar evento 'processing' antes do trabalho pesado
    sseManager.sendProcessing(id, { message: 'Starting demand processing' });

    // Enviar atualização inicial da demanda
    try {
      const demand = await DemandService.findByIdOrNull(id);
      if (demand) {
        // H-14: project to safe fields only — the full demand object
        // contains internal/sensitive fields (snapshot hashes, approval
        // session IDs, cost telemetry, learning log, etc.) that shouldn't
        // be sent over SSE to the client.
        sseManager.sendProgress(id, 10, {
          demand: toSseSafeDemand(demand as Demand),
          message: 'Initial demand state loaded',
        });
      }
    } catch (error) {
      logger.error('Erro inicial no SSE', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: id },
      });
      sseManager.sendError(id, 'INITIAL_ERROR', 'Failed to load initial demand state', false);
    }

    // As atualizações são enviadas via event bus e SSE manager. Não precisamos de polling aqui.

    req.on('close', () => {
      // Remover a conexão
      sseManager.removeConnection(id, connectionId);
    });
  },
);

router.post(
  '/api/demands/:id/max-effort-override',
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.id, 10);
    if (isNaN(demandId)) {
      throw new ValidationError('ID inválido', [{ path: 'id', message: 'ID deve ser um número' }]);
    }

    if (!canOverride(req)) {
      throw new ForbiddenError(
        'Apenas product_manager, tech_lead ou admin podem definir max_effort_override.',
      );
    }

    const effortOverrideSchema = z.object({
      dias: z.number().positive().max(365, 'dias deve ser um número positivo até 365.'),
      justification: z
        .string()
        .min(10, 'justification é obrigatória e deve ter pelo menos 10 caracteres.'),
    });

    const { dias, justification } = effortOverrideSchema.parse(req.body);
    const ctx = getUserContext(req);

    await DemandService.updateMaxEffortOverride(demandId, {
      maxEffortOverrideDias: dias,
      maxEffortOverrideBy: String(ctx.id),
      maxEffortOverrideJustification: justification.trim(),
    });
    logger.info('max_effort_override aplicado', {
      context: { demandId, dias, overrideBy: ctx.id, role: ctx.role },
    });
    res.json({ success: true, demandId, dias, overrideBy: ctx.id });
  }),
);

// ============================================================
// DOC-001: DocuMente export — traceable + idempotent server endpoint
// ============================================================

/**
 * POST /api/demands/:id/export-documente
 * Body: { docType: 'epic' | 'userstories', docuMenteUrl: string }
 *
 * Exports the demand's PRD to DocuMente. Idempotent: if a successful
 * export already exists for this (demand, docType, endpoint), returns
 * the existing external id/url without re-calling DocuMente.
 */
router.post(
  '/api/demands/:id/export-documente',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const demandId = Number(req.params.id);
    if (!Number.isFinite(demandId)) {
      throw new ValidationError('ID de demanda inválido');
    }
    const docType = req.body?.docType;
    if (docType !== 'epic' && docType !== 'userstories') {
      throw new ValidationError('docType deve ser "epic" ou "userstories"');
    }

    // Spec 011 (R-02/US3): o destino DocuMente é configuração do SERVIDOR —
    // request do cliente não escolhe para onde documento+credencial vão.
    // Qualquer URL enviada no corpo é ignorada (e registrada) por segurança.
    const { probeDocuMente } = await import('../services/documente-health');
    const destination = await probeDocuMente();
    if (!destination.online || !destination.url) {
      throw new ValidationError('Nenhum destino DocuMente configurado está online');
    }
    const clientProvidedUrl = req.body?.docuMenteUrl;
    if (
      typeof clientProvidedUrl === 'string' &&
      clientProvidedUrl.trim().replace(/\/$/, '') !== destination.url
    ) {
      logger.warn('docuMenteUrl do cliente ignorado — destino é controlado pelo servidor', {
        context: { demandId, requested: clientProvidedUrl.slice(0, 120), used: destination.url },
      });
    }

    // Fetch the PRD content
    const demand = await DemandService.findById(demandId);
    if (!demand) {
      throw new NotFoundError('Demanda não encontrada');
    }

    // H-29: replaced self-referential HTTP fetch (http://localhost:PORT/...)
    // with a direct function call. The hardcoded localhost URL broke in any
    // non-default deployment (Docker, reverse proxy, different host). Using
    // getPrdContent() directly avoids the network round-trip and the
    // hardcoded URL entirely.
    const prdContent = await getPrdContent(demand.prdUrl, demandId);
    if (!prdContent || prdContent.trim().length === 0) {
      throw new ValidationError('PRD vazio — não é possível exportar');
    }

    const result = await docuMenteExportService.export({
      demandId,
      title: `${demand.title} - ${docType === 'epic' ? 'Epic' : 'User Stories'}`,
      docType,
      prdContent,
      docuMenteUrl: destination.url,
    });

    // Spec 10125 #16: convert Result failure to HTTP error via toNext wrapper.
    if (!toNext(result, res, next, { defaultStatus: 502, operation: 'documente:export' })) {
      return;
    }

    res.json(result);
  }),
);

/**
 * GET /api/demands/:id/export-documente
 * Returns all DocuMente exports for this demand (traceability).
 */
router.get(
  '/api/demands/:id/export-documente',
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = Number(req.params.id);
    if (!Number.isFinite(demandId)) {
      throw new ValidationError('ID de demanda inválido');
    }
    const exports = await docuMenteExportService.listForDemand(demandId);
    res.json({ exports });
  }),
);

export default router;
