/**
 * QA Tools
 *
 * Ferramentas para o agente QA buscar informações sobre testes,
 * qualidade e feedback de demandas anteriores.
 *
 * Tools:
 * - search_test_files: Buscar arquivos de teste no repositório
 * - get_demand_feedback: Obter feedback de demandas anteriores
 * - get_quality_metrics: Métricas de qualidade do sistema
 * - list_test_patterns: Listar padrões de teste existentes
 */
import { z } from 'zod';
import { defineTool, registerTool, type ToolResult } from './agent-tools-registry';
import { repoService } from './repo-service';
import { humanFeedbackService } from './human-feedback-service';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';

const AGENT_NAME = 'qa';

// ============================================================
// Tool 1: search_test_files
// ============================================================

const searchTestFilesSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
  pattern: z.string().optional().describe('Padrão adicional para filtrar (ex: auth, api)'),
});

const searchTestFilesTool = defineTool({
  name: 'search_test_files',
  description:
    'Busca arquivos de teste no repositório (.test.ts, .spec.ts, _test.py, etc.). Útil para entender a cobertura de testes existente e padrões usados.',
  // CRIT-17: security_specialist precisa verificar cobertura de testes de segurança.
  agentAccess: [AGENT_NAME, 'tech_lead', 'security_specialist'],
  inputSchema: searchTestFilesSchema,
  execute: async ({
    repoFullName,
    pattern,
  }: z.infer<typeof searchTestFilesSchema>): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return {
          ok: false,
          error: 'Formato inválido. Use owner/repo',
          source: 'search_test_files',
        };
      }

      const repoData = await repoService.getRepoWithFiles(owner, repo);
      if (!repoData || !repoData.files) {
        return {
          ok: false,
          error: 'Repositório não encontrado ou não indexado',
          source: 'search_test_files',
        };
      }

      // Padrões comuns de arquivos de teste
      const testPatterns = [
        /\.test\.(ts|tsx|js|jsx)$/i,
        /\.spec\.(ts|tsx|js|jsx)$/i,
        /_test\.(py|go)$/i,
        /test_.*\.py$/i,
        /.*Test\.(java|kt)$/i,
        /__tests__\//i,
        /tests?\//i,
      ];

      const testFiles = repoData.files.filter((f) => {
        const matchesTestPattern = testPatterns.some((p) => p.test(f.path));
        if (!matchesTestPattern) return false;

        if (pattern) {
          return f.path.toLowerCase().includes(pattern.toLowerCase());
        }
        return true;
      });

      // Agrupar por diretório
      const byDirectory: Record<string, string[]> = {};
      for (const file of testFiles) {
        const dir = file.path.split('/').slice(0, -1).join('/') || '/';
        if (!byDirectory[dir]) byDirectory[dir] = [];
        byDirectory[dir].push(file.filename);
      }

      // Analisar tipos de teste
      const testTypes = {
        unit: testFiles.filter((f) => /unit|\.test\.|\.spec\./i.test(f.path)).length,
        integration: testFiles.filter((f) => /integration|e2e/i.test(f.path)).length,
        component: testFiles.filter((f) => /component/i.test(f.path)).length,
      };

      return {
        ok: true,
        data: {
          totalTestFiles: testFiles.length,
          totalFiles: repoData.files.length,
          coverageEstimate:
            repoData.files.length > 0
              ? ((testFiles.length / repoData.files.length) * 100).toFixed(1) + '% (arquivos)'
              : 'N/A',
          testTypes,
          byDirectory,
          testFiles: testFiles.slice(0, 30).map((f) => ({
            path: f.path,
            language: f.language,
            size: f.size,
          })),
        },
        source: 'search_test_files',
      };
    } catch (err) {
      logger.error('search_test_files falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'search_test_files',
      };
    }
  },
});

// ============================================================
// Tool 2: get_demand_feedback
// ============================================================

const getDemandFeedbackSchema = z.object({
  demandId: z.number().optional().describe('ID específico da demanda (opcional)'),
  limit: z.number().optional().describe('Máximo de feedbacks a retornar (default: 20)'),
});

