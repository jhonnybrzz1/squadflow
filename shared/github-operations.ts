/**
 * Contrato público de operações de ESCRITA GitHub.
 * Consumido por 018-F2 (commit do bundle), 021 (arquivos speckit no repo destino)
 * e usado como baseline de latência/erro pelo spike MCP (023).
 */

export interface FileToCommit {
  path: string; // caminho relativo no repo, ex.: "specs/42-handoff/spec.md"
  content: string; // conteúdo textual (UTF-8)
}

export interface CommitResult {
  sha: string; // SHA do commit criado
  treeSha: string; // SHA da árvore — base do "diff zero" (FR-008)
  branch: string; // branch atualizada
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface GitHubOperations {
  createOrUpdateFile(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<CommitResult>;

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
}

export type GitHubWriteErrorCode =
  | 'NO_WRITE_TOKEN'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BASE_CONFLICT'
  | 'EMPTY_BATCH'
  | 'INTERNAL';

export class GitHubWriteError extends Error {
  public readonly code: GitHubWriteErrorCode;
  public readonly owner?: string;
  public readonly repo?: string;
  public readonly branch?: string;

  constructor(
    code: GitHubWriteErrorCode,
    message: string,
    context?: { owner?: string; repo?: string; branch?: string },
  ) {
    super(message);
    this.name = 'GitHubWriteError';
    this.code = code;
    this.owner = context?.owner;
    this.repo = context?.repo;
    this.branch = context?.branch;
  }
}
