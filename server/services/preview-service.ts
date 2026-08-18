/**
 * Demanda #10366 T1/T2/T3 — serviço de preview automático de refinamento.
 *
 * Analisa a estrutura do repo GitHub conectado e gera sugestões de
 * features/melhorias via LLM, sem que o usuário digite um prompt.
 *
 * T1: Listagem de árvore via GitHub API + cache 24h + retry com backoff
 * T2: Heurística de relevância para seleção dos 50 arquivos mais relevantes
 * T3: Template de prompt + chamada OpenAI com JSON estrito
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { previewCache, previewJobs } from '@shared/schema-unified';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { gitConnectionService } from './git-connection-service';
import { openAIService } from './openai-ai';
import { usageCounterService } from './usage-counter-service';
import { subscriptionService } from './subscription-service';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/error-handler';

const CACHE_TTL_HOURS = 24;
const MAX_FILES = 50;
const MAX_FILE_SIZE = 256 * 1024; // 256KB
const GITHUB_API_BASE = 'https://api.github.com';
const BLOCKLIST_PATTERNS = [
  '.env',
  '.pem',
  '.key',
  'id_rsa',
  'credentials',
  'secrets',
  '.npmrc',
  '.netrc',
];

export interface PreviewResult {
  suggestedFeatures: string[];
  architectureNotes: string;
  potentialBugs: string[];
  estimatedEffort: string;
}

interface GitHubTreeItem {
  path: string;
  type: string;
  size?: number;
}

interface GitHubContent {
  content: string;
  encoding: string;
  size: number;
}

/** Verifica se um arquivo está na blocklist de segurança. */
function isBlocked(path: string): boolean {
  const lower = path.toLowerCase();
  return BLOCKLIST_PATTERNS.some((pattern) => {
    if (pattern.endsWith('*')) return lower.startsWith(pattern.slice(0, -1));
    return lower.includes(pattern);
  });
}

/** Heurística v1: prioriza README > entrypoints > configs > schemas > src/ */
function rankFile(path: string): number {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() ?? '';

  if (basename.startsWith('readme')) return 100;
  if (['index.', 'main.', 'app.', 'server.'].some((p) => basename.startsWith(p))) return 90;
  if (basename === 'package.json' || basename === 'tsconfig.json') return 85;
  if (basename.startsWith('.eslintrc') || basename === 'docker-compose.yml') return 80;
  if (basename.includes('schema') || basename.includes('model')) return 75;
  if (lower.startsWith('src/') && lower.split('/').length <= 3) return 70;
  if (lower.startsWith('lib/') && lower.split('/').length <= 3) return 60;
  return 50;
}

class PreviewService {
  private async ensure(): Promise<void> {
    await ensureVibePlatformSchema();
  }

