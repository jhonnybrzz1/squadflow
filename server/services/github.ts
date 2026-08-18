import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import simpleGit, { SimpleGit } from 'simple-git';
import { logger } from '../utils/logger';
import {
  githubContentIndexedTotal,
  githubContentIndexFailureTotal,
} from '../metrics/github-content';

export interface GitHubRateLimitMetadata {
  remaining: number | null;
  resetAt: string | null;
}

export interface GitHubResponse<T> {
  data: T;
  rateLimit: GitHubRateLimitMetadata;
}

export type SafeGitHubTextContent =
  | {
      status: 'content';
      path: string;
      content: string;
      size: number;
      sha: string;
      rateLimit: GitHubRateLimitMetadata;
    }
  | {
      status: 'omitted';
      path: string;
      reason: 'binary' | 'oversized' | 'directory' | 'unsupported_encoding';
      size: number | null;
      sha: string;
      rateLimit: GitHubRateLimitMetadata;
    };

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const DEFAULT_SEARCH_MAX_PAGES = 3;
const MAX_SEARCH_PAGES = 10;
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const MAX_SEARCH_RESULTS = 500;

function normalizeRateLimit(
  headers?: Record<string, string | number | undefined>,
): GitHubRateLimitMetadata {
  if (!headers) return { remaining: null, resetAt: null };
  const remainingValue = Number(headers['x-ratelimit-remaining']);
  const resetValue = Number(headers['x-ratelimit-reset']);
  return {
    remaining: Number.isFinite(remainingValue) ? remainingValue : null,
    resetAt: Number.isFinite(resetValue) ? new Date(resetValue * 1000).toISOString() : null,
  };
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function looksBinary(path: string, bytes: Buffer): boolean {
  const binaryExtension =
    /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|woff2?|ttf|eot|mp[34]|mov|avi|exe|dll|so|dylib)$/i;
  if (binaryExtension.test(path)) return true;
  return bytes.subarray(0, Math.min(bytes.length, 8_000)).includes(0);
}

const isSupportedGitHubToken = (token: string): boolean =>
  token.startsWith('github_pat_') || // Fine-grained PAT
  token.startsWith('ghp_') || // Classic PAT
  token.startsWith('gho_') || // OAuth token (GitHub CLI)
  token.startsWith('ghu_') || // GitHub User-to-Server token
  token.startsWith('ghs_'); // GitHub App Installation token

const supportedTokenMessage =
  'Use a GitHub token: fine-grained PAT (github_pat_), classic PAT (ghp_), or OAuth token from GitHub CLI (gho_).';

const MyOctokit = Octokit.plugin(retry, throttling);

export class GitHubService {
  public client: Octokit;
  private git: SimpleGit;
  private readonly token: string;

