/**
 * Form Tools
 *
 * Ferramentas para os agentes de IA preencherem campos estruturados de formulários,
 * como o Contrato de Início de demandas, e interagirem com usuários humanos.
 */
import { z } from 'zod';
import { defineTool, registerTool, type ToolResult } from './agent-tools-registry';
import { demandRepository } from '../repositories/demand-repository';
import { refinementInteractionService } from './refinement-interaction';
import { logger } from '../utils/logger';
import {
  evaluateDemandStartContract,
  formatDemandStartContract,
  DEMAND_START_CONTRACTS,
} from '../../shared/demand-start-contract';
import type { DemandType } from '@shared/schema';
import { AgentRole } from '../../shared/agent-roles';

export const AGENT_ACCESS_ROLES: AgentRole[] = [
  AgentRole.product_owner,
  AgentRole.product_manager,
  AgentRole.scrum_master,
  AgentRole.tech_lead,
  AgentRole.qa,
];

// ============================================================
// Helpers de Parse e Update
// ============================================================

function parseContractFieldsFromDescription(
  description: string,
  type: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!description) return fields;

  const lines = description.split('\n');
  const contract = DEMAND_START_CONTRACTS[type as DemandType];
  if (!contract) return fields;

  const labelToIdMap: Record<string, string> = {};
  for (const f of contract.fields) {
    labelToIdMap[f.label.toLowerCase()] = f.id;
  }

  for (const line of lines) {
    const match = line.match(/^-\s*([^:]+):\s*(.*)$/);
    if (match) {
      const label = match[1].trim().toLowerCase();
      const val = match[2].trim();
      const fieldId = labelToIdMap[label];
      if (fieldId && val !== 'Não informado') {
        fields[fieldId] = val;
      }
    }
  }

  return fields;
}

function updateDescriptionWithContract(description: string, newContractMarkdown: string): string {
  const marker = '**Contrato Inteligente de Início**';
  const markerIdx = description.indexOf(marker);

  if (markerIdx !== -1) {
    const beforeMarker = description.substring(0, markerIdx);
    const lastDividerIdx = beforeMarker.lastIndexOf('---');
    if (lastDividerIdx !== -1) {
      return beforeMarker.substring(0, lastDividerIdx).trim() + '\n\n' + newContractMarkdown;
    }
    return beforeMarker.trim() + '\n\n' + newContractMarkdown;
  }

  return description.trim() + '\n\n' + newContractMarkdown;
}

// ============================================================
// Tool 1: get_demand_contract_status
// ============================================================

const getDemandContractStatusSchema = z.object({
  demandId: z
    .number()
    .describe('ID da demanda para ler o estado do contrato inteligente de início'),
});

const getDemandContractStatusTool = defineTool({
  name: 'get_demand_contract_status',
  description:
    'Retorna o status atual dos campos do contrato inteligente de início da demanda, destacando o que já foi preenchido e quais campos ainda estão faltando.',
  agentAccess: AGENT_ACCESS_ROLES,
  inputSchema: getDemandContractStatusSchema,
  execute: async ({
    demandId,
  }: z.infer<typeof getDemandContractStatusSchema>): Promise<ToolResult> => {
    try {
      const demand = await demandRepository.findByIdOrNull(demandId);
      if (!demand) {
        return {
          ok: false,
          error: `Demanda ${demandId} não encontrada.`,
          source: 'get_demand_contract_status',
        };
      }

      const contract = DEMAND_START_CONTRACTS[demand.type as DemandType];
      if (!contract) {
        return {
          ok: false,
          error: `Contrato inteligente não disponível para o tipo de demanda: ${demand.type}`,
          source: 'get_demand_contract_status',
        };
      }

      const existingFields = parseContractFieldsFromDescription(demand.description, demand.type);
      const readiness = evaluateDemandStartContract({
        type: demand.type,
        title: demand.title,
        description: demand.description,
        fields: existingFields,
      });

      return {
        ok: true,
        data: {
          demandId,
          demandType: demand.type,
          isComplete: readiness.isComplete,
          score: readiness.score,
          statusLabel: readiness.statusLabel,
          nextStep: readiness.nextStep,
          completedFields: readiness.completedFields.map((f) => ({
            id: f.id,
            label: f.label,
            value: existingFields[f.id],
          })),
          missingFields: readiness.missingFields.map((f) => ({
            id: f.id,
            label: f.label,
            placeholder: f.placeholder,
            description: f.description,
          })),
        },
        source: 'get_demand_contract_status',
      };
    } catch (err) {
      logger.error('get_demand_contract_status falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'get_demand_contract_status',
      };
    }
  },
});

