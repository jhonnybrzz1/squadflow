import { Router, type Request, type Response } from 'express';
import { adminAuthMiddleware } from '../middleware/auth-stub';
import { openRouterBalanceService } from '../services/openrouter-balance';

const router = Router();

router.use(adminAuthMiddleware);

router.get('/balance', async (_req: Request, res: Response) => {
  try {
    res.json(await openRouterBalanceService.getBalance());
  } catch (_) {
    res.status(500).json({ error: 'internal' });
  }
});

export default router;
