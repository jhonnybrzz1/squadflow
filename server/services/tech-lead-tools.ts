/**
 * Tech Lead Tools
 *
 * Ferramentas para o agente Tech Lead buscar informações do código
 * e fundamentar análises técnicas com dados reais.
 *
 * Tools:
 * - search_codebase: Buscar padrões no código indexado
 * - get_repo_briefing: Obter briefing técnico do repositório
 * - get_file_content: Ler conteúdo de arquivo específico
 * - list_critical_areas: Listar áreas críticas e sensíveis
 * - get_tech_stack: Obter stack tecnológica do projeto
 */
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  defineTool,
  registerTool,
  type ToolExecutionContext,
  type ToolResult,
} from './agent-tools-registry';
import { repoService } from './repo-service';
import { gitHubService } from './github';
import { logger } from '../utils/logger';
import { githubToolFallbackTotal, githubToolFailureTotal } from '../metrics';

const AGENT_NAME = 'tech_lead';

/**
 * TOOL-001/GH-002: The `repoFiles` table is never populated by any ingestion
 * path in the current codebase, so `search_codebase` and `get_file_content`
 * always returned "não indexado". To avoid silently returning empty results,
 * we fall back to the live GitHub API (search.code + repos.getContent) when
 * the indexed table has no files. If GitHub is also unavailable, we return
 * an explicit, actionable error instead of a generic "não indexado".
 *
 * GH-002 (P2-02): GitHub robustness — the tree listing may be truncated for
 * large repos (available:false), so we don't gate get_file_content on the
 * tree. Each tool calls the specific GitHub endpoint it needs directly.
 */

/** Returns true if the indexed table has files for this repo. */
async function indexedFilesOrNull(
  owner: string,
  repo: string,
): Promise<Array<{ path: string; content?: string | null; language?: string | null }> | null> {
  const repoData = await repoService.getRepoWithFiles(owner, repo);
  if (repoData && repoData.files.length > 0) {
    return repoData.files;
  }
  return null;
}

/** Check if GitHub API is usable (token present). */
function isGitHubAvailable(): boolean {
  return gitHubService.isAvailable();
}

// ============================================================
// Tool 1: search_codebase
// ============================================================

const searchCodebaseSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
  pattern: z.string().describe('Padrão de busca (nome de função, classe, variável, etc.)'),
  language: z.string().optional().describe('Filtrar por linguagem (ts, js, py, etc.)'),
  maxResults: z.number().optional().describe('Máximo de resultados (default: 10)'),
});

const searchCodebaseTool = defineTool({
  name: 'search_codebase',
  description:
    'Busca padrões no código indexado do repositório. Use para encontrar onde uma função, classe ou padrão é usado. Retorna trechos de código com contexto.',
  // CRIT-17: architect precisa buscar código para fundamentar decisões arquiteturais.
  agentAccess: [AGENT_NAME, 'qa', 'architect'],
  inputSchema: searchCodebaseSchema,
  execute: async (
    { repoFullName, pattern, language, maxResults }: z.infer<typeof searchCodebaseSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return { ok: false, error: 'Formato inválido. Use owner/repo', source: 'search_codebase' };
      }

      const limit = maxResults ?? 10;
      const files = await indexedFilesOrNull(owner, repo);

      // Indexed path: grep through file contents.
      if (files) {
        const patternLower = pattern.toLowerCase();
        const results: Array<{
          path: string;
          language: string | null;
          matches: Array<{ line: number; content: string }>;
        }> = [];

        for (const file of files) {
          if (language && file.language?.toLowerCase() !== language.toLowerCase()) {
            continue;
          }
          if (!file.content) continue;

          const lines = file.content.split('\n');
          const matches: Array<{ line: number; content: string }> = [];

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(patternLower)) {
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length - 1, i + 2);
              const context = lines.slice(start, end + 1).join('\n');
              matches.push({ line: i + 1, content: context });
            }
          }

          if (matches.length > 0) {
            results.push({
              path: file.path,
              language: file.language ?? null,
              matches: matches.slice(0, 3),
            });
          }
          if (results.length >= limit) break;
        }

        return {
          ok: true,
          data: {
            pattern,
            source: 'indexed',
            totalFiles: files.length,
            matchingFiles: results.length,
            results: results.slice(0, limit),
          },
          source: 'search_codebase',
        };
      }

      // GitHub-live path: use search.code API (we don't have file contents).
      if (!isGitHubAvailable()) {
        return {
          ok: false,
          error:
            'Repositório não indexado e GitHub token indisponível. Configure GITHUB_ACCESS_TOKEN ou indexe o repositório para usar search_codebase.',
          source: 'search_codebase',
        };
      }
      githubToolFallbackTotal.labels({ tool: 'search_codebase', source: 'github-live' }).inc();
      try {
        const search = await gitHubService.searchRepoWithMetadata(owner, repo, pattern, ctx.signal);
        const paths = search.data;
        const filtered = language
          ? paths.filter((p) => p.toLowerCase().endsWith(`.${language}`))
          : paths;
        return {
          ok: true,
          data: {
            pattern,
            source: 'github-live',
            matchingFiles: filtered.length,
            rateLimit: search.rateLimit,
            results: filtered
              .slice(0, limit)
              .map((p) => ({ path: p, language: null, matches: [] })),
          },
          source: 'search_codebase',
        };
      } catch (err) {
        githubToolFailureTotal.labels({ tool: 'search_codebase' }).inc();
        throw err;
      }
    } catch (err) {
      logger.error('search_codebase falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'search_codebase',
      };
    }
  },
});

