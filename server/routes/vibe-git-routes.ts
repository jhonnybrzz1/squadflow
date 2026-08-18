/**
 * Demanda #10358 T4 — integração Git OAuth com GitHub (somente leitura).
 *
 * Fluxo read-only confirmado: nenhuma rota deste módulo executa push, commit
 * ou criação de branch — apenas leitura de perfil/repos/árvore de arquivos.
 */
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  asyncHandler,
  AppError,
  ForbiddenError,
  UnauthorizedError,
} from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { assertGitConnectAllowed } from '../middleware/check-free-tier';
import { getJwtSecret } from '../utils/platform-secrets';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubUsername,
  listUserRepos,
  listRepoRootFiles,
} from '../services/github-oauth-service';
import { gitConnectionService } from '../services/git-connection-service';
import { usageCounterService } from '../services/usage-counter-service';

const router = Router();

const OAUTH_STATE_PURPOSE = 'vibe_git_oauth_state';
const OAUTH_STATE_TTL = '10m';

interface OAuthStatePayload {
  purpose: typeof OAUTH_STATE_PURPOSE;
  userId: number;
}

/**
 * Devolve a URL de consentimento do GitHub como JSON (não um 302) — uma
 * navegação de browser não carrega o header `Authorization`, então o cliente
 * precisa buscar isto via `fetch` (com o Bearer token) e só então fazer
 * `window.location.href = authorizeUrl`. O `state` assinado (CSRF + qual
 * usuário) fica embutido nessa URL, não o JWT de sessão do usuário.
 */
router.get(
  '/api/git/auth/github',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const state = jwt.sign(
      { purpose: OAUTH_STATE_PURPOSE, userId: req.platformUser!.id } satisfies OAuthStatePayload,
      getJwtSecret(),
      { expiresIn: OAUTH_STATE_TTL },
    );
    res.status(200).json({ authorizeUrl: buildAuthorizeUrl(state) });
  }),
);

/**
 * GitHub redireciona aqui sem o header Authorization — a identidade do
 * usuário vem do `state` assinado gerado acima, não de `requirePlatformAuth`.
 */
async function resolveUserFromState(state: unknown) {
  if (typeof state !== 'string' || !state) {
    throw new UnauthorizedError('state ausente ou inválido no callback do GitHub.');
  }
  let payload: OAuthStatePayload;
  try {
    payload = jwt.verify(state, getJwtSecret()) as OAuthStatePayload;
  } catch {
    throw new UnauthorizedError('state expirado ou inválido no callback do GitHub.');
  }
  if (payload.purpose !== OAUTH_STATE_PURPOSE || typeof payload.userId !== 'number') {
    throw new UnauthorizedError('state com formato inesperado no callback do GitHub.');
  }
  return payload.userId;
}

const callbackQuerySchema = z.object({
  query: z.object({
    code: z.string().min(1, 'code é obrigatório'),
    state: z.string().min(1, 'state é obrigatório'),
  }),
});

router.get(
  '/api/git/auth/github/callback',
  validateRequest(callbackQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserFromState(req.query.state);

    // Este endpoint não passa por requirePlatformAuth (o GitHub não reenvia o
    // Bearer token no redirect) — por isso chama a mesma checagem de Free Tier
    // usada pelo middleware diretamente, e converte o 403 num redirect amigável
    // em vez de um corpo JSON (a resposta aqui é sempre um redirect de browser).
    try {
      await assertGitConnectAllowed(userId);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return res.redirect('/app?git=limit_reached');
      }
      throw error;
    }

    const accessToken = await exchangeCodeForToken(req.query.code as string);
    const githubUsername = await fetchGithubUsername(accessToken);
    const { created } = await gitConnectionService.upsertConnection({
      userId,
      provider: 'github',
      accessToken,
      githubUsername,
    });
    if (created) {
      await usageCounterService.incrementConnectedRepos(userId);
    }
    res.redirect('/app?git=connected');
  }),
);

router.get(
  '/api/git/repos',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const token = await gitConnectionService.getDecryptedToken(req.platformUser!.id, 'github');
    if (!token) {
      throw new AppError('Nenhuma conexão GitHub encontrada.', 409, 'GIT_NOT_CONNECTED');
    }
    const repos = await listUserRepos(token);
    res.status(200).json({ repos });
  }),
);

router.get(
  '/api/git/repos/:owner/:repo/files',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const token = await gitConnectionService.getDecryptedToken(req.platformUser!.id, 'github');
    if (!token) {
      throw new AppError('Nenhuma conexão GitHub encontrada.', 409, 'GIT_NOT_CONNECTED');
    }
    const { owner, repo } = req.params;
    const files = await listRepoRootFiles(token, owner, repo);
    res.status(200).json({ files });
  }),
);

export default router;
