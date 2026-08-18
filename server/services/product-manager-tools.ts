/**
 * Product Manager Tools
 *
 * Ferramentas para o agente Product Manager consultar histórico
 * de demandas e aprender com decisões anteriores.
 *
 * Tools:
 * - search_similar_demands: Buscar demandas similares por descrição
 * - get_demand_history: Obter histórico completo de uma demanda
 * - get_approval_patterns: Padrões de aprovação/rejeição
 * - get_anti_overengineering_insights: Insights de intervenções passadas
 * - get_domain_stats: Estatísticas por domínio
 */
import { z } from 'zod';
import { defineTool, registerTool, type ToolResult } from './agent-tools-registry';
import { demandRepository } from '../repositories/demand-repository';
import { agentInterventionService } from './agent-intervention-service';
import { logger } from '../utils/logger';

const AGENT_NAME = 'product_manager';

// ============================================================
// Tool 1: search_similar_demands
// ============================================================

const searchSimilarDemandsSchema = z.object({
  keywords: z.string().describe('Palavras-chave para buscar (separadas por espaço)'),
  domain: z.enum(['padrao']).optional().describe('Filtrar por domínio'),
  status: z
    .enum(['processing', 'completed', 'error', 'stopped'])
    .optional()
    .describe('Filtrar por status'),
  limit: z.number().optional().describe('Máximo de resultados (default: 10)'),
});