  /**
   * T1: Lista a árvore do repo via GitHub API. 1 request para árvore completa.
   * Retry com backoff 2x (delays 1s/3s). Timeout 10s.
   */
  async getRepoTree(
    token: string,
    owner: string,
    repo: string,
    branch: string = 'main',
  ): Promise<GitHubTreeItem[]> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 404) {
          // Branch pode ser 'master' em repos antigos
          if (branch === 'main') return this.getRepoTree(token, owner, repo, 'master');
          throw new AppError('Repositório ou branch não encontrado.', 404, 'REPO_NOT_FOUND');
        }
        if (res.status === 403) {
          throw new AppError(
            'Rate limit do GitHub atingido. Tente novamente em alguns minutos.',
            429,
            'GITHUB_RATE_LIMIT',
          );
        }
        if (!res.ok) {
          throw new Error(`GitHub API error: ${res.status}`);
        }

        const data = (await res.json()) as { tree: GitHubTreeItem[] };
        return data.tree.filter((item) => item.type === 'blob');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (attempt < 2) {
          const delay = attempt === 0 ? 1000 : 3000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    return [];
  }

  /**
   * T2: Seleciona os 50 arquivos mais relevantes via heurística v1.
   * Ignora blocklist, binários e arquivos > 256KB.
   */
  selectRelevantFiles(tree: GitHubTreeItem[]): string[] {
    const filtered = tree.filter((item) => {
      if (isBlocked(item.path)) return false;
      if (item.size && item.size > MAX_FILE_SIZE) return false;
      // Ignorar diretórios comuns de build/dep
      const lower = item.path.toLowerCase();
      if (lower.startsWith('node_modules/') || lower.startsWith('.git/')) return false;
      if (lower.startsWith('dist/') || lower.startsWith('build/')) return false;
      return true;
    });

    // Ordenar por relevância (maior primeiro)
    const ranked = filtered
      .map((item) => ({ path: item.path, score: rankFile(item.path) }))
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, MAX_FILES).map((item) => item.path);
  }

  /**
   * Busca conteúdo de arquivos em paralelo (concorrência 5).
   */
  async fetchFileContents(
    token: string,
    owner: string,
    repo: string,
    paths: string[],
    branch: string = 'main',
  ): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const concurrency = 5;

    for (let i = 0; i < paths.length; i += concurrency) {
      const batch = paths.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (path) => {
          const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
            },
          });
          if (!res.ok) return null;
          const data = (await res.json()) as GitHubContent;
          if (data.encoding === 'base64') {
            return { path, content: Buffer.from(data.content, 'base64').toString('utf8') };
          }
          return { path, content: data.content };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          // Truncar conteúdo muito longo para respeitar orçamento de tokens
          const maxContent = 2000;
          const content = result.value.content.slice(0, maxContent);
          contents.set(result.value.path, content);
        }
      }
    }

    return contents;
  }

  /**
   * T3: Gera preview via OpenAI com JSON estrito.
   */
  async generatePreview(fileContents: Map<string, string>): Promise<PreviewResult> {
    const SYSTEM_PROMPT = `Você é um assistente de análise de repositórios para "Vibe Coders".
Analise a estrutura e código do repositório fornecido e sugira melhorias.
Devolva SOMENTE um JSON (sem markdown) com este formato exato:
{
  "suggestedFeatures": string[] (3 a 5 features/melhorias concretas),
  "architectureNotes": string (observações sobre a arquitetura atual),
  "potentialBugs": string[] (2 a 4 bugs potenciais ou code smells),
  "estimatedEffort": string (esforço estimado: "baixo", "médio" ou "alto")
}`;

    const fileSummaries = [...fileContents.entries()]
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');

    const userPrompt = `Analise o seguinte repositório e gere sugestões:\n\n${fileSummaries}`;

    const raw = await openAIService.generateChatCompletion(SYSTEM_PROMPT, userPrompt, {
      operation: 'vibe_preview',
      taskType: 'json',
      responseFormat: 'json_object',
      cache: false,
    });

    try {
      return JSON.parse(raw) as PreviewResult;
    } catch {
      throw new AppError(
        'A IA retornou uma resposta em formato inválido.',
        502,
        'PREVIEW_INVALID_JSON',
      );
    }
  }

  /**
   * Verifica cache 24h. Retorna resultado em cache se válido.
   */
  async get_cached(userId: number, owner: string, repo: string): Promise<PreviewResult | null> {
    await this.ensure();
    const now = new Date();
    const [cached] = await db
      .select()
      .from(previewCache)
      .where(
        and(
          eq(previewCache.userId, userId),
          eq(previewCache.owner, owner),
          eq(previewCache.repo, repo),
        ),
      )
      .limit(1);

    if (cached && cached.expiresAt > now) {
      return JSON.parse(cached.result) as PreviewResult;
    }
    return null;
  }

  /**
   * Salva resultado no cache com TTL 24h.
   */
  async saveToCache(
    userId: number,
    owner: string,
    repo: string,
    result: PreviewResult,
  ): Promise<void> {
    await this.ensure();
    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000);

    // Delete old cache entries for this user/repo
    await db
      .delete(previewCache)
      .where(
        and(
          eq(previewCache.userId, userId),
          eq(previewCache.owner, owner),
          eq(previewCache.repo, repo),
        ),
      );

    await db.insert(previewCache).values({
      userId,
      owner,
      repo,
      result: JSON.stringify(result),
      expiresAt,
    });
  }

  /**
   * Cria um job de preview e processa assincronamente.
   */
  async createAndProcessJob(userId: number, owner: string, repo: string): Promise<string> {
    await this.ensure();
    const jobId = randomUUID();

    // Cria job no banco
    await db.insert(previewJobs).values({
      jobId,
      userId,
      owner,
      repo,
      status: 'pending',
    });

    // Processa assincronamente (não bloqueia a resposta)
    void this.processJob(jobId, userId, owner, repo).catch((error) => {
      logger.error('Preview job falhou', {
        error: error instanceof Error ? error : undefined,
        context: { jobId, owner, repo },
      });
    });

    return jobId;
  }

  /**
   * Processa um job de preview: busca árvore, seleciona arquivos, gera preview.
   */
  private async processJob(
    jobId: string,
    userId: number,
    owner: string,
    repo: string,
  ): Promise<void> {
    await db
      .update(previewJobs)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(previewJobs.jobId, jobId));

    try {
      // Verifica cache primeiro
      const cached = await this.get_cached(userId, owner, repo);
      if (cached) {
        await db
          .update(previewJobs)
          .set({ status: 'completed', result: JSON.stringify(cached), updatedAt: new Date() })
          .where(eq(previewJobs.jobId, jobId));
        return;
      }

      // Busca token GitHub do usuário
      const token = await gitConnectionService.getDecryptedToken(userId, 'github');
      if (!token) {
        throw new AppError('GitHub não conectado.', 401, 'GITHUB_NOT_CONNECTED');
      }

      // T1: busca árvore
      const tree = await this.getRepoTree(token, owner, repo);

      // T2: seleciona 50 arquivos mais relevantes
      const relevantPaths = this.selectRelevantFiles(tree);
      if (relevantPaths.length === 0) {
        throw new AppError('Repositório não tem arquivos analisáveis.', 400, 'EMPTY_REPO');
      }

      // Busca conteúdo dos arquivos
      const contents = await this.fetchFileContents(token, owner, repo, relevantPaths);

      // T3: gera preview via LLM
      const result = await this.generatePreview(contents);

      // Salva no cache
      await this.saveToCache(userId, owner, repo, result);

      // T6: conta como 1 refinamento no Free Tier
      const activePlan = await subscriptionService.getActivePlan(userId);
      await usageCounterService.incrementRefinements(userId);

      // Atualiza job para completed
      await db
        .update(previewJobs)
        .set({ status: 'completed', result: JSON.stringify(result), updatedAt: new Date() })
        .where(eq(previewJobs.jobId, jobId));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      await db
        .update(previewJobs)
        .set({ status: 'failed', error: errorMessage, updatedAt: new Date() })
        .where(eq(previewJobs.jobId, jobId));
      throw error;
    }
  }

  /**
   * Consulta status de um job.
   */
  async getJobStatus(jobId: string): Promise<{
    status: string;
    result: PreviewResult | null;
    error: string | null;
  }> {
    await this.ensure();
    const [job] = await db.select().from(previewJobs).where(eq(previewJobs.jobId, jobId)).limit(1);

    if (!job) {
      throw new AppError('Job não encontrado.', 404, 'JOB_NOT_FOUND');
    }

    return {
      status: job.status,
      result: job.result ? (JSON.parse(job.result) as PreviewResult) : null,
      error: job.error,
    };
  }
}

export const previewService = new PreviewService();