// ============================================================
// Tool 2: get_repo_briefing
// ============================================================

const getRepoBriefingSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
});

const getRepoBriefingTool = defineTool({
  name: 'get_repo_briefing',
  description:
    'Obtém o briefing técnico do repositório: tipo de projeto, stack tecnológica, padrão arquitetural, áreas críticas e sensíveis. Útil para entender o contexto antes de analisar uma demanda.',
  // CRIT-17: architect e security_specialist precisam do briefing do repo.
  agentAccess: [
    AGENT_NAME,
    'product_manager',
    'qa',
    'scrum_master',
    'architect',
    'security_specialist',
  ],
  inputSchema: getRepoBriefingSchema,
  execute: async ({ repoFullName }: z.infer<typeof getRepoBriefingSchema>): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return {
          ok: false,
          error: 'Formato inválido. Use owner/repo',
          source: 'get_repo_briefing',
        };
      }

      const repoData = await repoService.getOrCreateRepo(owner, repo);
      if (!repoData) {
        return { ok: false, error: 'Repositório não encontrado', source: 'get_repo_briefing' };
      }

      let briefing = null;
      if (repoData.briefing) {
        try {
          briefing = JSON.parse(repoData.briefing);
        } catch (_) {
          briefing = { raw: repoData.briefing };
        }
      }

      return {
        ok: true,
        data: {
          fullName: repoData.fullName,
          description: repoData.description,
          language: repoData.language,
          size: repoData.size,
          stars: repoData.stars,
          defaultBranch: repoData.defaultBranch,
          lastCommit: repoData.lastCommit,
          lastCommitDate: repoData.lastCommitDate,
          briefing,
          briefingGeneratedAt: repoData.briefingGeneratedAt,
        },
        source: 'get_repo_briefing',
      };
    } catch (err) {
      logger.error('get_repo_briefing falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_repo_briefing',
      };
    }
  },
});

// ============================================================
// Tool 3: get_file_content
// ============================================================

const getFileContentSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
  filePath: z.string().describe('Caminho do arquivo (ex: src/services/auth.ts)'),
});