const searchSimilarDemandsTool = defineTool({
  name: 'search_similar_demands',
  description:
    'Busca demandas similares no histórico por palavras-chave. Útil para aprender com decisões anteriores e evitar repetir erros.',
  agentAccess: [AGENT_NAME, 'scrum_master'],
  inputSchema: searchSimilarDemandsSchema,
  execute: async ({
    keywords,
    domain,
    status,
    limit,
  }: z.infer<typeof searchSimilarDemandsSchema>): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();
      const keywordList = keywords.toLowerCase().split(/\s+/);
      const maxResults = limit ?? 10;

      // Filtrar e pontuar demandas
      const scored = allDemands
        .filter((d) => {
          if (domain && d.domain !== domain) return false;
          if (status && d.status !== status) return false;
          return true;
        })
        .map((d) => {
          const text = `${d.title || ''} ${d.description || ''}`.toLowerCase();
          const score = keywordList.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
          return { demand: d, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      const results = scored.map(({ demand, score }) => ({
        id: demand.id,
        title: demand.title,
        type: demand.type,
        domain: demand.domain,
        status: demand.status,
        priority: demand.priority,
        completedAt: demand.completedAt,
        relevanceScore: score,
        descriptionPreview: demand.description?.slice(0, 200),
      }));

      return {
        ok: true,
        data: {
          keywords,
          totalFound: results.length,
          results,
        },
        source: 'search_similar_demands',
      };
    } catch (err) {
      logger.error('search_similar_demands falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'search_similar_demands',
      };
    }
  },
});

// ============================================================
// Tool 2: get_demand_history
// ============================================================

const getDemandHistorySchema = z.object({
  demandId: z.number().describe('ID da demanda'),
});

const getDemandHistoryTool = defineTool({
  name: 'get_demand_history',
  description:
    'Obtém o histórico completo de uma demanda: interações de refinamento, feedback, status, e artefatos gerados. Útil para entender o contexto de decisões anteriores.',
  agentAccess: [AGENT_NAME, 'scrum_master', 'qa'],
  inputSchema: getDemandHistorySchema,
  execute: async ({ demandId }: z.infer<typeof getDemandHistorySchema>): Promise<ToolResult> => {
    try {
      const demand = await demandRepository.findById(demandId);
      if (!demand) {
        return {
          ok: false,
          error: `Demanda ${demandId} não encontrada`,
          source: 'get_demand_history',
        };
      }

      // Extrair interações de refinamento
      let refinementInteractions: unknown[] = [];
      if (demand.refinementInteractions) {
        try {
          refinementInteractions =
            typeof demand.refinementInteractions === 'string'
              ? JSON.parse(demand.refinementInteractions)
              : demand.refinementInteractions;
        } catch (_) {
          // Ignorar erro de parsing
        }
      }

      // Extrair learning log
      let learningLog: unknown[] = [];
      if (demand.learningLog) {
        try {
          learningLog =
            typeof demand.learningLog === 'string'
              ? JSON.parse(demand.learningLog)
              : demand.learningLog;
        } catch (_) {
          // Ignorar erro de parsing
        }
      }

      return {
        ok: true,
        data: {
          id: demand.id,
          title: demand.title,
          type: demand.type,
          domain: demand.domain,
          status: demand.status,
          priority: demand.priority,
          progress: demand.progress,
          currentAgent: demand.currentAgent,
          createdAt: demand.createdAt,
          completedAt: demand.completedAt,
          documentState: demand.documentState,
          requiresApproval: demand.requiresApproval,
          requiresHumanReview: demand.requiresHumanReview,
          refinementType: demand.refinementType,
          refinementInteractionsCount: refinementInteractions.length,
          refinementInteractions: refinementInteractions.slice(-10), // Últimas 10
          learningLog: learningLog.slice(-5), // Últimos 5
          artifacts: {
            prdUrl: demand.prdUrl,
            tddUrl: demand.tddUrl,
            tasksUrl: demand.tasksUrl,
          },
          qualityGateStatus: demand.qualityGateStatus,
          revisionNumber: demand.revisionNumber,
        },
        source: 'get_demand_history',
      };
    } catch (err) {
      logger.error('get_demand_history falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_demand_history',
      };
    }
  },
});

// ============================================================
// Tool 3: get_approval_patterns
// ============================================================

const getApprovalPatternsSchema = z.object({
  domain: z.enum(['padrao']).optional().describe('Filtrar por domínio'),
  limit: z.number().optional().describe('Quantidade de demandas a analisar (default: 50)'),
});

const getApprovalPatternsTool = defineTool({
  name: 'get_approval_patterns',
  description:
    'Analisa padrões de aprovação/rejeição de demandas. Mostra quais tipos de demanda têm mais sucesso e quais enfrentam mais retrabalho.',
  agentAccess: [AGENT_NAME],
  inputSchema: getApprovalPatternsSchema,
  execute: async ({
    domain,
    limit,
  }: z.infer<typeof getApprovalPatternsSchema>): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();
      const maxAnalyze = limit ?? 50;

      // Filtrar demandas completadas
      const demands = allDemands
        .filter((d) => {
          if (domain && d.domain !== domain) return false;
          return d.status === 'completed' || d.status === 'error' || d.status === 'stopped';
        })
        .slice(0, maxAnalyze);

      // Calcular estatísticas
      const stats = {
        total: demands.length,
        completed: demands.filter((d) => d.status === 'completed').length,
        error: demands.filter((d) => d.status === 'error').length,
        stopped: demands.filter((d) => d.status === 'stopped').length,
        byType: {} as Record<string, { total: number; completed: number }>,
        byDomain: {} as Record<string, { total: number; completed: number }>,
        avgRevisions: 0,
        withApproval: demands.filter((d) => d.requiresApproval).length,
        withHumanReview: demands.filter((d) => d.requiresHumanReview).length,
      };

      // Por tipo
      for (const d of demands) {
        const type = d.type || 'unknown';
        if (!stats.byType[type]) stats.byType[type] = { total: 0, completed: 0 };
        stats.byType[type].total++;
        if (d.status === 'completed') stats.byType[type].completed++;
      }

      // Por domínio
      for (const d of demands) {
        const dom = d.domain || 'padrao';
        if (!stats.byDomain[dom]) stats.byDomain[dom] = { total: 0, completed: 0 };
        stats.byDomain[dom].total++;
        if (d.status === 'completed') stats.byDomain[dom].completed++;
      }

      // Média de revisões
      const revisions = demands.map((d) => d.revisionNumber || 0);
      stats.avgRevisions =
        revisions.length > 0 ? revisions.reduce((a, b) => a + b, 0) / revisions.length : 0;

      return {
        ok: true,
        data: {
          analyzed: demands.length,
          stats,
          successRate:
            stats.total > 0 ? ((stats.completed / stats.total) * 100).toFixed(1) + '%' : 'N/A',
          insights: [
            stats.avgRevisions > 1.5
              ? 'Alto índice de revisões - considere melhorar clareza inicial'
              : null,
            stats.error > stats.total * 0.2 ? 'Taxa de erro elevada - revisar processo' : null,
            stats.withHumanReview > stats.total * 0.5
              ? 'Muitas demandas requerem revisão humana'
              : null,
          ].filter(Boolean),
        },
        source: 'get_approval_patterns',
      };
    } catch (err) {
      logger.error('get_approval_patterns falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_approval_patterns',
      };
    }
  },
});

// ============================================================
// Tool 4: get_anti_overengineering_insights
// ============================================================

const getAntiOverengineeringInsightsSchema = z.object({
  months: z.number().optional().describe('Quantidade de meses para analisar (default: 3)'),
});

