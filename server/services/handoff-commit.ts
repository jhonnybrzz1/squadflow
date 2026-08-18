/**
 * Spec 026 — commitar o handoff (spec-kit) dentro do repositório destino.
 *
 * Fecha o elo que faltava: o AiChatFlow já produz o handoff no padrão spec-kit
 * (spec 018) e existe caminho de escrita GitHub (spec 024); este serviço leva
 * os arquivos do handoff para dentro do repo associado à demanda, num único
 * commit atômico, para que um coding agent os consuma direto do repositório.
 *
 * Escrita real exige GITHUB_WRITE_TOKEN (guard da spec 024). Nada é escrito
 * sem repositório associado à demanda nem sem PRD válido.
 */

import { AppError, NotFoundError } from '../middleware/error-handler';
import { demandRepository } from '../repositories/demand-repository';
import { buildHandoffFiles } from './handoff-bundle';
import { OctokitGitHubOperations } from './github-write';
import { runHandoffValidationGate } from './handoff-validation-gate';
import type { GitHubOperations, CommitResult } from '@shared/github-operations';

export interface HandoffCommitResult extends CommitResult {
  owner: string;
  repo: string;
  fileCount: number;
}

/**
 * Resolve a branch alvo: a branch default do repositório (via o client de
 * escrita já autenticado), com fallback para "main".
 */
async function resolveDefaultBranch(
  ops: OctokitGitHubOperations,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const res = await ops.service.client.repos.get({ owner, repo });
    return res.data.default_branch || 'main';
  } catch (_) {
    return 'main';
  }
}

/**
 * Commita os arquivos do handoff da demanda no repositório destino associado a
 * ela (`repoFullName`). Injeção de `ops` para testes; produção usa Octokit.
 */
export async function commitHandoffToRepo(
  demandId: number,
  ops: GitHubOperations = new OctokitGitHubOperations(),
  options: { branch?: string; message?: string } = {},
): Promise<HandoffCommitResult> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new NotFoundError('Demand', demandId);
  }

  const repoFullName = demand.repoFullName;
  if (!repoFullName || !repoFullName.includes('/')) {
    throw new AppError(
      'Demanda não tem repositório associado — não é possível commitar o handoff.',
      422,
      'HANDOFF_NO_REPO',
      { demandId },
    );
  }
  const [owner, repo] = repoFullName.split('/');

  // Reusa a geração do handoff (guard de PRD 422 incluído).
  const { files } = await buildHandoffFiles(demandId);

  // Spec 10014: gate de alucinações PRÉ-COMMIT (última linha de defesa antes de
  // escrever no repo destino). Em blocking, aborta se houver issue crítica.
  const gate = await runHandoffValidationGate(repoFullName, files, { demandId });
  if (!gate.passed) {
    throw new AppError(
      'Handoff bloqueado pelo gate de alucinações — referências não verificadas contra o repositório.',
      422,
      'HANDOFF_HALLUCINATION_GATE',
      { demandId, issues: gate.issues, report: gate.report },
    );
  }

  const branch =
    options.branch ??
    (ops instanceof OctokitGitHubOperations
      ? await resolveDefaultBranch(ops, owner, repo)
      : 'main');

  const message =
    options.message ?? `chore(handoff): spec-kit da demanda ${demandId} (${demand.title})`;

  const result = await ops.batchCreateFiles(
    owner,
    repo,
    branch,
    files.map((f) => ({ path: f.path, content: f.content })),
    message,
  );

  return { ...result, owner, repo, fileCount: files.length };
}
