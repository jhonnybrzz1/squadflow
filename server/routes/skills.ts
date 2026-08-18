import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { loadSkillsLockfile, buildSkillRawUrl } from '../services/skills-lock';

const router = Router();

interface SkillView {
  id: string;
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
  targetAgents: string[];
  rawUrl: string;
}

router.get(
  '/api/skills/lockfile',
  asyncHandler(async (_req: Request, res: Response) => {
    const lockfile = await loadSkillsLockfile();
    if (!lockfile) {
      res.status(500).json({ error: 'Não foi possível carregar o catálogo de skills.' });
      return;
    }

    const skills: SkillView[] = Object.entries(lockfile.skills).map(([id, entry]) => ({
      id,
      source: entry.source,
      sourceType: entry.sourceType,
      skillPath: entry.skillPath,
      computedHash: entry.computedHash,
      targetAgents: entry.targetAgents ?? [],
      rawUrl: buildSkillRawUrl(entry),
    }));

    res.setHeader('Cache-Control', 'max-age=300');
    res.json({ version: lockfile.version, skills });
  }),
);

export default router;
