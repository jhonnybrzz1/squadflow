import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError, NotFoundError } from '../middleware/error-handler';
import { gitHubService } from '../services/github';
import { githubReposCache } from '../services/github-repos-cache';
import { repoService } from '../services/repo-service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Converte falhas da API do GitHub em AppError preservando o status 500
 * historicamente retornado por estas rotas (FR-011), com errorCode de
 * serviço externo para tradução amigável no cliente.
 */
function toGitHubError(error: unknown, message: string): AppError {
  const originalMessage = error instanceof Error ? error.message : 'Unknown error';
  const originalStatus = (error as { status?: number | string })?.status;
  return new AppError(message, 500, 'EXTERNAL_SERVICE_ERROR', {
    serviceName: 'github',
    originalMessage,
    originalStatus,
  });
}

router.get(
  '/api/github/me',
  asyncHandler(async (_req: Request, res: Response) => {
    let response;
    try {
      response = await gitHubService.client.users.getAuthenticated();
    } catch (error) {
      throw toGitHubError(error, 'Falha ao obter usuário autenticado do GitHub');
    }
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ login: response.data.login || null });
  }),
);

router.get(
  '/api/github/repos',
  asyncHandler(async (_req: Request, res: Response) => {
    const cachedRepos = githubReposCache.get();
    if (cachedRepos) {
      const stats = githubReposCache.getStats();
      res.set('Cache-Control', 'private, max-age=300');
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-TTL-Ms', String(stats.ttlMs));
      return res.json(cachedRepos);
    }

    logger.debug('Buscando repositórios do usuário via API GitHub');
    let repos;
    try {
      repos = await gitHubService.listUserRepos();
    } catch (error) {
      throw toGitHubError(
        error,
        'Failed to fetch repositories. This may be due to GitHub token permissions or connection issues.',
      );
    }
    githubReposCache.set(repos);
    logger.info(`Repositórios GitHub obtidos com sucesso`, { context: { count: repos.length } });
    res.set('Cache-Control', 'private, max-age=300');
    res.set('X-Cache', 'MISS');
    res.json(repos);
  }),
);

router.get(
  '/api/github/repos/:owner/:repo/content',
  asyncHandler(async (req: Request, res: Response) => {
    const { owner, repo } = req.params;
    const path = (req.query.path as string) || '';
    logger.debug(`Buscando conteúdo do repositório ${owner}/${repo}/${path}`);
    let content;
    try {
      content = await gitHubService.getSafeTextContent(owner, repo, path);
    } catch (error) {
      throw toGitHubError(
        error,
        'Failed to fetch repository content. Check repository visibility and token permissions.',
      );
    }
    logger.debug(`Conteúdo obtido com sucesso para ${owner}/${repo}/${path}`);
    if (content.status === 'omitted') {
      throw new AppError(
        `GitHub content omitted: ${content.reason}`,
        422,
        'UNPROCESSABLE_CONTENT',
        {
          omittedFiles: [{ path: content.path, reason: content.reason, size: content.size }],
          sha: content.sha,
          rateLimit: content.rateLimit,
        },
      );
    }
    res.json(content);
  }),
);

router.post(
  '/api/github/search-files',
  asyncHandler(async (req: Request, res: Response) => {
    const searchSchema = z.object({
      owner: z.string().min(1, 'Owner is required'),
      repo: z.string().min(1, 'Repo is required'),
      query: z.string().min(1, 'Query is required'),
    });

    const payload = searchSchema.parse(req.body);
    const results = await gitHubService.searchRepoWithMetadata(
      payload.owner,
      payload.repo,
      payload.query,
    );
    res.json({ results: results.data, rateLimit: results.rateLimit });
  }),
);

router.get(
  '/api/github/repos/:owner/:repo',
  asyncHandler(async (req: Request, res: Response) => {
    const { owner, repo } = req.params;

    const result = await repoService.getRepoWithFiles(owner, repo);
    if (!result) {
      throw new NotFoundError('Repository', `${owner}/${repo}`);
    }

    res.json({
      repo: result.repo,
      files: result.files,
      fileCount: result.files.length,
    });
  }),
);

export default router;