const getAntiOverengineeringInsightsTool = defineTool({
  name: 'get_anti_overengineering_insights',
  description:
    'Obtém insights das intervenções do agente anti-overengineering: quanto esforço foi economizado, padrões de escopo excessivo, ROI das intervenções.',
  agentAccess: [AGENT_NAME, 'scrum_master'],
  inputSchema: getAntiOverengineeringInsightsSchema,
  execute: async ({
    months,
  }: z.infer<typeof getAntiOverengineeringInsightsSchema>): Promise<ToolResult> => {
    try {
      // Obter métricas mensais do serviço
      const monthlyMetrics = await agentInterventionService.getMonthlyMetrics(months ?? 3);

      if (monthlyMetrics.totalInterventions === 0) {
        return {
          ok: true,
          data: {
            available: false,
            message: 'Nenhuma intervenção anti-overengineering registrada ainda.',
            recommendation: 'Continue coletando dados para obter insights.',
          },
          source: 'get_anti_overengineering_insights',
        };
      }

      return {
        ok: true,
        data: {
          available: true,
          summary: {
            totalInterventions: monthlyMetrics.totalInterventions,
            totalDiasEconomizados: monthlyMetrics.totalDiasEconomizados,
            overridesCount: monthlyMetrics.overridesCount,
          },
          monthlyBreakdown: monthlyMetrics.interventionsByMonth,
          insights: [
            'Use estas métricas para calibrar estimativas de esforço.',
            'Padrões de overengineering ajudam a identificar armadilhas comuns.',
            monthlyMetrics.overridesCount > monthlyMetrics.totalInterventions * 0.3
              ? 'Alta taxa de override - revisar critérios do agente anti-overengineering.'
              : null,
          ].filter(Boolean),
        },
        source: 'get_anti_overengineering_insights',
      };
    } catch (err) {
      logger.error('get_anti_overengineering_insights falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_anti_overengineering_insights',
      };
    }
  },
});

// ============================================================
// Tool 5: get_domain_stats
// ============================================================

const getDomainStatsSchema = z.object({});

const getDomainStatsTool = defineTool({
  name: 'get_domain_stats',
  description:
    'Obtém estatísticas de demandas por domínio. Útil para entender a distribuição de trabalho e complexidade por área.',
  agentAccess: [AGENT_NAME, 'scrum_master'],
  inputSchema: getDomainStatsSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();

      const domainStats: Record<
        string,
        {
          total: number;
          completed: number;
          inProgress: number;
          error: number;
          avgProgress: number;
          types: Record<string, number>;
        }
      > = {};

      for (const d of allDemands) {
        const domain = d.domain || 'padrao';
        if (!domainStats[domain]) {
          domainStats[domain] = {
            total: 0,
            completed: 0,
            inProgress: 0,
            error: 0,
            avgProgress: 0,
            types: {},
          };
        }

        domainStats[domain].total++;
        if (d.status === 'completed') domainStats[domain].completed++;
        else if (d.status === 'processing') domainStats[domain].inProgress++;
        else if (d.status === 'error') domainStats[domain].error++;

        domainStats[domain].avgProgress += d.progress || 0;

        const type = d.type || 'unknown';
        domainStats[domain].types[type] = (domainStats[domain].types[type] || 0) + 1;
      }

      // Calcular médias
      for (const domain of Object.keys(domainStats)) {
        if (domainStats[domain].total > 0) {
          domainStats[domain].avgProgress = Math.round(
            domainStats[domain].avgProgress / domainStats[domain].total,
          );
        }
      }

      return {
        ok: true,
        data: {
          totalDemands: allDemands.length,
          byDomain: domainStats,
          insights: Object.entries(domainStats)
            .filter(([, stats]) => stats.error > stats.total * 0.3)
            .map(([domain]) => `Domínio ${domain} tem alta taxa de erro`),
        },
        source: 'get_domain_stats',
      };
    } catch (err) {
      logger.error('get_domain_stats falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_domain_stats',
      };
    }
  },
});

// ============================================================
// Registrar Tools
// ============================================================

export function registerProductManagerTools(): void {
  registerTool(searchSimilarDemandsTool);
  registerTool(getDemandHistoryTool);
  registerTool(getApprovalPatternsTool);
  registerTool(getAntiOverengineeringInsightsTool);
  registerTool(getDomainStatsTool);

  logger.info('Product Manager tools registradas', {
    context: {
      count: 5,
      tools: [
        'search_similar_demands',
        'get_demand_history',
        'get_approval_patterns',
        'get_anti_overengineering_insights',
        'get_domain_stats',
      ],
    },
  });
}
