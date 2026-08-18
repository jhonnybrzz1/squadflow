/**
 * Spec "Ajustes claude" F3 — contrato do fluxo de "merge para a main".
 *
 * IMPORTANTE (decisão do PO 2026-07-22 §2): o botão ABRE UM PULL REQUEST para a
 * main via API do GitHub — NUNCA faz `git merge`/`push` direto e irreversível. O
 * merge efetivo do PR é feito por um humano após a revisão técnica.
 */

import { z } from 'zod';

/** Payload do POST /api/demands/:id/merge-to-main. */
export const mergeToMainRequestSchema = z.object({
  // operationId gerado no cliente e reusado em retries → idempotência.
  operationId: z.string().min(1).max(200),
});

export type MergeToMainRequest = z.infer<typeof mergeToMainRequestSchema>;

/** Máquina de estados do fluxo (critério F3). */
export type MergeState = 'pending' | 'approved' | 'merging' | 'merged' | 'failed';

export interface MergeRequestResult {
  /** Idempotência (FR): duas chamadas com o mesmo operationId não abrem 2 PRs. */
  operationId: string;
  demandId: number;
  state: MergeState;
  baseBranch: string;
  headBranch: string | null;
  /** Proteção da branch base: true/false conhecido, null indeterminado. */
  baseBranchProtected: boolean | null;
  prNumber: number | null;
  prUrl: string | null;
  /** Mensagem de erro amigável quando `state === 'failed'`. */
  error: string | null;
  /** true quando a branch de trabalho foi removida no rollback. */
  rolledBack: boolean;
  /** true quando o resultado é o replay idempotente de uma chamada anterior. */
  idempotentReplay: boolean;
}