const getDemandFeedbackTool = defineTool({
  name: 'get_demand_feedback',
  description:
    'Obtém feedback de usuários sobre demandas. Útil para entender problemas recorrentes de qualidade e ajustar critérios de aceite.',
  // CRIT-17: adicionados ux_designer (precisa de feedback de UX),
  // security_specialist (contexto de segurança), pm_discovery e pm-innovation
  // (PMs exploratórios precisam de feedback para priorização).
  agentAccess: [
    AGENT_NAME,
    'product_manager',
    'ux_designer',
    'security_specialist',
    'pm_discovery',
    'pm-innovation',
  ],
  inputSchema: getDemandFeedbackSchema,
  execute: async ({
    demandId,
    limit,
  }: z.infer<typeof getDemandFeedbackSchema>): Promise<ToolResult> => {
    try {
      const maxResults = limit ?? 20;

      if (demandId) {
        // Feedback de demanda específica
        const feedbacks = await humanFeedbackService.getByDemandId(demandId);
        return {
          ok: true,
          data: {
            demandId,
            totalFeedbacks: feedbacks.length,
            feedbacks: feedbacks.slice(0, maxResults),
          },
          source: 'get_demand_feedback',
        };
      }

      // Buscar feedbacks recentes de todas as demandas
      const allDemands = await demandRepository.findAll();
      const recentDemands = allDemands.filter((d) => d.status === 'completed').slice(0, 50);

      const allFeedbacks: Array<{
        demandId: number;
        demandTitle: string | null;
        feedbackType: string;
        feedbackText: string | null;
      }> = [];

      for (const demand of recentDemands) {
        try {
          const feedbacks = await humanFeedbackService.getByDemandId(demand.id);
          for (const fb of feedbacks) {
            allFeedbacks.push({
              demandId: demand.id,
              demandTitle: demand.title,
              feedbackType: fb.feedbackType,
              feedbackText: fb.feedbackText,
            });
          }
        } catch (_) {
          // Ignorar erros individuais
        }
      }

      // Analisar padrões
      const likeCount = allFeedbacks.filter((f) => f.feedbackType === 'like').length;
      const dislikeCount = allFeedbacks.filter((f) => f.feedbackType === 'dislike').length;

      return {
        ok: true,
        data: {
          totalFeedbacks: allFeedbacks.length,
          likeCount,
          dislikeCount,
          satisfactionRate:
            allFeedbacks.length > 0
              ? ((likeCount / allFeedbacks.length) * 100).toFixed(1) + '%'
              : 'N/A',
          recentFeedbacks: allFeedbacks.slice(0, maxResults),
          insights:
            dislikeCount > likeCount
              ? ['Taxa de insatisfação alta - revisar critérios de qualidade']
              : [],
        },
        source: 'get_demand_feedback',
      };
    } catch (err) {
      logger.error('get_demand_feedback falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_demand_feedback',
      };
    }
  },
});

// ============================================================
// Tool 3: get_quality_metrics
// ============================================================

const getQualityMetricsSchema = z.object({});

const getQualityMetricsTool = defineTool({
  name: 'get_quality_metrics',
  description:
    'Obtém métricas de qualidade do sistema: taxa de sucesso, erros, retrabalho. Útil para fundamentar critérios de aceite.',
  // CRIT-17: adicionados data_analyst e financial_analyst (analisam métricas),
  // anti_overengineering (checa retrabalho/esforço), pm_discovery e pm-innovation
  // (PMs precisam de métricas para priorização).
  agentAccess: [
    AGENT_NAME,
    'product_manager',
    'scrum_master',
    'data_analyst',
    'financial_analyst',
    'anti_overengineering',
    'pm_discovery',
    'pm-innovation',
  ],
  inputSchema: getQualityMetricsSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();

      const metrics = {
        total: allDemands.length,
        completed: allDemands.filter((d) => d.status === 'completed').length,
        error: allDemands.filter((d) => d.status === 'error').length,
        stopped: allDemands.filter((d) => d.status === 'stopped').length,
        processing: allDemands.filter((d) => d.status === 'processing').length,
        withQualityGate: {
          passed: allDemands.filter((d) => d.qualityGateStatus === 'passed').length,
          failed: allDemands.filter((d) => d.qualityGateStatus === 'failed').length,
          warning: allDemands.filter((d) => d.qualityGateStatus === 'warning').length,
          notEvaluated: allDemands.filter((d) => !d.qualityGateStatus).length,
        },
        avgRevisions: 0,
        multipleRevisions: 0,
      };

      // Calcular revisões
      const revisions = allDemands.map((d) => d.revisionNumber || 0);
      metrics.avgRevisions =
        revisions.length > 0
          ? Number((revisions.reduce((a, b) => a + b, 0) / revisions.length).toFixed(2))
          : 0;
      metrics.multipleRevisions = allDemands.filter((d) => (d.revisionNumber || 0) > 1).length;

      // Calcular taxas
      const successRate = metrics.total > 0 ? (metrics.completed / metrics.total) * 100 : 0;
      const errorRate = metrics.total > 0 ? (metrics.error / metrics.total) * 100 : 0;
      const reworkRate = metrics.total > 0 ? (metrics.multipleRevisions / metrics.total) * 100 : 0;

      return {
        ok: true,
        data: {
          metrics,
          rates: {
            success: successRate.toFixed(1) + '%',
            error: errorRate.toFixed(1) + '%',
            rework: reworkRate.toFixed(1) + '%',
          },
          qualityInsights: [
            errorRate > 20 ? 'Taxa de erro alta (>20%) - revisar validações' : null,
            reworkRate > 30 ? 'Taxa de retrabalho alta (>30%) - melhorar clareza inicial' : null,
            metrics.avgRevisions > 2 ? 'Média de revisões alta - simplificar processo' : null,
            metrics.withQualityGate.failed > metrics.withQualityGate.passed
              ? 'Quality gate rejeitando mais do que aprovando'
              : null,
          ].filter(Boolean),
        },
        source: 'get_quality_metrics',
      };
    } catch (err) {
      logger.error('get_quality_metrics falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_quality_metrics',
      };
    }
  },
});

