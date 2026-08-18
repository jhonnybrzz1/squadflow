import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { humanFeedbackService } from '../services/human-feedback-service';
import { refinementFeedbackService } from '../services/refinement-feedback-service';
import { refinementEventService } from '../services/refinement-events';
import { logRefinementUxTelemetry } from '../services/refinement-ux-telemetry';
import { refinementExecutionStore } from '../services/refinement-execution-store';
import { userFeedbackTotal } from '../metrics';
import { logger } from '../utils/logger';

const router = Router();

const refinementTelemetrySchema = z.object({
  body: z.object({
    eventName: z.enum(['markdown_visible_duration_ms', 'thinking_time_ms', 'message_abandoned']),
    clientTimestamp: z.string().optional(),
    payload: z
      .object({
        messageId: z.string().optional(),
        stageId: z.string().optional(),
        demandId: z.number().int().optional(),
        agent: z.string().optional(),
        markdownVisibleDurationMs: z.number().nonnegative().optional(),
        thinkingTimeMs: z.number().nonnegative().optional(),
        contentLength: z.number().int().nonnegative().optional(),
        rawMarkdownDetected: z.boolean().optional(),
        reason: z.string().optional(),
        streamStartedAt: z.number().optional(),
        firstChunkAt: z.number().optional(),
        parseCompletedAt: z.number().optional(),
        abandonedAt: z.number().optional(),
        qualityFlags: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
});

router.post(
  '/api/refinement/telemetry',
  validateRequest(refinementTelemetrySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { eventName, payload, clientTimestamp } = req.body;

    logRefinementUxTelemetry(eventName, payload, clientTimestamp);

    res.status(202).json({ ok: true });
  }),
);

const feedbackSchema = z.object({
  body: z.object({
    demandId: z.number().int().optional(),
    agentMessageId: z.string().min(1, 'agentMessageId é obrigatório.'),
    feedbackType: z.enum(['like', 'dislike']),
    feedbackText: z.string().max(500, 'feedbackText deve ter no máximo 500 caracteres.').optional(),
    agent: z.string().optional(),
  }),
});

router.post(
  '/api/refinement/feedback',
  validateRequest(feedbackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;

    const sanitized = payload.feedbackText ? payload.feedbackText.replace(/<[^>]*>/g, '') : '';

    const entry = await humanFeedbackService.create({
      demandId: payload.demandId ?? 0,
      agentMessageId: payload.agentMessageId,
      feedbackText: sanitized,
      feedbackType: payload.feedbackType,
      agent: payload.agent ?? null,
    });

    // D3: expõe o feedback do usuário ao A2 (taxa de aprovação por agente).
    userFeedbackTotal.labels(entry.feedbackType, entry.agent ?? 'unknown').inc();

    logger.info('Human feedback submitted', {
      context: {
        event: 'modal_feedback_submitted',
        feedbackId: entry.id,
        demandId: entry.demandId,
        agentMessageId: entry.agentMessageId,
        feedbackType: entry.feedbackType,
        hasText: sanitized.length > 0,
        textLength: sanitized.length,
      },
    });

    res.status(201).json(entry);
  }),
);

const demandIdParamSchema = z.object({
  params: z.object({ demandId: z.coerce.number().positive() }),
});

router.get(
  '/api/refinement/feedback/:demandId',
  validateRequest(demandIdParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const demandId = parseInt(req.params.demandId);
    const entries = humanFeedbackService.getByDemandId(demandId);
    res.json(entries);
  }),
);

const innovationSuggestionFeedbackSchema = z.object({
  body: z.object({
    demandId: z.number().int().positive(),
    agentMessageId: z.string().min(1),
    accepted: z.boolean(),
    agent: z.string().optional(),
  }),
});

router.post(
  '/api/refinement/innovation-suggestion-feedback',
  validateRequest(innovationSuggestionFeedbackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const entry = await refinementEventService.record({
      demandId: payload.demandId,
      eventName: 'pm_innovation_suggestion_feedback',
      agentName: payload.agent ?? 'pm_innovation',
      agentMessageId: payload.agentMessageId,
      suggestionAccepted: payload.accepted,
      metadata: {
        source: 'chat_action',
      },
    });

    logger.info('PM innovation suggestion feedback submitted', {
      context: {
        demandId: payload.demandId,
        agentMessageId: payload.agentMessageId,
        accepted: payload.accepted,
      },
    });

    res.status(201).json({ ok: true, eventId: entry?.id ?? null });
  }),
);

