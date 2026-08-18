/**
 * Scrum Master Tools
 *
 * Ferramentas para o agente Scrum Master consultar métricas
 * de execução e fundamentar estimativas.
 *
 * Tools:
 * - get_execution_stats: Estatísticas de execução de demandas
 * - get_demand_metrics: Métricas agregadas de demandas
 * - get_agent_performance: Performance por agente
 * - get_completion_times: Tempos de conclusão históricos
 */
import { z } from 'zod';
import { defineTool, registerTool, type ToolResult } from './agent-tools-registry';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';

const AGENT_NAME = 'scrum_master';

// ============================================================
// Tool 1: get_execution_stats
// ============================================================

const getExecutionStatsSchema = z.object({
  days: z.number().optional().describe('Quantidade de dias para analisar (default: 30)'),
});

const getExecutionStatsTool = defineTool({
  name: 'get_execution_stats',
  description:
    'Obtém estatísticas de execução de demandas: throughput, tempo médio, taxa de conclusão. Útil para estimar capacidade e prazos.',
  agentAccess: [AGENT_NAME, 'product_manager'],
  inputSchema: getExecutionStatsSchema,
  execute: async ({ days }: z.infer<typeof getExecutionStatsSchema>): Promise<ToolResult> => {
    try {
      const daysToAnalyze = days ?? 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToAnalyze);

      const allDemands = await demandRepository.findAll();

      // Filtrar por período
      const recentDemands = allDemands.filter((d) => {
        const createdAt = d.createdAt ? new Date(d.createdAt) : null;
        return createdAt && createdAt >= cutoffDate;
      });

      // Calcular métricas
      const completed = recentDemands.filter((d) => d.status === 'completed');
      const withCompletionTime = completed.filter((d) => d.createdAt && d.completedAt);

      // Tempo médio de conclusão (em horas)
      let avgCompletionHours = 0;
      if (withCompletionTime.length > 0) {
        const totalHours = withCompletionTime.reduce((acc, d) => {
          const start = new Date(d.createdAt!).getTime();
          const end = new Date(d.completedAt!).getTime();
          return acc + (end - start) / (1000 * 60 * 60);
        }, 0);
        avgCompletionHours = totalHours / withCompletionTime.length;
      }

      // Throughput por semana
      const weeksInPeriod = Math.max(1, daysToAnalyze / 7);
      const throughputPerWeek = completed.length / weeksInPeriod;

      // Distribuição por tipo
      const byType: Record<string, number> = {};
      for (const d of recentDemands) {
        const type = d.type || 'unknown';
        byType[type] = (byType[type] || 0) + 1;
      }

      // Distribuição por prioridade
      const byPriority: Record<string, number> = {};
      for (const d of recentDemands) {
        const priority = d.priority || 'medium';
        byPriority[priority] = (byPriority[priority] || 0) + 1;
      }

      return {
        ok: true,
        data: {
          period: `${daysToAnalyze} dias`,
          totalDemands: recentDemands.length,
          completed: completed.length,
          inProgress: recentDemands.filter((d) => d.status === 'processing').length,
          error: recentDemands.filter((d) => d.status === 'error').length,
          completionRate:
            recentDemands.length > 0
              ? ((completed.length / recentDemands.length) * 100).toFixed(1) + '%'
              : 'N/A',
          avgCompletionHours: avgCompletionHours.toFixed(1),
          throughputPerWeek: throughputPerWeek.toFixed(1),
          byType,
          byPriority,
          insights: [
            avgCompletionHours > 48 ? 'Tempo médio de conclusão alto (>48h)' : null,
            throughputPerWeek < 5 ? 'Throughput baixo (<5/semana)' : null,
            byPriority['high'] > recentDemands.length * 0.5
              ? 'Muitas demandas de alta prioridade - risco de burnout'
              : null,
          ].filter(Boolean),
        },
        source: 'get_execution_stats',
      };
    } catch (err) {
      logger.error('get_execution_stats falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_execution_stats',
      };
    }
  },
});

// ============================================================
// Tool 2: get_demand_metrics
// ============================================================

const getDemandMetricsSchema = z.object({
  type: z.string().optional().describe('Filtrar por tipo de demanda'),
  domain: z.enum(['padrao']).optional().describe('Filtrar por domínio'),
});

