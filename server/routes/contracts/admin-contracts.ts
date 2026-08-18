import { registry } from '../../openapi-registry';
import { z } from 'zod';

const configureRerankSchema = z.object({
  enabled: z.boolean().optional(),
  rerankGroupPercent: z.number().min(0).max(100).optional(),
  testId: z.string().optional(),
});

const metricsQuerySchema = z.object({
  days: z.coerce.number().min(1).max(365).optional().default(14),
});

// POST /api/admin/rerank/configure
registry.registerPath({
  method: 'post',
  path: '/api/admin/rerank/configure',
  summary: 'Configurar teste A/B de rerank',
  description: 'Configura os parâmetros do teste A/B do serviço de rerank.',
  tags: ['Admin'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: configureRerankSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Configuração atualizada com sucesso',
    },
    500: {
      description: 'Erro interno do servidor',
    },
  },
});

// GET /api/admin/metrics
registry.registerPath({
  method: 'get',
  path: '/api/admin/metrics',
  summary: 'Métricas administrativas',
  description: 'Retorna o relatório de métricas de request telemetry para os últimos N dias.',
  tags: ['Admin'],
  request: {
    query: metricsQuerySchema,
  },
  responses: {
    200: {
      description: 'Relatório de métricas recuperado com sucesso',
    },
    500: {
      description: 'Erro interno do servidor',
    },
  },
});

// GET /api/admin/classification/stats
registry.registerPath({
  method: 'get',
  path: '/api/admin/classification/stats',
  summary: 'Estatísticas de classificação',
  description: 'Retorna estatísticas de classificação de demandas.',
  tags: ['Admin'],
  responses: {
    200: {
      description: 'Estatísticas recuperadas com sucesso',
    },
  },
});