const getFileContentTool = defineTool({
  name: 'get_file_content',
  description:
    'Lê o conteúdo de um arquivo específico do repositório indexado. Use quando precisar analisar a implementação detalhada de um módulo.',
  // CRIT-17: architect precisa ler código para decisões arquiteturais.
  agentAccess: [AGENT_NAME, 'qa', 'architect'],
  inputSchema: getFileContentSchema,
  execute: async (
    { repoFullName, filePath }: z.infer<typeof getFileContentSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return { ok: false, error: 'Formato inválido. Use owner/repo', source: 'get_file_content' };
      }

      const normalizedPath = filePath.replace(/^\.\//, '');
      const files = await indexedFilesOrNull(owner, repo);

      // Indexed path: file content is in the DB.
      if (files) {
        const file = files.find(
          (f) =>
            f.path === normalizedPath || f.path === filePath || f.path.endsWith(normalizedPath),
        );

        if (!file) {
          const similar = files
            .filter((f) =>
              f.path.toLowerCase().includes(normalizedPath.toLowerCase().split('/').pop() || ''),
            )
            .slice(0, 5)
            .map((f) => f.path);

          return {
            ok: false,
            error: `Arquivo não encontrado: ${filePath}`,
            data: { suggestedFiles: similar },
            source: 'get_file_content',
          };
        }

        const maxChars = 15000;
        const content = file.content?.slice(0, maxChars) || '';
        const truncated = (file.content?.length || 0) > maxChars;

        return {
          ok: true,
          data: {
            path: file.path,
            source: 'indexed',
            language: file.language ?? null,
            content,
            truncated,
            totalLines: file.content?.split('\n').length || 0,
          },
          source: 'get_file_content',
        };
      }

      // GitHub-live path: fetch the single file via repos.getContent directly.
      // GH-002: don't gate on the tree listing — it may be truncated for large
      // repos. We only need the token to be present.
      if (!isGitHubAvailable()) {
        return {
          ok: false,
          error:
            'Repositório não indexado e GitHub token indisponível. Configure GITHUB_ACCESS_TOKEN ou indexe o repositório para usar get_file_content.',
          source: 'get_file_content',
        };
      }
      githubToolFallbackTotal.labels({ tool: 'get_file_content', source: 'github-live' }).inc();
      let safeContent;
      try {
        safeContent = await gitHubService.getSafeTextContent(
          owner,
          repo,
          normalizedPath,
          ctx.signal,
        );
      } catch (err) {
        githubToolFailureTotal.labels({ tool: 'get_file_content' }).inc();
        throw err;
      }
      if (safeContent.status === 'omitted') {
        return {
          ok: false,
          error: `Arquivo omitido (${safeContent.reason}): ${safeContent.path}`,
          data: {
            omittedFiles: [
              {
                path: safeContent.path,
                reason: safeContent.reason,
                size: safeContent.size,
              },
            ],
            sha: safeContent.sha,
            rateLimit: safeContent.rateLimit,
          },
          source: 'get_file_content',
        };
      }
      const maxChars = 15000;
      const content = safeContent.content.slice(0, maxChars);
      const truncated = safeContent.content.length > maxChars;

      return {
        ok: true,
        data: {
          path: safeContent.path,
          source: 'github-live',
          language: null,
          content,
          truncated,
          totalLines: safeContent.content.split('\n').length,
          sha: safeContent.sha,
          rateLimit: safeContent.rateLimit,
        },
        source: 'get_file_content',
      };
    } catch (err) {
      logger.error('get_file_content falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_file_content',
      };
    }
  },
});

// ============================================================
// Tool 4: list_critical_areas
// ============================================================

const listCriticalAreasSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
});

const listCriticalAreasTool = defineTool({
  name: 'list_critical_areas',
  description:
    'Lista as áreas críticas e sensíveis do repositório identificadas no briefing. Útil para saber onde ter mais cuidado ao propor mudanças.',
  // CRIT-17: architect e security_specialist precisam conhecer áreas críticas.
  agentAccess: [AGENT_NAME, 'qa', 'scrum_master', 'architect', 'security_specialist'],
  inputSchema: listCriticalAreasSchema,
  execute: async ({
    repoFullName,
  }: z.infer<typeof listCriticalAreasSchema>): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return {
          ok: false,
          error: 'Formato inválido. Use owner/repo',
          source: 'list_critical_areas',
        };
      }

      const repoData = await repoService.getOrCreateRepo(owner, repo);
      if (!repoData) {
        return { ok: false, error: 'Repositório não encontrado', source: 'list_critical_areas' };
      }

      let criticalAreas: string[] = [];
      let sensitiveAreas: string[] = [];

      if (repoData.briefing) {
        try {
          const briefing = JSON.parse(repoData.briefing);
          criticalAreas = briefing.criticalAreas || [];
          sensitiveAreas = briefing.sensitiveAreas || [];
        } catch (_) {
          // Briefing não é JSON válido
        }
      }

      // Também extrair do systemMap se disponível
      let systemMapAreas: string[] = [];
      if (repoData.systemMap) {
        const criticalMatches = repoData.systemMap.match(/\[CRÍTICO\][^\n]+/g) || [];
        const sensitiveMatches = repoData.systemMap.match(/\[SENSÍVEL\][^\n]+/g) || [];
        systemMapAreas = [...criticalMatches, ...sensitiveMatches];
      }

      return {
        ok: true,
        data: {
          criticalAreas,
          sensitiveAreas,
          systemMapAreas,
          recommendation:
            criticalAreas.length > 0 || sensitiveAreas.length > 0
              ? 'Mudanças nestas áreas requerem revisão cuidadosa e testes extensivos.'
              : 'Nenhuma área crítica identificada no briefing.',
        },
        source: 'list_critical_areas',
      };
    } catch (err) {
      logger.error('list_critical_areas falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'list_critical_areas',
      };
    }
  },
});

// ============================================================
// Tool 5: get_tech_stack
// ============================================================

const getTechStackSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
});

const getTechStackTool = defineTool({
  name: 'get_tech_stack',
  description:
    'Obtém a stack tecnológica do projeto: linguagens, frameworks, bibliotecas principais. Use para garantir que recomendações técnicas estejam alinhadas com o projeto.',
  // CRIT-17: architect e data_analyst precisam conhecer a stack do projeto.
  agentAccess: [AGENT_NAME, 'qa', 'architect', 'data_analyst'],
  inputSchema: getTechStackSchema,
  execute: async ({ repoFullName }: z.infer<typeof getTechStackSchema>): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return { ok: false, error: 'Formato inválido. Use owner/repo', source: 'get_tech_stack' };
      }

      const repoData = await repoService.getRepoWithFiles(owner, repo);
      if (!repoData) {
        return { ok: false, error: 'Repositório não encontrado', source: 'get_tech_stack' };
      }

      const { repo: repoInfo, files } = repoData;

      // Extrair do briefing
      let techStack: string[] = [];
      let architecturalPattern = 'Desconhecido';
      let projectType = 'outro';

      if (repoInfo.briefing) {
        try {
          const briefing = JSON.parse(repoInfo.briefing);
          techStack = briefing.techStack || [];
          architecturalPattern = briefing.architecturalPattern || 'Desconhecido';
          projectType = briefing.projectType || 'outro';
        } catch (_) {
          // Briefing não é JSON válido
        }
      }

      // Analisar linguagens dos arquivos
      const languageStats: Record<string, number> = {};
      if (files) {
        for (const file of files) {
          if (file.language) {
            languageStats[file.language] = (languageStats[file.language] || 0) + 1;
          }
        }
      }

      // Detectar dependências de package.json ou requirements.txt
      const dependencies: string[] = [];
      if (files) {
        const packageJson = files.find((f) => f.filename === 'package.json');
        if (packageJson?.content) {
          try {
            const pkg = JSON.parse(packageJson.content);
            dependencies.push(...Object.keys(pkg.dependencies || {}));
            dependencies.push(...Object.keys(pkg.devDependencies || {}));
          } catch (_) {
            // Ignorar erro de parsing
          }
        }
      }

      return {
        ok: true,
        data: {
          primaryLanguage: repoInfo.language,
          projectType,
          architecturalPattern,
          techStack,
          languageDistribution: languageStats,
          mainDependencies: dependencies.slice(0, 30), // Limitar
          totalFiles: files?.length || 0,
        },
        source: 'get_tech_stack',
      };
    } catch (err) {
      logger.error('get_tech_stack falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_tech_stack',
      };
    }
  },
});

// ============================================================
// Tool 6: register_tech_debt_item (Spec 10138)
// ============================================================

const TECH_DEBT_SECTION_HEADER = '## Itens Detectados por Agente';

const techDebtCategoryEnum = z.enum([
  'architecture',
  'security',
  'performance',
  'maintainability',
  'testing',
  'documentation',
  'dependency',
  'infrastructure',
  'other',
]);

const techDebtSeverityEnum = z.enum(['HIGH', 'MEDIUM', 'LOW']);

const registerTechDebtItemSchema = z.object({
  demandId: z.number().int().positive().describe('ID da demanda que originou a detecção'),
  demandTitle: z.string().min(1).describe('Título da demanda'),
  category: techDebtCategoryEnum.describe('Categoria do débito técnico'),
  severity: techDebtSeverityEnum.describe('Severidade: HIGH, MEDIUM ou LOW'),
  description: z
    .string()
    .min(10, 'Descrição deve ter no mínimo 10 caracteres')
    .describe('Descrição do débito técnico identificado'),
  location: z
    .string()
    .min(1)
    .describe('Caminho do arquivo ou área afetada (ex: server/services/ai-squad.ts)'),
});

/**
 * Spec 10138 T2/T3: monta a entrada markdown para um item de débito e computa
 * um hash curto de (category + location) para detecção de duplicação.
 */
export function buildTechDebtEntry(payload: z.infer<typeof registerTechDebtItemSchema>): {
  entry: string;
  shortHash: string;
} {
  const shortHash = createHash('sha256')
    .update(`${payload.category}|${payload.location}`)
    .digest('hex')
    .slice(0, 8);
  const detectedAt = new Date().toISOString();
  const itemId = `AGENT-DEBT-${detectedAt.replace(/[:.TZ-]/g, '').slice(0, 14)}-${shortHash}`;

  const entry = [
    `### ${itemId}`,
    '',
    `**Categoria:** ${payload.category}`,
    `**Severidade:** ${payload.severity}`,
    `**Demand ID:** ${payload.demandId}`,
    `**Demand Title:** ${payload.demandTitle}`,
    `**Localização:** ${payload.location}`,
    `**Detectado em:** ${detectedAt}`,
    '',
    payload.description,
    '',
    '---',
    '',
  ].join('\n');

  return { entry, shortHash };
}