const getDemandMetricsTool = defineTool({
  name: 'get_demand_metrics',
  description:
    'Obtém métricas agregadas de demandas: distribuição por tipo, domínio, status. Útil para planejamento de sprint.',
  agentAccess: [AGENT_NAME, 'product_manager'],
  inputSchema: getDemandMetricsSchema,
  execute: async ({
    type,
    domain,
  }: z.infer<typeof getDemandMetricsSchema>): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();

      // Filtrar
      const filtered = allDemands.filter((d) => {
        if (type && d.type !== type) return false;
        if (domain && d.domain !== domain) return false;
        return true;
      });

      // Agrupar por status
      const byStatus: Record<string, number> = {};
      for (const d of filtered) {
        const status = d.status || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
      }

      // Agrupar por agente atual (em processamento)
      const byCurrentAgent: Record<string, number> = {};
      for (const d of filtered.filter((d) => d.status === 'processing')) {
        const agent = d.currentAgent || 'unknown';
        byCurrentAgent[agent] = (byCurrentAgent[agent] || 0) + 1;
      }

      // Progresso médio das em andamento
      const inProgress = filtered.filter((d) => d.status === 'processing');
      const avgProgress =
        inProgress.length > 0
          ? inProgress.reduce((acc, d) => acc + (d.progress || 0), 0) / inProgress.length
          : 0;

      // Análise de bloqueios (erro ou stopped)
      const blocked = filtered.filter((d) => d.status === 'error' || d.status === 'stopped');

      return {
        ok: true,
        data: {
          filters: { type, domain },
          total: filtered.length,
          byStatus,
          byCurrentAgent,
          inProgressStats: {
            count: inProgress.length,
            avgProgress: avgProgress.toFixed(1) + '%',
          },
          blockedStats: {
            count: blocked.length,
            samples: blocked.slice(0, 5).map((d) => ({
              id: d.id,
              title: d.title,
              status: d.status,
            })),
          },
          planningInsights: [
            inProgress.length > 10 ? 'Muitas demandas em andamento - considerar WIP limit' : null,
            blocked.length > 5
              ? `${blocked.length} demandas bloqueadas - revisar impedimentos`
              : null,
            avgProgress < 30 && inProgress.length > 0
              ? 'Progresso médio baixo - verificar complexidade'
              : null,
          ].filter(Boolean),
        },
        source: 'get_demand_metrics',
      };
    } catch (err) {
      logger.error('get_demand_metrics falhou', { error: err instanceof Error ? err : undefined });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_demand_metrics',
      };
    }
  },
});

// ============================================================
// Tool 3: get_agent_performance
// ============================================================

const getAgentPerformanceSchema = z.object({});

const getAgentPerformanceTool = defineTool({
  name: 'get_agent_performance',
  description:
    'Analisa performance por agente: quantas demandas estão em cada etapa, gargalos identificados.',
  agentAccess: [AGENT_NAME],
  inputSchema: getAgentPerformanceSchema,
  execute: async (): Promise<ToolResult> => {
    try {
      const allDemands = await demandRepository.findAll();

      // Demandas em processamento por agente
      const inProgressByAgent: Record<string, number> = {};
      const completedByAgent: Record<string, number> = {};
      const errorByAgent: Record<string, number> = {};

      for (const d of allDemands) {
        const agent = d.currentAgent || 'unknown';

        if (d.status === 'processing') {
          inProgressByAgent[agent] = (inProgressByAgent[agent] || 0) + 1;
        } else if (d.status === 'completed') {
          completedByAgent[agent] = (completedByAgent[agent] || 0) + 1;
        } else if (d.status === 'error') {
          errorByAgent[agent] = (errorByAgent[agent] || 0) + 1;
        }
      }

      // Identificar gargalos (agentes com muitas demandas em processamento)
      const bottlenecks = Object.entries(inProgressByAgent)
        .filter(([, count]) => count > 3)
        .map(([agent, count]) => ({ agent, count }))
        .sort((a, b) => b.count - a.count);

      // Identificar agentes com alta taxa de erro
      const errorProne = Object.entries(errorByAgent)
        .filter(([agent]) => {
          const total =
            (inProgressByAgent[agent] || 0) +
            (completedByAgent[agent] || 0) +
            (errorByAgent[agent] || 0);
          const errorRate = total > 0 ? (errorByAgent[agent] || 0) / total : 0;
          return errorRate > 0.3 && total >= 3;
        })
        .map(([agent]) => agent);

      return {
        ok: true,
        data: {
          inProgressByAgent,
          completedByAgent,
          errorByAgent,
          bottlenecks,
          errorProneAgents: errorProne,
          recommendations: [
            bottlenecks.length > 0
              ? `Gargalos detectados: ${bottlenecks.map((b) => b.agent).join(', ')}`
              : null,
            errorProne.length > 0
              ? `Agentes com alta taxa de erro: ${errorProne.join(', ')}`
              : null,
          ].filter(Boolean),
        },
        source: 'get_agent_performance',
      };
    } catch (err) {
      logger.error('get_agent_performance falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_agent_performance',
      };
    }
  },
});