  constructor(apiKey?: string) {
    const envApiKey = process.env.GITHUB_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
    this.token = apiKey || envApiKey || '';

    logger.debug('Inicializando GitHubService', {
      context: {
        GITHUB_ACCESS_TOKEN: process.env.GITHUB_ACCESS_TOKEN ? 'present' : 'undefined',
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ? 'present' : 'undefined',
        NODE_ENV: process.env.NODE_ENV,
      },
    });

    if (!this.token) {
      logger.warn(
        'Nenhuma chave de API GitHub fornecida. Configure a variável GITHUB_ACCESS_TOKEN.',
      );
    } else {
      logger.debug('GitHub API key carregada com sucesso');
      if (!isSupportedGitHubToken(this.token)) {
        logger.warn(`Formato de token GitHub pode estar incorreto. ${supportedTokenMessage}`);
      }
    }

    // Create Octokit client with error handling, retry, and throttling.
    // P2-02: retry plugin handles transient failures (5xx, network) with
    // exponential backoff. throttling plugin handles 403/429 rate limits
    // by waiting and retrying instead of failing immediately.
    try {
      this.client = new MyOctokit({
        auth: this.token,
        userAgent: 'AiChatFlow/1.0.0',
        baseUrl: 'https://api.github.com',
        request: {
          timeout: 30000,
        },
        // `retries` precisa vir aqui, e NÃO em `request`. O plugin só marca um
        // erro como retentável (gravando `request.retries` nele) quando o
        // status está fora de `doNotRetry` — que já inclui 401/403/404. Mas o
        // handler `failed` do Bottleneck apenas lê `error.request.request.retries`,
        // sem reconsultar `doNotRetry`; passar `retries` em `request` preenche
        // esse campo em TODA request e faz o limiter retentar qualquer falha.
        // Era o que acontecia com credencial expirada: cada chamada virava 4
        // requisições 401 (~2s) e queimava 4x do rate limit sem chance de sucesso.
        retry: {
          retries: 3,
        },
        throttle: {
          onRateLimit: (retryAfter: number, options: any) => {
            logger.warn(`GitHub rate limit hit, retrying after ${retryAfter}s`, {
              context: { method: options?.method, url: options?.url },
            });
            return options.request.retryCount < 3;
          },
          onSecondaryRateLimit: (retryAfter: number, options: any) => {
            logger.warn(`GitHub secondary rate limit hit, retrying after ${retryAfter}s`, {
              context: { method: options?.method, url: options?.url },
            });
            return options.request.retryCount < 3;
          },
        },
      });
      logger.debug('Octokit client inicializado com sucesso');
    } catch (error) {
      logger.error('Falha ao inicializar Octokit client', {
        error: error instanceof Error ? error : undefined,
      });
      this.client = new MyOctokit({ auth: this.token });
    }

    // Initialize simple-git with proper error handling
    try {
      this.git = simpleGit();
      logger.debug('simple-git inicializado com sucesso');
    } catch (gitError) {
      logger.error('Falha ao inicializar simple-git', {
        error: gitError instanceof Error ? gitError : undefined,
      });
      this.git = {
        clone: async () => {
          throw new Error('simple-git not available. Cannot perform git operations.');
        },
      } as any;
    }
  }

  private requireToken(): void {
    if (!this.token) {
      throw new Error('GITHUB_ACCESS_TOKEN or GITHUB_TOKEN environment variable is not set.');
    }
    if (!isSupportedGitHubToken(this.token)) {
      throw new Error(`Invalid GitHub token format. ${supportedTokenMessage}`);
    }
  }

  /**
   * GH-002 (P2-02): Returns true if the GitHub client has a supported token.
   * Used by tool fallbacks to decide whether to attempt a live API call
   * or return an explicit "configure GITHUB_ACCESS_TOKEN" error.
   */
  isAvailable(): boolean {
    return Boolean(this.token) && isSupportedGitHubToken(this.token);
  }

  async listUserRepos() {
    this.requireToken();

    try {
      logger.debug('Listando repositórios acessíveis via GitHub API');
      const repos = await this.client.paginate(this.client.repos.listForAuthenticatedUser, {
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      });
      logger.info(`Repositórios listados com sucesso`, { context: { count: repos.length } });
      // A API do GitHub (Octokit) retorna campos em snake_case; o contrato do
      // client (GithubRepo) usa camelCase. Mapeamos aqui para evitar campos
      // `undefined` no front (ex.: repo.fullName).
      return repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner ? { login: repo.owner.login } : null,
        description: repo.description ?? null,
        url: repo.html_url,
        isPrivate: repo.private ?? false,
        stars: repo.stargazers_count ?? 0,
        language: repo.language ?? null,
        updatedAt: repo.updated_at ?? '',
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStatus = (error as any)?.status || 'Unknown status';
      logger.error('Erro ao listar repositórios do usuário', {
        error: error instanceof Error ? error : undefined,
        context: { errorStatus, errorMessage },
      });
      throw new Error(`Failed to list user repositories: [${errorStatus}] ${errorMessage}`);
    }
  }

