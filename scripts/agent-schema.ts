import { z } from 'zod';

/**
 * M-1: schema base de um agente YAML.
 *
 * Os campos são derivados dos 14 arquivos em `agents/`. Schema v1 é permissivo
 * para evitar travar o CI em variações futuras; campos com restrições realistas
 * (temperatura, max_tokens) são validados, mas `model` aceita qualquer string
 * com formato `provider/modelo` para não quebrar quando novos modelos forem
 * adicionados.
 */
export const agentSchema = z.object({
  version: z.string().min(1).describe('Versão do agente, ex.: 1.0.0'),
  name: z.string().min(1).describe('Nome legível do agente'),
  description: z.string().min(1).describe('Descrição curta do papel do agente'),
  model: z.string().min(1).describe('Modelo principal'),
  model_fallback: z.string().min(1).describe('Modelo fallback'),
  temperature: z.number().min(0).max(2).describe('Temperatura de geração entre 0 e 2'),
  max_tokens: z.number().int().positive().max(16_384).describe('Máximo de tokens, entre 1 e 16384'),
  system_prompt: z.string().min(1).describe('Prompt de sistema completo do agente'),
});

export type AgentConfig = z.infer<typeof agentSchema>;
