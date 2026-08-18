/**
 * Spec "Ajustes claude" F3 — abre um PULL REQUEST da branch de trabalho para a
 * main, com máquina de estados, idempotência por `operationId`, checagem de
 * branch protection e ROLLBACK automático (apaga a branch) em caso de falha.
 *
 * NUNCA faz `git merge`/`push` direto na main (decisão do PO 2026-07-22 §2). O
 * merge efetivo do PR é feito por um humano após a revisão técnica — esta rede
 * de segurança é o ponto central do requisito.
 *
 * Pré-condições (demanda inexistente, sem repo, PRD ausente, gate de alucinação)
 * LANÇAM (o chamador traduz para 4xx). Falhas na fase de escrita GitHub retornam
 * um resultado com `state: 'failed'` + `rolledBack`, para o front notificar.
 */
import { buildHandoffFiles } from './handoff-bundle';
import { runHandoffValidationGate } from './handoff-validation-gate';
import { OctokitGitHubOperations } from './github-write';
import { demandRepository } from '../repositories/demand-repository';
import { AppError, NotFoundError } from '../middleware/error-handler';
import { logger } from '../utils/logger';
import type { CommitResult, PullRequestResult, FileToCommit } from '@shared/github-operations';
import type { MergeRequestResult, MergeState } from '@shared/merge-to-main';

/** Subconjunto de operações GitHub que o fluxo F3 precisa (injetável em testes). */
export interface MergePrOperations {
  getBaseRef(owner: string, repo: string): Promise<{ branch: string; sha: string }>;
  isBranchProtected(owner: string, repo: string, branch: string): Promise<boolean | null>;
  createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void>;
  batchCreateFiles(
    owner: string,
    repo: string,
    branch: string,
    files: FileToCommit[],
    message: string,
  ): Promise<CommitResult>;
  createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string,
  ): Promise<PullRequestResult>;
  deleteBranch(owner: string, repo: string, branch: string): Promise<boolean>;
}

// Idempotência em processo: um operationId que já abriu PR ("merged") reenvia o
// mesmo resultado; um em andamento devolve o estado corrente sem duplicar.
const results = new Map<string, MergeRequestResult>();
const inFlight = new Set<string>();

/** Slug curto e seguro para compor o nome da branch de trabalho. */
function shortId(operationId: string): string {
  return operationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'op';
}

function base(operationId: string, demandId: number, baseBranch: string): MergeRequestResult {
  return {
    operationId,
    demandId,
    state: 'pending',
    baseBranch,
    headBranch: null,
    baseBranchProtected: null,
    prNumber: null,
    prUrl: null,
    error: null,
    rolledBack: false,
    idempotentReplay: false,
  };
}

/**
 * Abre o PR de forma idempotente. `ops` é injetado nos testes; produção usa
 * Octokit com o token de escrita dedicado.
 */
export async function openMergeRequest(
  demandId: number,
  operationId: string,
  ops: MergePrOperations = new OctokitGitHubOperations(),
): Promise<MergeRequestResult> {
  if (!operationId || typeof operationId !== 'string') {
    throw new AppError(
      'operationId é obrigatório para o merge idempotente.',
      400,
      'MERGE_NO_OP_ID',
    );
  }

  // Replay idempotente de um PR já aberto.
  const cached = results.get(operationId);
  if (cached && cached.state === 'merged') {
    return { ...cached, idempotentReplay: true };
  }
  // Operação em andamento com o mesmo id: não duplica.
  if (inFlight.has(operationId)) {
    return { ...base(operationId, demandId, 'main'), idempotentReplay: true };
  }

  inFlight.add(operationId);
  try {
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }
    const repoFullName = demand.repoFullName;
    if (!repoFullName || !repoFullName.includes('/')) {
      throw new AppError(
        'Demanda não tem repositório associado — não é possível abrir o PR.',
        422,
        'MERGE_NO_REPO',
        { demandId },
      );
    }
    const [owner, repo] = repoFullName.split('/');

    // Conteúdo do PR: o mesmo bundle de handoff (guard de PRD 422 embutido).
    const { files } = await buildHandoffFiles(demandId);

    // Gate anti-alucinação: última defesa antes de escrever no repo (422 se falha).
    const gate = await runHandoffValidationGate(repoFullName, files, { demandId });
    if (!gate.passed) {
      throw new AppError(
        'PR bloqueado pelo gate de alucinações — referências não verificadas contra o repositório.',
        422,
        'MERGE_HALLUCINATION_GATE',
        { demandId, issues: gate.issues },
      );
    }

    const baseRef = await ops.getBaseRef(owner, repo);
    const state: MergeState = 'approved';
    const result = base(operationId, demandId, baseRef.branch);
    result.state = state;

    // Sinal de segurança: base protegida => o merge humano do PR será gated.
    result.baseBranchProtected = await ops.isBranchProtected(owner, repo, baseRef.branch);

    const headBranch = `ajustes-claude/demand-${demandId}-${shortId(operationId)}`;
    result.headBranch = headBranch;
    result.state = 'merging';

    let branchCreated = false;
    try {
      await ops.createBranch(owner, repo, headBranch, baseRef.sha);
      branchCreated = true;

      await ops.batchCreateFiles(
        owner,
        repo,
        headBranch,
        files.map((f) => ({ path: f.path, content: f.content })),
        `chore(handoff): PR da demanda ${demandId} (${demand.title})`,
      );

      const pr = await ops.createPullRequest(
        owner,
        repo,
        headBranch,
        baseRef.branch,
        `Merge da demanda ${demandId}: ${demand.title}`,
        `PR aberto pelo fluxo F3 (Ajustes claude). Revisão técnica humana obrigatória antes do merge.\n\nDemanda: #${demandId}`,
      );

      result.state = 'merged';
      result.prNumber = pr.number;
      result.prUrl = pr.url;
      results.set(operationId, result);
      logger.info('F3: PR aberto para a main', {
        context: { demandId, operationId, prNumber: pr.number, headBranch },
      });
      return result;
    } catch (writeError) {
      // ROLLBACK automático: se a branch de trabalho foi criada, apaga-a.
      result.state = 'failed';
      result.error =
        writeError instanceof Error ? writeError.message : 'Falha ao abrir o PR para a main.';
      if (branchCreated) {
        result.rolledBack = await ops.deleteBranch(owner, repo, headBranch);
      }
      results.set(operationId, result);
      logger.error('F3: falha ao abrir PR — rollback executado', {
        error: writeError instanceof Error ? writeError : undefined,
        context: { demandId, operationId, headBranch, rolledBack: result.rolledBack },
      });
      return result;
    }
  } finally {
    inFlight.delete(operationId);
  }
}
