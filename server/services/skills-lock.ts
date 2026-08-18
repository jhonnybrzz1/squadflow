import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '../utils/logger';

const skillSchema = z.object({
  source: z.string(),
  sourceType: z.string(),
  skillPath: z.string(),
  computedHash: z.string(),
  targetAgents: z.array(z.string()).optional(),
});

const lockfileSchema = z.object({
  version: z.number(),
  skills: z.record(skillSchema),
});

export type SkillLockEntry = z.infer<typeof skillSchema>;
export type SkillsLockfile = z.infer<typeof lockfileSchema>;

let cachedLockfile: SkillsLockfile | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Carrega o skills-lock.json com cache em memória por 5 minutos.
 * Falhas são logadas e retornam null (fail-open para a UI).
 */
export async function loadSkillsLockfile(): Promise<SkillsLockfile | null> {
  const now = Date.now();
  if (cachedLockfile && now - cachedAt < CACHE_TTL_MS) {
    return cachedLockfile;
  }

  try {
    const raw = await readFile('./skills-lock.json', 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = lockfileSchema.parse(parsed);
    cachedLockfile = validated;
    cachedAt = now;
    return validated;
  } catch (error) {
    logger.error('skills-lock: falha ao carregar lockfile', {
      error: error instanceof Error ? error : undefined,
    });
    return cachedLockfile;
  }
}

/**
 * Constrói a URL canônica raw.githubusercontent.com a partir de uma entrada do lockfile.
 */
export function buildSkillRawUrl(entry: SkillLockEntry): string {
  const [owner, repo] = entry.source.split('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${entry.skillPath}`;
}