// ============================================================
// Tool 4: list_test_patterns
// ============================================================

const listTestPatternsSchema = z.object({
  repoFullName: z.string().describe('Nome completo do repositório (owner/repo)'),
});

const listTestPatternsTool = defineTool({
  name: 'list_test_patterns',
  description:
    'Analisa padrões de teste usados no repositório: frameworks, estrutura, convenções. Útil para alinhar novos testes com o padrão existente.',
  agentAccess: [AGENT_NAME],
  inputSchema: listTestPatternsSchema,
  execute: async ({
    repoFullName,
  }: z.infer<typeof listTestPatternsSchema>): Promise<ToolResult> => {
    try {
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) {
        return {
          ok: false,
          error: 'Formato inválido. Use owner/repo',
          source: 'list_test_patterns',
        };
      }

      const repoData = await repoService.getRepoWithFiles(owner, repo);
      if (!repoData || !repoData.files) {
        return { ok: false, error: 'Repositório não encontrado', source: 'list_test_patterns' };
      }

      // Detectar frameworks de teste pelo conteúdo dos arquivos
      const frameworks: Record<string, number> = {};
      const patterns: string[] = [];

      // Verificar package.json para dependências de teste
      const packageJson = repoData.files.find((f) => f.filename === 'package.json');
      if (packageJson?.content) {
        try {
          const pkg = JSON.parse(packageJson.content);
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

          if (allDeps['jest']) frameworks['Jest'] = 1;
          if (allDeps['vitest']) frameworks['Vitest'] = 1;
          if (allDeps['mocha']) frameworks['Mocha'] = 1;
          if (allDeps['@testing-library/react']) frameworks['React Testing Library'] = 1;
          if (allDeps['playwright']) frameworks['Playwright'] = 1;
          if (allDeps['cypress']) frameworks['Cypress'] = 1;
          if (allDeps['supertest']) frameworks['Supertest'] = 1;
        } catch (_) {
          // Ignorar erro de parsing
        }
      }

      // Analisar arquivos de teste para padrões
      const testFiles = repoData.files.filter((f) =>
        /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f.path),
      );

      for (const file of testFiles.slice(0, 10)) {
        if (!file.content) continue;

        // Detectar padrões comuns
        if (file.content.includes('describe(') && file.content.includes('it(')) {
          if (!patterns.includes('BDD (describe/it)')) patterns.push('BDD (describe/it)');
        }
        if (file.content.includes('test(')) {
          if (!patterns.includes('test() blocks')) patterns.push('test() blocks');
        }
        if (file.content.includes('beforeEach') || file.content.includes('afterEach')) {
          if (!patterns.includes('Setup/Teardown hooks')) patterns.push('Setup/Teardown hooks');
        }
        if (file.content.includes('mock') || file.content.includes('Mock')) {
          if (!patterns.includes('Mocking')) patterns.push('Mocking');
        }
        if (file.content.includes('render(') && file.content.includes('screen.')) {
          if (!patterns.includes('Component testing')) patterns.push('Component testing');
        }
      }

      return {
        ok: true,
        data: {
          detectedFrameworks: Object.keys(frameworks),
          testPatterns: patterns,
          testFileCount: testFiles.length,
          recommendations: [
            Object.keys(frameworks).length === 0
              ? 'Nenhum framework de teste detectado - considerar adicionar'
              : null,
            testFiles.length < 5 ? 'Poucos arquivos de teste - expandir cobertura' : null,
          ].filter(Boolean),
          sampleTestFiles: testFiles.slice(0, 5).map((f) => f.path),
        },
        source: 'list_test_patterns',
      };
    } catch (err) {
      logger.error('list_test_patterns falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'list_test_patterns',
      };
    }
  },
});

// ============================================================
// Registrar Tools
// ============================================================

export function registerQATools(): void {
  registerTool(searchTestFilesTool);
  registerTool(getDemandFeedbackTool);
  registerTool(getQualityMetricsTool);
  registerTool(listTestPatternsTool);

  logger.info('QA tools registradas', {
    context: {
      count: 4,
      tools: [
        'search_test_files',
        'get_demand_feedback',
        'get_quality_metrics',
        'list_test_patterns',
      ],
    },
  });
}