const toneFeedbackSchema = z.object({
  body: z.object({
    demandId: z.number().int().positive(),
    agentMessageId: z.string().min(1).optional(),
    feedbackType: z.enum(['like', 'dislike']),
  }),
});

router.post(
  '/api/refinement/tone-feedback',
  validateRequest(toneFeedbackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const entry = await refinementEventService.record({
      demandId: payload.demandId,
      eventName: 'tone_feedback',
      agentMessageId: payload.agentMessageId ?? `tone:${payload.demandId}`,
      toneFeedback: payload.feedbackType,
      metadata: {
        source: 'post_refinement',
      },
    });

    logger.info('Tone feedback submitted', {
      context: {
        demandId: payload.demandId,
        feedbackType: payload.feedbackType,
      },
    });

    res.status(201).json({ ok: true, eventId: entry?.id ?? null });
  }),
);

const agentIdParamSchema = z.object({
  params: z.object({ agentId: z.string().min(1) }),
});

router.get(
  '/api/refinement/structured-feedback/:agentId',
  validateRequest(agentIdParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const entries = await refinementFeedbackService.getByAgentId(agentId);
    res.json(entries);
  }),
);

const idStringParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

router.get(
  '/api/refinement-status/:id',
  validateRequest(idStringParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const refinementId = req.params.id;
    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const status = await refinementInteractionService.getStatus(refinementId);
    logger.debug('Refinement status refreshed', {
      context: {
        refinementId,
        sequence: status.sequence,
        eventType: 'refinement_status_refreshed',
      },
    });
    res.json(status);
  }),
);

const refinementResponseSchema = z.object({
  body: z.object({
    refinementId: z.string(),
    interactionId: z.string(),
    sequence: z.number().int().nonnegative(),
    response: z.string().min(1),
  }),
});

router.post(
  '/api/refinement-response',
  validateRequest(refinementResponseSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const result = await refinementInteractionService.applyResponse(
      payload.refinementId,
      payload.interactionId,
      payload.sequence,
      payload.response,
    );
    res.json(result);
  }),
);

const refinementPauseSchema = z.object({
  body: z.object({
    refinementId: z.string(),
    reason: z.string().optional(),
  }),
});

router.post(
  '/api/refinement-pause',
  validateRequest(refinementPauseSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const result = await refinementInteractionService.pause(payload.refinementId, payload.reason);
    res.json(result);
  }),
);

const refinementResumeSchema = z.object({
  body: z.object({ refinementId: z.string() }),
});

router.post(
  '/api/refinement-resume',
  validateRequest(refinementResumeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body;
    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const result = await refinementInteractionService.resume(payload.refinementId);
    res.json(result);
  }),
);

router.get(
  '/api/refinements/:id/status',
  validateRequest(idStringParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const refinementId = req.params.id;
    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const status = await refinementInteractionService.getAnswerFlowStatus(refinementId);
    res.json(status);
  }),
);

const refinementAnswersSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    questionId: z.string(),
    awaitingToken: z.number().int().nonnegative(),
    value: z.string().min(1),
  }),
});

router.post(
  '/api/refinements/:id/answers',
  validateRequest(refinementAnswersSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const refinementId = req.params.id;
    const payload = req.body;

    logger.info('User answer submitted', {
      context: {
        refinementId,
        questionId: payload.questionId,
        awaitingToken: payload.awaitingToken,
        eventType: 'user_answer_submitted',
      },
    });

    const { refinementInteractionService } = await import('../services/refinement-interaction');
    const result = await refinementInteractionService.applyAnswer(
      refinementId,
      payload.questionId,
      payload.awaitingToken,
      payload.value,
    );

    logger.info('Answer applied', {
      context: {
        refinementId,
        questionId: payload.questionId,
        awaitingToken: payload.awaitingToken,
        applied: result.applied,
        eventType: 'answer_applied',
      },
    });

    res.json(result);
  }),
);

const historyQuerySchema = z.object({
  method: z.enum(['sequential', 'roundtable', 'unified']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/api/refinement/history',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = historyQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: 'Validation failed',
        field: String(issue?.path?.[0] ?? 'query'),
        message: issue?.message ?? 'Invalid input',
      });
      return;
    }
    const result = await refinementExecutionStore.list(parsed.data);
    res.json(result);
  }),
);

export default router;
