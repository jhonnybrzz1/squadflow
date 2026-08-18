import { registry } from '../../openapi-registry';
import { z } from 'zod';
import { paramIdSchema, refinementInteractionInputSchema } from '@shared/schema';

const submitForApprovalSchema = z.object({
  override: z.boolean().optional(),
  overrideJustification: z.string().optional(),
});

const checklistSchema = z.object({
  checklist: z.record(z.boolean()),
});

const approveSchema = z.object({
  reviewSnapshotId: z.string(),
  snapshotHash: z.string(),
  comments: z.string().optional(),
});

const requestChangesSchema = z.object({
  reviewSnapshotId: z.string().optional(),
  snapshotHash: z.string().optional(),
  comments: z.string().optional(),
});

// POST /api/governance/demands/{id}/submit-for-approval
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/submit-for-approval',
  summary: 'Submeter documento para aprovação',
  description:
    'Valida e submete o documento (PRD) de uma demanda para aprovação, criando um snapshot imutável de revisão.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
    body: {
      content: {
        'application/json': {
          schema: submitForApprovalSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Documento submetido com sucesso',
    },
    400: {
      description: 'Justificativa obrigatória ausente',
    },
    403: {
      description: 'Documento não atende critérios mínimos (Gating Failed)',
    },
    404: {
      description: 'Demanda não encontrada',
    },
    409: {
      description: 'Transição de estado inválida',
    },
  },
});

// POST /api/governance/demands/{id}/checklist
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/checklist',
  summary: 'Atualizar checklist de seções',
  description: 'Atualiza o checklist de seções obrigatórias de uma demanda.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
    body: {
      content: {
        'application/json': {
          schema: checklistSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Checklist atualizado com sucesso',
    },
    500: {
      description: 'Erro interno do servidor',
    },
  },
});

// POST /api/governance/demands/{id}/interactions
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/interactions',
  summary: 'Registrar interação de refinamento',
  description:
    'Registra uma interação de refinamento (PROPOSE, ACCEPT, REJECT, COMMENT) para uma demanda.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
    body: {
      content: {
        'application/json': {
          schema: refinementInteractionInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Interação registrada com sucesso',
    },
    500: {
      description: 'Erro interno do servidor',
    },
  },
});

// POST /api/governance/demands/{id}/approve
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/approve',
  summary: 'Aprovar demanda',
  description:
    'Aprova uma demanda validando o snapshot de revisão e transitando o estado para APPROVED.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
    body: {
      content: {
        'application/json': {
          schema: approveSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Demanda aprovada com sucesso',
    },
    400: {
      description: 'Snapshot inválido ou desatualizado',
    },
    404: {
      description: 'Demanda ou snapshot não encontrado',
    },
    409: {
      description: 'Transição de estado inválida',
    },
  },
});

// POST /api/governance/demands/{id}/request-changes
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/request-changes',
  summary: 'Solicitar alterações',
  description: 'Solicita alterações em uma demanda, retornando o estado para DRAFT.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
    body: {
      content: {
        'application/json': {
          schema: requestChangesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Demanda retornada para DRAFT com sucesso',
    },
    400: {
      description: 'Snapshot desatualizado',
    },
    404: {
      description: 'Demanda não encontrada',
    },
  },
});

// POST /api/governance/demands/{id}/finalize
registry.registerPath({
  method: 'post',
  path: '/api/governance/demands/{id}/finalize',
  summary: 'Finalizar demanda',
  description:
    'Finaliza uma demanda, derivando o conteúdo do snapshot aprovado e transitando o estado para FINAL.',
  tags: ['Governance'],
  request: {
    params: paramIdSchema,
  },
  responses: {
    200: {
      description: 'Demanda finalizada com sucesso',
    },
    404: {
      description: 'Demanda ou snapshot aprovado não encontrado',
    },
    409: {
      description: 'Transição de estado inválida',
    },
  },
});
