import { GitHubService } from './github';
import { githubWriteTotal, githubWriteFailureTotal } from '../metrics';
import {
  FileToCommit,
  CommitResult,
  PullRequestResult,
  GitHubOperations,
  GitHubWriteError,
  type GitHubWriteErrorCode,
} from '@shared/github-operations';

const isSupportedGitHubToken = (token: string): boolean =>
  token.startsWith('github_pat_') ||
  token.startsWith('ghp_') ||
  token.startsWith('gho_') ||
  token.startsWith('ghu_') ||
  token.startsWith('ghs_');

const supportedTokenMessage =
  'Use a GitHub token: fine-grained PAT (github_pat_), classic PAT (ghp_), or OAuth token from GitHub CLI (gho_).';

function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function mapStatusToCode(status: number | undefined): GitHubWriteErrorCode {
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 422) return 'BASE_CONFLICT';
  return 'INTERNAL';
}

function translateError(
  error: unknown,
  context: { owner: string; repo: string; branch?: string },
): GitHubWriteError {
  const status = getErrorStatus(error);
  const code = mapStatusToCode(status);
  const message = getErrorMessage(error);

  let userMessage: string;
  switch (code) {
    case 'FORBIDDEN':
      userMessage = `Permissão insuficiente para escrever em ${context.owner}/${context.repo}.`;
      break;
    case 'NOT_FOUND':
      userMessage = `Repositório ou branch inexistente: ${context.owner}/${context.repo}${context.branch ? `@${context.branch}` : ''}.`;
      break;
    case 'BASE_CONFLICT':
      userMessage = 'A branch avançou desde a leitura; refaça a operação.';
      break;
    default:
      userMessage = `Falha na operação de escrita GitHub: ${message}`;
  }

  return new GitHubWriteError(code, userMessage, context);
}

export class OctokitGitHubOperations implements GitHubOperations {
  // Exposed for tests only.
  public service: GitHubService;

  constructor() {
    // Reuse the same MyOctokit (retry + throttling) used by the read service,
    // but with a dedicated write credential that never mixes with the read token.
    this.service = new GitHubService(process.env.GITHUB_WRITE_TOKEN);
  }

  private requireWriteToken(): void {
    const token = process.env.GITHUB_WRITE_TOKEN || '';
    if (!token) {
      throw new GitHubWriteError(
        'NO_WRITE_TOKEN',
        'Escrita GitHub indisponível: configure GITHUB_WRITE_TOKEN (fine-grained PAT com escopo de escrita).',
      );
    }
    if (!isSupportedGitHubToken(token)) {
      throw new GitHubWriteError(
        'NO_WRITE_TOKEN',
        `Formato de token GitHub inválido. ${supportedTokenMessage}`,
      );
    }
  }

  private recordSuccess(operation: string): void {
    githubWriteTotal.labels({ operation }).inc();
  }

  private recordFailure(operation: string, reason: GitHubWriteErrorCode): void {
    githubWriteFailureTotal.labels({ operation, reason }).inc();
  }