/**
 * Spec 10138 T2: retorna o caminho do TECHNICAL_DEBT.md (raiz do repo).
 * Override via env TECH_DEBT_PATH para testes.
 */
function getTechDebtPath(): string {
  return process.env.TECH_DEBT_PATH || path.join(process.cwd(), 'TECHNICAL_DEBT.md');
}

/**
 * Spec 10138 T3: verifica se já existe item com o mesmo shortHash na seção
 * de itens detectados por agente.
 */
export function findDuplicateHash(fileContent: string, shortHash: string): string | null {
  const sectionIdx = fileContent.indexOf(TECH_DEBT_SECTION_HEADER);
  if (sectionIdx === -1) return null;
  const sectionContent = fileContent.slice(sectionIdx);
  const hashRegex = new RegExp(`AGENT-DEBT-\\d{14}-${shortHash}`);
  const match = sectionContent.match(hashRegex);
  return match ? match[0] : null;
}

/**
 * Spec 10138 T2: se a seção não existe, cria com cabeçalho.
 */
export function ensureSectionExists(fileContent: string): string {
  if (fileContent.includes(TECH_DEBT_SECTION_HEADER)) return fileContent;
  const sectionIntro = `\n\n${TECH_DEBT_SECTION_HEADER}\n\nItens de débito técnico detectados automaticamente pelo agente Tech Lead durante o refinamento de demandas. Cada item é rastreável à demanda que o originou.\n\n`;
  return fileContent + (fileContent.endsWith('\n') ? '' : '\n') + sectionIntro;
}

export const registerTechDebtItemTool = defineTool({
  name: 'register_tech_debt_item',
  description:
    'Registra um item de débito técnico identificado durante o refinamento. O item é appendado a TECHNICAL_DEBT.md na seção "Itens Detectados por Agente" com rastreabilidade à demanda de origem. Rejeita duplicatas (mesma categoria + localização).',
  agentAccess: [AGENT_NAME],
  inputSchema: registerTechDebtItemSchema,
  execute: async (
    payload: z.infer<typeof registerTechDebtItemSchema>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      const techDebtPath = getTechDebtPath();
      const { entry, shortHash } = buildTechDebtEntry(payload);

      let fileContent = '';
      if (fs.existsSync(techDebtPath)) {
        fileContent = fs.readFileSync(techDebtPath, 'utf8');
      }

      // Spec 10138 T3: detecção de duplicação.
      const duplicate = findDuplicateHash(fileContent, shortHash);
      if (duplicate) {
        return {
          ok: false,
          error: `Item duplicado: já registrado como ${duplicate}`,
          source: 'register_tech_debt_item',
        };
      }

      // Spec 10138 T2: garantir seção existe.
      const updatedContent = ensureSectionExists(fileContent) + entry;

      // Append atômico (writeFileSync é atômico em POSIX para mesmo filesystem).
      fs.writeFileSync(techDebtPath, updatedContent, 'utf8');

      logger.info('Item de débito técnico registrado', {
        context: {
          tool: 'register_tech_debt_item',
          demandId: payload.demandId,
          category: payload.category,
          severity: payload.severity,
          shortHash,
        },
      });

      return {
        ok: true,
        data: {
          itemId: `AGENT-DEBT-${shortHash}`,
          appendedAt: new Date().toISOString(),
          location: techDebtPath,
        },
        source: 'register_tech_debt_item',
      };
    } catch (err) {
      logger.error('register_tech_debt_item falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'register_tech_debt_item',
      };
    }
  },
});

// ============================================================
// Registrar Tools
// ============================================================

export function registerTechLeadTools(): void {
  registerTool(searchCodebaseTool);
  registerTool(getRepoBriefingTool);
  registerTool(getFileContentTool);
  registerTool(listCriticalAreasTool);
  registerTool(getTechStackTool);
  registerTool(registerTechDebtItemTool);

  logger.info('Tech Lead tools registradas', {
    context: {
      count: 6,
      tools: [
        'search_codebase',
        'get_repo_briefing',
        'get_file_content',
        'list_critical_areas',
        'get_tech_stack',
        'register_tech_debt_item',
      ],
    },
  });
}