  async getRepoContent(owner: string, repo: string, path: string = '', signal?: AbortSignal) {
    return (await this.getRepoContentWithMetadata(owner, repo, path, undefined, signal)).data;
  }

  async getRepoContentWithMetadata(
    owner: string,
    repo: string,
    path: string = '',
    ref?: string,
    signal?: AbortSignal,
  ): Promise<GitHubResponse<Awaited<ReturnType<Octokit['repos']['getContent']>>['data']>> {
    this.requireToken();

    try {
      logger.debug(`Buscando conteúdo do repositório ${owner}/${repo}/${path}`);
      const content = await this.client.repos.getContent({
        owner,
        repo,
        path,
        ref,
        request: { signal },
      });
      logger.debug(`Conteúdo obtido com sucesso para ${owner}/${repo}/${path}`);
      return { data: content.data, rateLimit: normalizeRateLimit(content.headers) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStatus = (error as any)?.status || 'Unknown status';
      logger.error(`Erro ao buscar conteúdo do repositório ${owner}/${repo}/${path}`, {
        error: error instanceof Error ? error : undefined,
        context: { errorStatus, errorMessage },
      });
      throw new Error(`Failed to get repository content: [${errorStatus}] ${errorMessage}`);
    }
  }

  async searchRepo(
    owner: string,
    repo: string,
    searchQuery: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return (await this.searchRepoWithMetadata(owner, repo, searchQuery, signal)).data;
  }

  async searchRepoWithMetadata(
    owner: string,
    repo: string,
    searchQuery: string,
    signal?: AbortSignal,
  ): Promise<GitHubResponse<string[]>> {
    this.requireToken();

    try {
      const safeQuery = searchQuery
        .replace(/repo:[^\s]+/gi, ' ')
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .split(/\s+/)
        .map((term) => term.replace(/^-+/, '')) // Remove ALL leading hyphens (e.g. '--' → '')
        .filter((term) => term.length > 2) // Drop short/empty tokens (avoids lone '-', '--', '_')
        .filter((term) => /\p{L}/u.test(term)) // Must contain at least one letter
        .join(' ')
        .trim()
        .slice(0, 180);

      if (!safeQuery) {
        return { data: [], rateLimit: { remaining: null, resetAt: null } };
      }

      const q = `${safeQuery} repo:${owner}/${repo}`;
      logger.debug(`Pesquisando código em ${owner}/${repo}`, { context: { query: q } });
      const maxPages = boundedInteger(
        process.env.GITHUB_SEARCH_MAX_PAGES,
        DEFAULT_SEARCH_MAX_PAGES,
        MAX_SEARCH_PAGES,
      );
      const maxResults = boundedInteger(
        process.env.GITHUB_SEARCH_MAX_RESULTS,
        DEFAULT_SEARCH_MAX_RESULTS,
        MAX_SEARCH_RESULTS,
      );
      const paths = new Set<string>();
      let rateLimit: GitHubRateLimitMetadata = { remaining: null, resetAt: null };
      let totalCount = 0;

      for (let page = 1; page <= maxPages && paths.size < maxResults; page += 1) {
        const response = await this.client.search.code({
          q,
          page,
          per_page: 100,
          request: { signal },
        });
        totalCount = response.data.total_count;
        rateLimit = normalizeRateLimit(response.headers);
        for (const item of response.data.items) {
          if (paths.size >= maxResults) break;
          paths.add(item.path);
        }
        if (response.data.items.length < 100 || paths.size >= totalCount) break;
      }
      logger.debug(`Resultados da busca`, {
        context: { totalCount, returnedCount: paths.size, repo: `${owner}/${repo}` },
      });

      return { data: Array.from(paths), rateLimit };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStatus = (error as any)?.status || 'Unknown status';

      if (errorStatus === 422) {
        logger.warn(
          `Query de busca GitHub inválida para ${owner}/${repo}: "${errorMessage}". Ignorando busca de código.`,
        );
        return { data: [], rateLimit: { remaining: null, resetAt: null } };
      }
      logger.error(`Erro ao buscar em repositório ${owner}/${repo}`, {
        error: error instanceof Error ? error : undefined,
        context: { errorStatus, errorMessage },
      });
      throw new Error(`Failed to search repository: [${errorStatus}] ${errorMessage}`);
    }
  }

  /**
   * Verifies if specific files exist in a repository via GitHub API
   * @param owner Repository owner
   * @param repo Repository name
   * @param filePaths Array of file paths to verify
   * @returns Object with existing and missing files
   */
  async verifyFilesExist(
    owner: string,
    repo: string,
    filePaths: string[],
  ): Promise<{ existing: string[]; missing: string[] }> {
    if (!this.token) {
      logger.warn('GitHub token not set, cannot verify file existence');
      return { existing: [], missing: filePaths };
    }

    if (!isSupportedGitHubToken(this.token)) {
      logger.warn('Invalid GitHub token format, cannot verify file existence');
      return { existing: [], missing: filePaths };
    }

    const results = await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          await this.client.repos.getContent({ owner, repo, path: filePath });
          return { filePath, exists: true };
        } catch (error) {
          const errorStatus = (error as any)?.status;
          if (errorStatus !== 404) {
            logger.warn(`Erro ao verificar arquivo ${filePath}: ${errorStatus}`);
          } else {
            logger.debug(`Arquivo não encontrado no GitHub: ${owner}/${repo}/${filePath}`);
          }
          return { filePath, exists: false };
        }
      }),
    );

    const existing = results.filter((r) => r.exists).map((r) => r.filePath);
    const missing = results.filter((r) => !r.exists).map((r) => r.filePath);

    return { existing, missing };
  }

  /**
   * Recupera o conjunto COMPLETO de caminhos de arquivo (blobs) do repositório, via uma
   * única chamada `git.getTree` recursiva no branch padrão. Fonte autoritativa para a
   * validação determinística de arquivos citados.
   *
   * `available` é `false` quando não há índice confiável — sem token, repo inacessível,
   * ou árvore truncada (parcial). Nesse caso o chamador NÃO deve marcar nada como
   * inexistente, sob pena de falso positivo.
   */
  async getRepoTreePaths(
    owner: string,
    repo: string,
    signal?: AbortSignal,
  ): Promise<{
    available: boolean;
    truncated: boolean;
    paths: string[];
    sha?: string;
    rateLimit?: GitHubRateLimitMetadata;
  }> {
    if (!this.token || !isSupportedGitHubToken(this.token)) {
      logger.warn('GitHub token ausente/ inválido, não é possível obter a árvore de arquivos');
      return { available: false, truncated: false, paths: [] };
    }

    try {
      const sha = await this.getDefaultBranchSha(owner, repo, signal);
      const tree = await this.client.git.getTree({
        owner,
        repo,
        tree_sha: sha,
        recursive: 'true',
        request: { signal },
      });
      const truncated = tree.data.truncated === true;
      const paths = tree.data.tree
        .filter((node) => node.type === 'blob' && typeof node.path === 'string')
        .map((node) => node.path as string);
      if (truncated) {
        logger.warn(`Árvore de ${owner}/${repo} truncada — índice de paths considerado parcial`);
      }
      if (!truncated) githubContentIndexedTotal.labels({ source: 'tree' }).inc(paths.length);
      else githubContentIndexFailureTotal.labels({ reason: 'truncated' }).inc();
      return {
        available: !truncated,
        truncated,
        paths,
        sha,
        rateLimit: normalizeRateLimit(tree.headers),
      };
    } catch (error) {
      logger.warn(`Não foi possível obter a árvore de arquivos de ${owner}/${repo}`, {
        error: error instanceof Error ? error : undefined,
      });
      githubContentIndexFailureTotal.labels({ reason: 'api_error' }).inc();
      return { available: false, truncated: false, paths: [] };
    }
  }

  /**
   * P2-02: Fetches binary content of a file (e.g. images, PDFs) as a
   * Buffer. The regular getContent endpoint returns base64 for binary
   * files, which is fine but callers need to decode it. This method
   * does the decoding and returns a Buffer directly.
   */
  async getBinaryContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.requireToken();
    try {
      const content = await this.client.repos.getContent({
        owner,
        repo,
        path,
        ref,
        request: { signal },
      });
      const data = content.data as { content?: string; encoding?: string };
      if (data.encoding === 'base64' && data.content) {
        return Buffer.from(data.content, 'base64');
      }
      throw new Error('Content is not base64-encoded binary data');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStatus = (error as any)?.status || 'Unknown status';
      logger.error(`Erro ao buscar conteúdo binário ${owner}/${repo}/${path}`, {
        error: error instanceof Error ? error : undefined,
        context: { errorStatus, errorMessage },
      });
      throw new Error(`Failed to get binary content: [${errorStatus}] ${errorMessage}`);
    }
  }

  /**
   * P2-02: Returns the SHA of the latest commit on the default branch.
   * Useful for pinning operations to a specific commit, or for
   * detecting changes between calls.
   */
  async getDefaultBranchSha(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    this.requireToken();
    try {
      const repoData = await this.client.repos.get({ owner, repo, request: { signal } });
      const branch = repoData.data.default_branch || 'main';
      const ref = await this.client.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        request: { signal },
      });
      return ref.data.object.sha;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStatus = (error as any)?.status || 'Unknown status';
      logger.error(`Erro ao obter SHA do branch padrão de ${owner}/${repo}`, {
        error: error instanceof Error ? error : undefined,
        context: { errorStatus, errorMessage },
      });
      throw new Error(`Failed to get default branch SHA: [${errorStatus}] ${errorMessage}`);
    }
  }

  async getSafeTextContent(
    owner: string,
    repo: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<SafeGitHubTextContent> {
    try {
      const sha = await this.getDefaultBranchSha(owner, repo, signal);
      const response = await this.getRepoContentWithMetadata(owner, repo, path, sha, signal);
      if (Array.isArray(response.data)) {
        githubContentIndexFailureTotal.labels({ reason: 'directory' }).inc();
        return {
          status: 'omitted',
          path,
          reason: 'directory',
          size: null,
          sha,
          rateLimit: response.rateLimit,
        };
      }

      const file = response.data as { path?: string; size?: number; encoding?: string };
      const resolvedPath = file.path ?? path;
      const size = typeof file.size === 'number' ? file.size : null;
      if (size !== null && size > MAX_TEXT_FILE_BYTES) {
        githubContentIndexFailureTotal.labels({ reason: 'oversized' }).inc();
        return {
          status: 'omitted',
          path: resolvedPath,
          reason: 'oversized',
          size,
          sha,
          rateLimit: response.rateLimit,
        };
      }
      if (file.encoding !== 'base64') {
        githubContentIndexFailureTotal.labels({ reason: 'unsupported_encoding' }).inc();
        return {
          status: 'omitted',
          path: resolvedPath,
          reason: 'unsupported_encoding',
          size,
          sha,
          rateLimit: response.rateLimit,
        };
      }

      const bytes = await this.getBinaryContent(owner, repo, resolvedPath, sha, signal);
      if (looksBinary(resolvedPath, bytes)) {
        githubContentIndexFailureTotal.labels({ reason: 'binary' }).inc();
        return {
          status: 'omitted',
          path: resolvedPath,
          reason: 'binary',
          size: size ?? bytes.length,
          sha,
          rateLimit: response.rateLimit,
        };
      }

      githubContentIndexedTotal.labels({ source: 'file' }).inc();
      return {
        status: 'content',
        path: resolvedPath,
        content: bytes.toString('utf8'),
        size: size ?? bytes.length,
        sha,
        rateLimit: response.rateLimit,
      };
    } catch (error) {
      githubContentIndexFailureTotal.labels({ reason: 'api_error' }).inc();
      throw error;
    }
  }
}

export const gitHubService = new GitHubService();
