/**
 * Demanda 10037 — artefatos pós-refinamento.
 *
 * A geração é SÍNCRONA: por ADR-0002 o servidor só extrai processos, mascara
 * PII e valida ~1 KB de texto Mermaid — a renderização acontece no cliente.
 * Por isso não há `jobId`, `document_jobs` nem evento de WebSocket aqui.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { paramIdSchema, ARTIFACT_TYPES, type DocumentType } from '@shared/schema';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { demandRepository } from '../repositories/demand-repository';
import { artifactStore } from '../services/artifact-store';
import { ArtifactGenerationError, generateFlowchart } from '../services/artifact-flowchart';
import { documentVersioningService } from '../services/document-versioning';
import { loadDocumentContent } from './demands-utils';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Schema plano (id + type), não aninhado: `validateRequest` só usa o formato
 * `{body, query, params}` quando o schema declara essas chaves; caso contrário
 * mescla os três em um objeto só (`validate-request.ts:9-22`).
 */
const generateArtifactSchema = paramIdSchema.extend({
  type: z.enum(ARTIFACT_TYPES),
});

const REFINEMENT_DOC_ORDER: DocumentType[] = ['tasks', 'prd', 'tdd'];

const REFINEMENT_EMPTY_MESSAGE = 'Geração indisponível: aguarde a conclusão do refinamento.';

/**
 * Carrega o conteúdo Markdown do refinamento.
 *
 * Se a demanda tem `documentVersions` (salvo pelo fluxo de refinamento atual),
 * usa `documentVersioningService.load` — resolve a divergência entre PDF e
 * markdown versionado. Caso contrário, recorre a `loadDocumentContent` a partir
 * de `prdUrl`/`tasksUrl`/`tddUrl` (retrocompat com demandas legadas e mocks).
 *
 * Ordem: tasks primeiro (passos explícitos), depois PRD e TDD.
 */
async function resolveRefinementMarkdown(
  demandId: number,
  demand: {
    prdUrl: string | null;
    tasksUrl: string | null;
    tddUrl: string | null;
    documentVersions: unknown;
  },
): Promise<string> {
  if (demand.documentVersions) {
    for (const type of REFINEMENT_DOC_ORDER) {
      try {
        const loaded = await documentVersioningService.load(demandId, type);
        if (loaded.content && loaded.content.trim().length > 0) {
          return loaded.content;
        }
      } catch (err) {
        logger.warn('artifacts: falha ao carregar documento de refinamento', {
          context: {
            demandId,
            type,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  for (const type of REFINEMENT_DOC_ORDER) {
    const content = loadDocumentContent(type, demand.prdUrl, demand.tasksUrl, demand.tddUrl);
    if (content && content.trim().length > 0) {
      return content;
    }
  }
  return '';
}

router.post(
  '/api/demands/:id/artifacts',
  validateRequest(generateArtifactSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.id);
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    const triggerTimestamp = Date.now();
    logger.info('artifacts: trigger de geração recebido', {
      context: {
        demandId,
        triggerTimestamp,
        prdUrl: demand.prdUrl,
        tasksUrl: demand.tasksUrl,
        tddUrl: demand.tddUrl,
        documentVersions: demand.documentVersions,
      },
    });

    const markdown = await resolveRefinementMarkdown(demandId, demand);

    if (!markdown || markdown.trim().length === 0) {
      logger.warn('artifacts: refinamento vazio ao gerar artefato', {
        context: {
          demandId,
          triggerTimestamp,
          elapsedMs: Date.now() - triggerTimestamp,
          prdUrl: demand.prdUrl,
          tasksUrl: demand.tasksUrl,
          tddUrl: demand.tddUrl,
          documentVersions: demand.documentVersions,
        },
      });
      throw new ValidationError(REFINEMENT_EMPTY_MESSAGE, [
        { path: 'refinement', message: REFINEMENT_EMPTY_MESSAGE },
      ]);
    }

    try {
      const { source, nodeCount, truncated } = generateFlowchart(markdown);
      const artifact = await artifactStore.create({ demandId, type: 'flowchart', source });

      logger.info('artifacts: fluxograma gerado', {
        context: {
          demandId,
          artifactId: artifact.id,
          nodeCount,
          truncated,
          elapsedMs: Date.now() - triggerTimestamp,
        },
      });

      res.status(201).json({ ...artifact, nodeCount, truncated });
    } catch (error) {
      if (error instanceof ArtifactGenerationError) {
        const message = error.code === 'empty_input' ? REFINEMENT_EMPTY_MESSAGE : error.message;
        throw new ValidationError(message, [{ path: 'refinement', message }]);
      }
      throw error;
    }
  }),
);

router.get(
  '/api/demands/:id/artifacts',
  validateRequest(paramIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.id);
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    res.json({ artifacts: await artifactStore.listByDemand(demandId) });
  }),
);

export default router;
