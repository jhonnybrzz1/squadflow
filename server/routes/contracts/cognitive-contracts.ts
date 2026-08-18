import { registry } from '../../openapi-registry';
import { z } from 'zod';
import { insertDemandSchema } from '@shared/schema';

const cognitiveDemandSchema = insertDemandSchema.extend({
  task_type: z.enum(['simple', 'intermediate', 'complex', 'critical', 'unknown']).optional(),
  githubRepoOwner: z.string().optional(),
  githubRepoName: z.string().optional(),
  refinementType: z.enum(['technical', 'business']).nullable().optional(),
});

// POST /api/demands/cognitive
registry.registerPath({
  method: 'post',
  path: '/api/demands/cognitive',
  summary: 'Criar demanda com processamento cognitivo',
  description:
    'Cria uma nova demanda e inicia o processamento cognitivo com agentes de IA, permitindo anexos e contexto de repositório GitHub.',
  tags: ['Cognitive'],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: cognitiveDemandSchema,
        },
        'application/json': {
          schema: cognitiveDemandSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Demanda criada e processamento iniciado',
    },
    400: {
      description: 'Erro de validação dos dados da demanda',
    },
    500: {
      description: 'Erro interno do servidor',
    },
  },
});
