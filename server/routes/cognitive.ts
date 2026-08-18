import { Router, type Request, type Response } from 'express';
import { demandClassifier } from '../cognitive-core/demand-classifier';
import { demandRepository } from '../repositories/demand-repository';
import { REFINEMENT_ITEM_FEEDBACK_STATUSES } from '@shared/schema';
import { logger } from '../utils/logger';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/error-handler';

export const cognitiveRoutes = Router();

cognitiveRoutes.get(
  '/demands/:id/classification',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const demand = await demandRepository.findByIdOrNull(id);
    if (!demand) {
      throw new NotFoundError('Demand', id);
    }

    const classification = await demandClassifier.classifyDemand(demand);
    res.json({
      demandId: id,
      classification: classification,
    });
  }),
);

cognitiveRoutes.post(
  '/refinement/structured-feedback',
  asyncHandler(async (req: Request, res: Response) => {
    const {
      refinementId,
      agentId,
      nota,
      texto,
      modelo,
      qtdIteracoesAteFeedback,
      itemIndex,
      itemKey,
      versionHash,
      status,
    } = req.body;

    if (!refinementId || typeof refinementId !== 'string' || refinementId.trim() === '') {
      throw new ValidationError('refinementId é obrigatório.');
    }
    if (refinementId.length > 200) {
      throw new ValidationError('refinementId deve ter no máximo 200 caracteres.');
    }
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId é obrigatório.');
    }
    const hasNota = nota !== undefined && nota !== null;
    const hasStatus = status !== undefined && status !== null;
    if (!hasNota && !hasStatus) {
      throw new ValidationError('Informe nota ou status do item.');
    }
    if (hasNota && (!Number.isInteger(nota) || nota < 1 || nota > 5)) {
      throw new ValidationError('nota deve ser um inteiro entre 1 e 5 quando informada.');
    }

    const textoStr = texto !== undefined && texto !== null ? String(texto) : null;
    if (textoStr !== null && textoStr.length > 500) {
      throw new ValidationError('texto deve ter no máximo 500 caracteres.');
    }
    const textoSanitized = textoStr ? textoStr.replace(/<[^>]*>/g, '') : null;

    const { refinementFeedbackService } = await import('../services/refinement-feedback-service');

    if (hasStatus) {
      if (!REFINEMENT_ITEM_FEEDBACK_STATUSES.includes(status)) {
        throw new ValidationError('status de item inválido.');
      }
      if (!Number.isInteger(itemIndex) || itemIndex < 0) {
        throw new ValidationError('itemIndex deve ser um inteiro maior ou igual a zero.');
      }
      if (typeof itemKey !== 'string' || itemKey.trim().length === 0) {
        throw new ValidationError('itemKey é obrigatório para feedback por item.');
      }
      if (itemKey.length > 128) {
        throw new ValidationError('itemKey deve ter no máximo 128 caracteres.');
      }
      if (typeof versionHash !== 'string' || versionHash.trim().length === 0) {
        throw new ValidationError('versionHash é obrigatório para feedback por item.');
      }
      if (versionHash.length > 128) {
        throw new ValidationError('versionHash deve ter no máximo 128 caracteres.');
      }

      const result = await refinementFeedbackService.upsertItemStatus({
        refinementId: refinementId.trim(),
        agentId: agentId.trim(),
        itemIndex,
        itemKey: itemKey.trim(),
        versionHash: versionHash.trim(),
        status,
        nota: hasNota ? nota : null,
        texto: textoSanitized,
        modelo: typeof modelo === 'string' ? modelo : null,
      });

      logger.info('Refinement item feedback submitted', {
        context: {
          event: 'refinement_item_feedback_submitted',
          feedbackId: result.entry.id,
          refinementId: result.entry.refinementId,
          itemKey: result.entry.itemKey,
          versionHash: result.entry.versionHash,
          status: result.entry.status,
          created: result.created,
        },
      });

      return res.status(result.created ? 201 : 200).json({
        ...result.entry,
        feedbackId: result.entry.id,
        created: result.created,
      });
    }

    const entry = await refinementFeedbackService.create({
      refinementId: refinementId.trim(),
      agentId: agentId.trim(),
      nota,
      texto: textoSanitized,
      modelo: typeof modelo === 'string' ? modelo : null,
      qtdIteracoesAteFeedback:
        typeof qtdIteracoesAteFeedback === 'number' ? qtdIteracoesAteFeedback : null,
    });

    logger.info('Structured refinement feedback submitted', {
      context: {
        event: 'structured_feedback_submitted',
        feedbackId: entry.id,
        refinementId: entry.refinementId,
        agentId: entry.agentId,
        nota: entry.nota,
        hasTexto: !!textoSanitized,
        textoLength: textoSanitized?.length ?? 0,
      },
    });

    res.status(201).json(entry);
  }),
);

cognitiveRoutes.get(
  '/refinement/structured-feedback/:refinementId/items',
  asyncHandler(async (req: Request, res: Response) => {
    const refinementId = req.params.refinementId?.trim();
    const versionHash =
      typeof req.query.versionHash === 'string' ? req.query.versionHash.trim() : '';
    if (!refinementId) {
      throw new ValidationError('refinementId é obrigatório.');
    }
    if (!versionHash) {
      throw new ValidationError('versionHash é obrigatório.');
    }
    if (refinementId.length > 200 || versionHash.length > 128) {
      throw new ValidationError('Identificador de refinamento inválido.');
    }

    const { refinementFeedbackService } = await import('../services/refinement-feedback-service');
    const entries = await refinementFeedbackService.getByRefinementVersion(
      refinementId,
      versionHash,
    );
    res.json(entries);
  }),
);
