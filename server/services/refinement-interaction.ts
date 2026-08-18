/**
 * Refinement Interaction Service (MVP - Polling)
 *
 * Gerencia interações bidirecionais durante o refinamento via polling HTTP.
 * Estado global derivado das próprias interações (status, sequence, paused).
 *
 * Contrato: docs/refinement-interaction-contract.md
 *
 * Decisões:
 * - Sem migration: tudo persistido em demands.refinementInteractions (JSON)
 * - Cache em memória + write-through ao DB
 * - Idempotência via (refinementId, interactionId, sequence)
 * - Erros 409 determinísticos: PAUSED | CONTEXT_MISMATCH
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { demandRepository } from '../repositories/demand-repository';
import type {
  RefinementInteraction,
  RefinementSuggestion,
  RefinementStatusResponse,
  AnswerFlowState,
  AnswerFlowStatusResponse,
} from '@shared/schema';

export type RefinementErrorCode = 'PAUSED' | 'CONTEXT_MISMATCH' | 'NOT_FOUND' | 'ALREADY_ANSWERED';

export class RefinementInteractionError extends Error {
  readonly code: RefinementErrorCode;
  readonly statusCode: number;
  readonly currentSequence?: number;

  constructor(code: RefinementErrorCode, message: string, currentSequence?: number) {
    super(message);
    this.name = 'RefinementInteractionError';
    this.code = code;
    this.statusCode = code === 'NOT_FOUND' ? 404 : 409;
    this.currentSequence = currentSequence;
  }
}

interface PendingQuestion {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  interactionId: string;
}

class RefinementInteractionService {
  // refinementId -> last loaded interactions (cache)
  private cache: Map<string, RefinementInteraction[]> = new Map();
  // refinementId -> pending askQuestion() promises (waiting for PO answer)
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  // refinementId -> in-memory suggestions (write-through to DB)
  private suggestions: Map<string, RefinementSuggestion[]> = new Map();
  // H-15: per-refinementId async mutex queue. Each entry is a chain of
  // promises that serialize access to the read-modify-write cycle
  // (hydrate → modify → persist). Without this, two concurrent operations
  // (e.g., askQuestion + pause) both read the same interactions array,
  // both modify their copy, and the second persist overwrites the first —
  // silently losing one operation.
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * H-15: Serializes access to a refinementId's read-modify-write cycle.
   * Returns a release function that MUST be called in a finally block.
   */
  private async acquireLock(refinementId: string): Promise<() => void> {
    const prev = this.locks.get(refinementId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      refinementId,
      prev.then(() => next),
    );
    await prev;
    return release;
  }

  /**
   * Hidrata cache do DB para uma demanda.
   */
  private async hydrate(refinementId: string): Promise<RefinementInteraction[]> {
    const demand = await demandRepository.findByIdOrNull(parseInt(refinementId, 10));
    if (!demand) {
      throw new RefinementInteractionError('NOT_FOUND', `Refinement ${refinementId} not found`);
    }
    const interactions = (demand.refinementInteractions || []) as RefinementInteraction[];
    this.cache.set(refinementId, interactions);
    return interactions;
  }

  /**
   * Persiste array de interações de volta no DB (write-through).
   */
  private async persist(
    refinementId: string,
    interactions: RefinementInteraction[],
  ): Promise<void> {
    this.cache.set(refinementId, interactions);
    await demandRepository.update(parseInt(refinementId, 10), {
      refinementInteractions: interactions,
    });
  }

  /**
   * Computa estado atual a partir do array de interações.
   * - sequence: max(sequence) ou 0
   * - status: 'PAUSED' se última pause/resume for pause; senão 'ACTIVE'
   * - pausedAt: timestamp da última pausa ativa
   * - activeInteraction: última question com status='pending'
   */
  private deriveState(interactions: RefinementInteraction[]): {
    sequence: number;
    status: 'ACTIVE' | 'PAUSED';
    pausedAt: string | null;
    activeQuestion: RefinementInteraction | null;
  } {
    let sequence = 0;
    let status: 'ACTIVE' | 'PAUSED' = 'ACTIVE';
    let pausedAt: string | null = null;
    let activeQuestion: RefinementInteraction | null = null;

    for (const i of interactions) {
      if (typeof i.sequence === 'number' && i.sequence > sequence) {
        sequence = i.sequence;
      }
      if (i.kind === 'pause') {
        status = 'PAUSED';
        pausedAt = i.timestamp;
      } else if (i.kind === 'resume') {
        status = 'ACTIVE';
        pausedAt = null;
      }
    }

    // Active question = last pending question
    for (let idx = interactions.length - 1; idx >= 0; idx--) {
      const i = interactions[idx];
      if (i.kind === 'question' && i.status === 'pending') {
        activeQuestion = i;
        break;
      }
    }

    return { sequence, status, pausedAt, activeQuestion };
  }

  /**
   * GET /refinement-status — fonte da verdade do polling.
   */
  async getStatus(refinementId: string): Promise<RefinementStatusResponse> {
    const interactions = await this.hydrate(refinementId);
    const state = this.deriveState(interactions);
    const suggestions = this.suggestions.get(refinementId) || [];

    return {
      refinementId,
      status: state.status,
      sequence: state.sequence,
      pausedAt: state.pausedAt,
      activeInteraction: state.activeQuestion
        ? {
            interactionId: state.activeQuestion.id,
            question: state.activeQuestion.question || '',
            options: state.activeQuestion.options,
            createdAt: state.activeQuestion.timestamp,
          }
        : null,
      suggestions,
      history: interactions
        .filter((i) => i.kind && i.kind !== 'suggestion')
        .map((i) => ({
          interactionId: i.id,
          sequence: i.sequence ?? 0,
          kind: i.kind!,
          question: i.question,
          answer: i.answer,
          timestamp: i.timestamp,
        })),
    };
  }

  /**
   * Emite uma pergunta para o PO durante o refinamento (chamado pelo agente).
   * Retorna uma Promise que resolve quando o PO responde via API.
   *
   * @param refinementId
   * @param question texto
   * @param options opções de resposta (opcional)
   * @param timeoutMs timeout para resposta (default: 5min)
   */
  async askQuestion(
    refinementId: string,
    question: string,
    options?: string[],
    timeoutMs: number = 5 * 60 * 1000,
  ): Promise<string> {
    // H-15: serialize the read-modify-write cycle
    const release = await this.acquireLock(refinementId);
    try {
      const interactions = (await this.hydrate(refinementId)).slice();
      const state = this.deriveState(interactions);

      if (state.status === 'PAUSED') {
        // Não emite pergunta enquanto pausado
        throw new RefinementInteractionError('PAUSED', 'Cannot emit question while paused');
      }

      const interactionId = randomUUID();
      const newSequence = state.sequence + 1;
      const now = new Date().toISOString();

      const newInteraction: RefinementInteraction = {
        id: interactionId,
        section: 'interactive',
        itemKey: 'question',
        action: 'PROPOSE',
        justification: 'Agent emitted question during refinement',
        author: 'agent',
        timestamp: now,
        kind: 'question',
        sequence: newSequence,
        status: 'pending',
        question,
        options,
      };

      interactions.push(newInteraction);
      await this.persist(refinementId, interactions);

      logger.info('Refinement question emitted', {
        context: {
          refinementId,
          interactionId,
          sequence: newSequence,
          eventType: 'refinement_question_emitted',
        },
      });

      return new Promise<string>((resolve, reject) => {
        this.pendingQuestions.set(refinementId, { resolve, reject, interactionId });

        const timer = setTimeout(() => {
          const pending = this.pendingQuestions.get(refinementId);
          if (pending && pending.interactionId === interactionId) {
            this.pendingQuestions.delete(refinementId);
            // Mark as expired in DB
            this.expireQuestion(refinementId, interactionId).catch((err) =>
              logger.error('Failed to expire question', { error: err }),
            );
            reject(new Error(`Question timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);

        // store timer reference for cleanup on answer
        (this.pendingQuestions.get(refinementId) as any).timer = timer;
      });
    } finally {
      release();
    }
  }

  private async expireQuestion(refinementId: string, interactionId: string): Promise<void> {
    // H-15: serialize the read-modify-write cycle
    const release = await this.acquireLock(refinementId);
    try {
      const interactions = (await this.hydrate(refinementId)).slice();
      const idx = interactions.findIndex((i) => i.id === interactionId);
      if (idx >= 0 && interactions[idx].status === 'pending') {
        interactions[idx] = { ...interactions[idx], status: 'expired' };
        await this.persist(refinementId, interactions);
      }
    } finally {
      release();
    }
  }

  /**
   * POST /refinement-response — aplica resposta do PO com idempotência.
   */
  async applyResponse(
    refinementId: string,
    interactionId: string,
    sequence: number,
    response: string,
  ): Promise<{
    applied: boolean;
    interactionId: string;
    newSequence: number;
    status: 'ACTIVE' | 'PAUSED';
  }> {
    // H-15: serialize the read-modify-write cycle
    const release = await this.acquireLock(refinementId);
    try {
      const interactions = (await this.hydrate(refinementId)).slice();
      const state = this.deriveState(interactions);

      logger.info('PO interaction submitted', {
        context: {
          refinementId,
          interactionId,
          sequence,
          eventType: 'po_interaction_submitted',
        },
      });

      // Rule: PAUSED -> 409 PAUSED
      if (state.status === 'PAUSED') {
        logger.info('Refinement interaction rejected', {
          context: {
            refinementId,
            interactionId,
            sequence,
            eventType: 'refinement_interaction_rejected',
            result: 'PAUSED',
          },
        });
        throw new RefinementInteractionError('PAUSED', 'Refinement is paused', state.sequence);
      }

      // Find target interaction
      const idx = interactions.findIndex((i) => i.id === interactionId);
      if (idx < 0) {
        throw new RefinementInteractionError(
          'CONTEXT_MISMATCH',
          'Interaction not found',
          state.sequence,
        );
      }
      const target = interactions[idx];

      // Idempotency: already answered with same payload
      if (target.status === 'answered') {
        if (target.answer === response && target.sequence === sequence) {
          logger.info('Refinement interaction applied (idempotent)', {
            context: {
              refinementId,
              interactionId,
              sequence,
              eventType: 'refinement_interaction_applied',
              result: 'idempotent',
            },
          });
          return {
            applied: true,
            interactionId,
            newSequence: state.sequence,
            status: state.status,
          };
        }
        throw new RefinementInteractionError(
          'CONTEXT_MISMATCH',
          'Interaction already answered with different response',
          state.sequence,
        );
      }

      // Rule: sequence/interactionId mismatch -> 409 CONTEXT_MISMATCH
      if (target.sequence !== sequence) {
        logger.info('Refinement interaction rejected', {
          context: {
            refinementId,
            interactionId,
            sequence,
            eventType: 'refinement_interaction_rejected',
            result: 'CONTEXT_MISMATCH',
          },
        });
        throw new RefinementInteractionError(
          'CONTEXT_MISMATCH',
          'Sequence mismatch',
          state.sequence,
        );
      }

      if (target.kind !== 'question' || target.status !== 'pending') {
        throw new RefinementInteractionError(
          'CONTEXT_MISMATCH',
          'Target is not a pending question',
          state.sequence,
        );
      }

      // Apply
      const now = new Date().toISOString();
      const newSequence = state.sequence + 1;

      interactions[idx] = {
        ...target,
        status: 'answered',
        answer: response,
      };

      interactions.push({
        id: randomUUID(),
        section: 'interactive',
        itemKey: 'answer',
        action: 'ACCEPT',
        justification: `Answer to ${interactionId}`,
        author: 'po',
        timestamp: now,
        kind: 'answer',
        sequence: newSequence,
        answer: response,
      });

      await this.persist(refinementId, interactions);

      // Resolve pending askQuestion promise
      const pending = this.pendingQuestions.get(refinementId);
      if (pending && pending.interactionId === interactionId) {
        const timer = (pending as any).timer;
        if (timer) clearTimeout(timer);
        this.pendingQuestions.delete(refinementId);
        pending.resolve(response);
      }

      logger.info('Refinement interaction applied', {
        context: {
          refinementId,
          interactionId,
          sequence,
          newSequence,
          eventType: 'refinement_interaction_applied',
          result: 'applied',
        },
      });

      return {
        applied: true,
        interactionId,
        newSequence,
        status: 'ACTIVE',
      };
    } finally {
      release();
    }
  }

  /**
   * POST /refinement-pause — marca refinamento como pausado.
   */
  async pause(
    refinementId: string,
    reason?: string,
  ): Promise<{ status: 'PAUSED'; pausedAt: string; sequence: number }> {
    // H-15: serialize the read-modify-write cycle
    const release = await this.acquireLock(refinementId);
    try {
      const interactions = (await this.hydrate(refinementId)).slice();
      const state = this.deriveState(interactions);

      if (state.status === 'PAUSED') {
        // Idempotent
        return {
          status: 'PAUSED',
          pausedAt: state.pausedAt!,
          sequence: state.sequence,
        };
      }

      const newSequence = state.sequence + 1;
      const now = new Date().toISOString();

      interactions.push({
        id: randomUUID(),
        section: 'interactive',
        itemKey: 'pause',
        action: 'PROPOSE',
        justification: reason || 'User requested pause',
        author: 'po',
        timestamp: now,
        kind: 'pause',
        sequence: newSequence,
        reason,
      });

      await this.persist(refinementId, interactions);

      logger.info('Refinement paused', {
        context: { refinementId, sequence: newSequence, eventType: 'refinement_paused' },
      });

      return { status: 'PAUSED', pausedAt: now, sequence: newSequence };
    } finally {
      release();
    }
  }

  /**
   * POST /refinement-resume — retoma refinamento e incrementa sequence
   * (invalida interactionId/sequence antigos).
   */
  async resume(refinementId: string): Promise<{ status: 'ACTIVE'; sequence: number }> {
    // H-15: serialize the read-modify-write cycle
    const release = await this.acquireLock(refinementId);
    try {
      const interactions = (await this.hydrate(refinementId)).slice();
      const state = this.deriveState(interactions);

      if (state.status === 'ACTIVE') {
        return { status: 'ACTIVE', sequence: state.sequence };
      }

      const newSequence = state.sequence + 1;
      const now = new Date().toISOString();

      // Cancel any pending question (forces new question after resume)
      for (let i = 0; i < interactions.length; i++) {
        if (interactions[i].kind === 'question' && interactions[i].status === 'pending') {
          interactions[i] = { ...interactions[i], status: 'cancelled' };
        }
      }

      interactions.push({
        id: randomUUID(),
        section: 'interactive',
        itemKey: 'resume',
        action: 'PROPOSE',
        justification: 'User requested resume',
        author: 'po',
        timestamp: now,
        kind: 'resume',
        sequence: newSequence,
      });

      await this.persist(refinementId, interactions);

      logger.info('Refinement resumed', {
        context: { refinementId, sequence: newSequence, eventType: 'refinement_resumed' },
      });

      return { status: 'ACTIVE', sequence: newSequence };
    } finally {
      release();
    }
  }

  /**
   * Verifica se refinamento está pausado (chamado por ai-squad para esperar).
   */
  async isPaused(refinementId: string): Promise<boolean> {
    const interactions = await this.hydrate(refinementId);
    return this.deriveState(interactions).status === 'PAUSED';
  }

  /**
   * Aguarda resume (poll interno, usado pelo agente).
   */
  async waitWhilePaused(refinementId: string, pollMs: number = 500): Promise<void> {
    while (await this.isPaused(refinementId)) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Adiciona sugestão contextual (versionada).
   */
  async addSuggestion(
    refinementId: string,
    text: string,
    type: 'context' | 'correction' | 'enhancement' = 'enhancement',
  ): Promise<RefinementSuggestion> {
    const interactions = await this.hydrate(refinementId);
    const state = this.deriveState(interactions);

    const suggestion: RefinementSuggestion = {
      id: randomUUID(),
      text,
      type,
      contextVersion: state.sequence,
    };

    const list = this.suggestions.get(refinementId) || [];
    // Drop stale suggestions (different contextVersion)
    const fresh = list.filter((s) => s.contextVersion === state.sequence);
    fresh.push(suggestion);
    this.suggestions.set(refinementId, fresh);

    return suggestion;
  }

  /**
   * Answer Flow MVP - Status (contrato PRD "Modo Conversacional Interativo")
   *
   * Mapeia o estado interno para o contrato externo:
   * - state=AWAITING_USER_INPUT quando há activeQuestion (pending)
   * - state=RUNNING quando ACTIVE sem pergunta pendente
   * - state=PAUSED -> RUNNING (pausa não é exposta no MVP de answer flow)
   * - awaitingToken = sequence atual quando há pergunta; senão null
   * - questionId = interactionId
   */
  async getAnswerFlowStatus(refinementId: string): Promise<AnswerFlowStatusResponse> {
    const interactions = await this.hydrate(refinementId);
    const derived = this.deriveState(interactions);
    const demand = await demandRepository.findByIdOrNull(parseInt(refinementId, 10));

    let state: AnswerFlowState;
    if (demand?.status === 'completed') state = 'COMPLETED';
    else if (demand?.status === 'error') state = 'FAILED';
    else if (derived.activeQuestion) state = 'AWAITING_USER_INPUT';
    else if (demand?.status === 'processing') state = 'RUNNING';
    else state = 'IDLE';

    return {
      refinementId,
      state,
      awaitingToken: derived.activeQuestion ? (derived.activeQuestion.sequence ?? 0) : null,
      currentQuestion: derived.activeQuestion
        ? {
            questionId: derived.activeQuestion.id,
            questionText: derived.activeQuestion.question || '',
            agentStep: derived.activeQuestion.section,
            options: derived.activeQuestion.options,
            emittedAt: derived.activeQuestion.timestamp,
          }
        : null,
      history: interactions
        .filter((i) => i.kind === 'question' || i.kind === 'answer')
        .map((i) => ({
          questionId: i.kind === 'answer' ? (i.itemKey === 'answer' ? i.id : i.id) : i.id,
          awaitingToken: i.sequence ?? 0,
          questionText: i.question,
          answer: i.answer,
          timestamp: i.timestamp,
        })),
    };
  }

  /**
   * Answer Flow MVP - Apply answer (alias com semântica do PRD).
   * Espera (questionId, awaitingToken, value) e mapeia para applyResponse internamente.
   * Retorna 409 quando state != AWAITING_USER_INPUT.
   */
  async applyAnswer(
    refinementId: string,
    questionId: string,
    awaitingToken: number,
    value: string,
  ): Promise<{
    applied: boolean;
    state: AnswerFlowState;
    nextAwaitingToken: number | null;
  }> {
    // Pre-check: must be in AWAITING_USER_INPUT
    const status = await this.getAnswerFlowStatus(refinementId);
    if (status.state !== 'AWAITING_USER_INPUT') {
      throw new RefinementInteractionError(
        'CONTEXT_MISMATCH',
        `Cannot answer in state=${status.state}`,
        status.awaitingToken ?? undefined,
      );
    }
    if (
      !status.currentQuestion ||
      status.currentQuestion.questionId !== questionId ||
      status.awaitingToken !== awaitingToken
    ) {
      throw new RefinementInteractionError(
        'CONTEXT_MISMATCH',
        'questionId or awaitingToken does not match current question',
        status.awaitingToken ?? undefined,
      );
    }

    const result = await this.applyResponse(refinementId, questionId, awaitingToken, value);
    const after = await this.getAnswerFlowStatus(refinementId);
    return {
      applied: result.applied,
      state: after.state,
      nextAwaitingToken: after.awaitingToken,
    };
  }

  /**
   * Limpa cache (útil para testes).
   */
  reset(): void {
    this.cache.clear();
    this.pendingQuestions.clear();
    this.suggestions.clear();
    this.locks.clear();
  }
}

export const refinementInteractionService = new RefinementInteractionService();