// ============================================================
// Tool 2: submit_demand_contract_fields
// ============================================================

const submitDemandContractFieldsSchema = z.object({
  demandId: z.number().describe('ID da demanda'),
  fields: z
    .record(z.string())
    .describe('Dicionário chave/valor com dados para atualizar os campos do contrato'),
});

const submitDemandContractFieldsTool = defineTool({
  name: 'submit_demand_contract_fields',
  description:
    'Atualiza os campos do contrato inteligente de início na descrição da demanda, recalculando o score de prontidão.',
  agentAccess: AGENT_ACCESS_ROLES,
  inputSchema: submitDemandContractFieldsSchema,
  execute: async ({
    demandId,
    fields,
  }: z.infer<typeof submitDemandContractFieldsSchema>): Promise<ToolResult> => {
    try {
      const demand = await demandRepository.findByIdOrNull(demandId);
      if (!demand) {
        return {
          ok: false,
          error: `Demanda ${demandId} não encontrada.`,
          source: 'submit_demand_contract_fields',
        };
      }

      const existingFields = parseContractFieldsFromDescription(demand.description, demand.type);
      const mergedFields = { ...existingFields, ...fields };

      const readiness = evaluateDemandStartContract({
        type: demand.type,
        title: demand.title,
        description: demand.description,
        fields: mergedFields,
      });

      const newContractMarkdown = formatDemandStartContract({
        type: demand.type,
        fields: mergedFields,
        readiness,
      });

      const updatedDescription = updateDescriptionWithContract(
        demand.description,
        newContractMarkdown,
      );

      await demandRepository.update(demandId, {
        description: updatedDescription,
      });

      return {
        ok: true,
        data: {
          demandId,
          isComplete: readiness.isComplete,
          score: readiness.score,
          statusLabel: readiness.statusLabel,
          nextStep: readiness.nextStep,
        },
        source: 'submit_demand_contract_fields',
      };
    } catch (err) {
      logger.error('submit_demand_contract_fields falhou', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
        source: 'submit_demand_contract_fields',
      };
    }
  },
});

// ============================================================
// Tool 3: request_human_clarification_for_fields
// ============================================================

const requestHumanClarificationSchema = z.object({
  demandId: z.number().describe('ID da demanda associada'),
  fieldId: z
    .string()
    .describe('ID do campo do contrato inteligente que precisa de esclarecimento do usuário'),
  question: z.string().describe('Pergunta clara para ser enviada ao usuário'),
  options: z.array(z.string()).optional().describe('Opções de resposta para múltipla escolha'),
});

const requestHumanClarificationTool = defineTool({
  name: 'request_human_clarification_for_fields',
  description:
    'Pausa a execução do agente e envia uma pergunta interativa para o usuário humano a fim de resolver dúvidas ou preencher campos ausentes.',
  agentAccess: AGENT_ACCESS_ROLES,
  inputSchema: requestHumanClarificationSchema,
  execute: async ({
    demandId,
    fieldId,
    question,
    options,
  }: z.infer<typeof requestHumanClarificationSchema>): Promise<ToolResult> => {
    try {
      logger.info('Agent solicitou intervenção humana para preenchimento de campo', {
        context: { demandId, fieldId, question },
      });

      // Chama o serviço de perguntas que bloqueia/aguarda o humano resolver
      const answer = await refinementInteractionService.askQuestion(
        String(demandId),
        question,
        options,
        10 * 60 * 1000, // 10 minutos de timeout para o humano responder
      );

      return {
        ok: true,
        data: {
          fieldId,
          answer,
        },
        source: 'request_human_clarification_for_fields',
      };
    } catch (err) {
      logger.error('request_human_clarification_for_fields falhou ou estourou o timeout', {
        error: err instanceof Error ? err : undefined,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido ou timeout do usuário',
        source: 'request_human_clarification_for_fields',
      };
    }
  },
});

// ============================================================
// Registro das Ferramentas
// ============================================================

export function registerFormTools(): void {
  registerTool(getDemandContractStatusTool);
  registerTool(submitDemandContractFieldsTool);
  registerTool(requestHumanClarificationTool);
}
