import { registry } from '../../openapi-registry';
import { insertDemandSchema, paramIdSchema } from '@shared/schema';
import { z } from 'zod';

// Registrando Schemas no Swagger para reutilização
registry.register('InsertDemand', insertDemandSchema);

// Registrando a rota de listagem (GET /api/demands)
registry.registerPath({
  method: 'get',
  path: '/api/demands',
  summary: 'Lista todas as demandas',
  description: 'Retorna a lista de demandas registradas na plataforma',
  tags: ['Demands'],
  responses: {
    200: {
      description: 'Lista de demandas recuperada com sucesso',
      content: {
        'application/json': {
          schema: z.array(z.any()), // O ideal seria criar um selectDemandSchema no futuro
        },
      },
    },
  },
});

// Registrando a rota de criação (POST /api/demands)
registry.registerPath({
  method: 'post',
  path: '/api/demands',
  summary: 'Cria uma nova demanda',
  description: 'Recebe os dados e cria uma nova demanda no banco',
  tags: ['Demands'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: insertDemandSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Demanda criada com sucesso',
    },
    400: {
      description: 'Erro de validação (ZodError)',
    },
  },
});

// Registrando a rota de busca por ID (GET /api/demands/{id})
registry.registerPath({
  method: 'get',
  path: '/api/demands/{id}',
  summary: 'Busca demanda por ID',
  tags: ['Demands'],
  request: {
    params: paramIdSchema,
  },
  responses: {
    200: {
      description: 'Demanda encontrada',
    },
    404: {
      description: 'Demanda não encontrada',
    },
  },
});