// ============================================================
// Tool 4: get_completion_times
// ============================================================

const getCompletionTimesSchema = z.object({
  type: z.string().optional().describe('Filtrar por tipo de demanda'),
  limit: z.number().optional().describe('Quantidade de demandas a analisar (default: 50)'),
});

const getCompletionTimesTool = defineTool({
  name: 'get_completion_times',
  description:
    'Analisa tempos de conclusão históricos por tipo de demanda. Útil para estimar prazos de novas demandas.',
  agentAccess: [AGENT_NAME, 'product_manager'],
  inputSchema: getCompletionTimesSchema,
  execute: async ({
    type,
    limit,
  }: z.infer<typeof getCompletionTimesSchema>): Promise<ToolResult> => {
    try {
      const maxAnalyze = limit ?? 50;
      const allDemands = await demandRepository.findAll();

      // Filtrar completadas com timestamps
      const completed = allDemands
        .filter((d) => {
          if (d.status !== 'completed') return false;
          if (!d.createdAt || !d.completedAt) return false;
          if (type && d.type !== type) return false;
          return true;
        })
        .slice(0, maxAnalyze);

      if (completed.length === 0) {
        return {
          ok: true,
          data: {
            message: 'Nenhuma demanda completada encontrada para análise',
            filters: { type },
          },
          source: 'get_completion_times',
        };
      }

      // Calcular tempos
      const times = completed.map((d) => {
        const start = new Date(d.createdAt!).getTime();
        const end = new Date(d.completedAt!).getTime();
        const hours = (end - start) / (1000 * 60 * 60);
        return {
          demandId: d.id,
          type: d.type,
          priority: d.priority,
          hours,
        };
      });

      // Estatísticas
      const allHours = times.map((t) => t.hours);
      const avgHours = allHours.reduce((a, b) => a + b, 0) / allHours.length;
      const sortedHours = [...allHours].sort((a, b) => a - b);
      const medianHours = sortedHours[Math.floor(sortedHours.length / 2)];
      const p90Hours = sortedHours[Math.floor(sortedHours.length * 0.9)];

      // Por tipo
      const byType: Record<string, { count: number; avgHours: number }> = {};
      for (const t of times) {
        const demandType = t.type || 'unknown';
        if (!byType[demandType]) byType[demandType] = { count: 0, avgHours: 0 };
        byType[demandType].count++;
        byType[demandType].avgHours += t.hours;
      }
      for (const [key, val] of Object.entries(byType)) {
        byType[key].avgHours = Number((val.avgHours / val.count).toFixed(1));
      }

      // Por prioridade
      const byPriority: Record<string, { count: number; avgHours: number }> = {};
      for (const t of times) {
        const priority = t.priority || 'medium';
        if (!byPriority[priority]) byPriority[priority] = { count: 0, avgHours: 0 };
        byPriority[priority].count++;
        byPriority[priority].avgHours += t.hours;
      }
      for (const [key, val] of Object.entries(byPriority)) {
        byPriority[key].avgHours = Number((val.avgHours / val.count).toFixed(1));
      }

      return {
        ok: true,
        data: {
          analyzed: completed.length,
          filters: { type },
          stats: {
            avgHours: avgHours.toFixed(1),
            medianHours: medianHours.toFixed(1),
            p90Hours: p90Hours.toFixed(1),
            minHours: Math.min(...allHours).toFixed(1),
            maxHours: Math.max(...allHours).toFixed(1),
          },
          byType,
          byPriority,
          estimationGuide: {
            conservative: p90Hours.toFixed(1) + ' horas',
            moderate: avgHours.toFixed(1) + ' horas',
            optimistic: medianHours.toFixed(1) + ' horas',
          },
        },
        source: 'get_completion_times',
      };
    } catch (err) {
      logger.error('get_completion_times falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_completion_times',
      };
    }
  },
});

// ============================================================
// Registrar Tools
// ============================================================

export function registerScrumMasterTools(): void {
  registerTool(getExecutionStatsTool);
  registerTool(getDemandMetricsTool);
  registerTool(getAgentPerformanceTool);
  registerTool(getCompletionTimesTool);

  logger.info('Scrum Master tools registradas', {
    context: {
      count: 4,
      tools: [
        'get_execution_stats',
        'get_demand_metrics',
        'get_agent_performance',
        'get_completion_times',
      ],
    },
  });
}