  async createOrUpdateFile(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<CommitResult> {
    this.requireWriteToken();

    let blobSha: string | undefined;
    try {
      const file = await this.service.client.repos.getContent({
        owner,
        repo,
        path,
        ref: `refs/heads/${branch}`,
      });
      if (!Array.isArray(file.data) && typeof file.data === 'object') {
        blobSha = file.data.sha;
      }
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        const code = mapStatusToCode(getErrorStatus(error));
        this.recordFailure('createOrUpdateFile', code);
        throw translateError(error, { owner, repo, branch });
      }
      // 404 means the file does not exist yet; create without sha.
    }

    try {
      const response = await this.service.client.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
        ...(blobSha ? { sha: blobSha } : {}),
      });
      this.recordSuccess('createOrUpdateFile');
      return {
        sha: response.data.commit?.sha ?? '',
        treeSha: response.data.commit?.tree?.sha ?? '',
        branch,
      };
    } catch (error) {
      const code = mapStatusToCode(getErrorStatus(error));
      this.recordFailure('createOrUpdateFile', code);
      throw translateError(error, { owner, repo, branch });
    }
  }

  async batchCreateFiles(
    owner: string,
    repo: string,
    branch: string,
    files: FileToCommit[],
    message: string,
  ): Promise<CommitResult> {
    this.requireWriteToken();

    if (files.length === 0) {
      this.recordFailure('batchCreateFiles', 'EMPTY_BATCH');
      throw new GitHubWriteError('EMPTY_BATCH', 'Nenhum arquivo para commitar.', {
        owner,
        repo,
        branch,
      });
    }

    try {
      const refResponse = await this.service.client.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      const baseSha = refResponse.data.object.sha;

      const baseCommit = await this.service.client.git.getCommit({
        owner,
        repo,
        commit_sha: baseSha,
      });
      const baseTreeSha = baseCommit.data.tree.sha;

      const tree = await this.service.client.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: files.map((file) => ({
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          content: file.content,
        })),
      });

      const commit = await this.service.client.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.data.sha,
        parents: [baseSha],
      });

      await this.service.client.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });

      this.recordSuccess('batchCreateFiles');
      return {
        sha: commit.data.sha,
        treeSha: tree.data.sha,
        branch,
      };
    } catch (error) {
      const code = mapStatusToCode(getErrorStatus(error));
      this.recordFailure('batchCreateFiles', code);
      throw translateError(error, { owner, repo, branch });
    }
  }

  /**
   * F3 (Ajustes claude): resolve nome + SHA da branch base (default do repo,
   * fallback "main"). Base do PR e ponto de partida da branch de trabalho.
   */
  async getBaseRef(owner: string, repo: string): Promise<{ branch: string; sha: string }> {
    this.requireWriteToken();
    try {
      const repoData = await this.service.client.repos.get({ owner, repo });
      const branch = repoData.data.default_branch || 'main';
      const ref = await this.service.client.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return { branch, sha: ref.data.object.sha };
    } catch (error) {
      const code = mapStatusToCode(getErrorStatus(error));
      this.recordFailure('getBaseRef', code);
      throw translateError(error, { owner, repo });
    }
  }

  /**
   * F3: `true` se a branch tem branch protection; `false` se não (404); `null`
   * quando indeterminável (permissão insuficiente / erro transitório). Não lança
   * — a proteção é um sinal de segurança, não um bloqueio duro do fluxo de PR.
   */
  async isBranchProtected(owner: string, repo: string, branch: string): Promise<boolean | null> {
    this.requireWriteToken();
    try {
      await this.service.client.repos.getBranchProtection({ owner, repo, branch });
      return true;
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 404) return false;
      return null;
    }
  }

  /** F3: cria uma branch de trabalho a partir de um SHA. */
  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
    this.requireWriteToken();
    try {
      await this.service.client.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
      this.recordSuccess('createBranch');
    } catch (error) {
      const code = mapStatusToCode(getErrorStatus(error));
      this.recordFailure('createBranch', code);
      throw translateError(error, { owner, repo, branch });
    }
  }

  /** F3: apaga uma branch de trabalho (rollback). Não lança — best-effort. */
  async deleteBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.service.client.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      this.recordSuccess('deleteBranch');
      return true;
    } catch (error) {
      this.recordFailure('deleteBranch', mapStatusToCode(getErrorStatus(error)));
      return false;
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string,
  ): Promise<PullRequestResult> {
    this.requireWriteToken();

    try {
      const response = await this.service.client.pulls.create({
        owner,
        repo,
        title,
        head,
        base,
        body,
      });
      this.recordSuccess('createPullRequest');
      return {
        number: response.data.number,
        url: response.data.html_url,
      };
    } catch (error) {
      const code = mapStatusToCode(getErrorStatus(error));
      this.recordFailure('createPullRequest', code);
      throw translateError(error, { owner, repo, branch: `${head} → ${base}` });
    }
  }
}
