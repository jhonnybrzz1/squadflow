import { z } from 'zod';

/**
 * Spec 10020 US1: saída estruturada da reformulação assistida de uma demanda.
 * O LLM reescreve o rascunho e extrai os contratos. Zod valida/normaliza: o campo
 * crítico (descrição) é obrigatório; os arrays de contrato têm default []; chaves
 * extras são descartadas (modo strip padrão do Zod).
 *
 * Spec 10028: `title` e `contractFields` são opcionais para retrocompatibilidade
 * com clientes que só enviavam `draft` (o LLM nem sempre recebe tipo/contrato
 * suficiente para preenchê-los); `sem_contexto_repo` sinaliza quando a
 * reformulação rodou sem RAG do repositório (ver `server/services/rag-retrieval.ts`).
 */
export const reformulationResultSchema = z.object({
  descricao_reformulada: z.string().trim().min(1, 'descricao_reformulada é obrigatória'),
  criterios_aceite: z.array(z.string()).default([]),
  regras_negocio: z.array(z.string()).default([]),
  limitacoes_escopo: z.array(z.string()).default([]),
  slas: z.array(z.string()).default([]),
  title: z.string().trim().min(1).optional(),
  contractFields: z.record(z.string(), z.string()).default({}),
  sem_contexto_repo: z.boolean().default(true),
});

export type ReformulationResult = z.infer<typeof reformulationResultSchema>;

/** Spec 10028: payload estendido de POST /api/demands/reformulate. */
export const reformulateRequestSchema = z.object({
  draft: z.string(),
  title: z.string().trim().optional(),
  type: z.string().trim().optional(),
  domain: z.string().trim().optional(),
  repoFullName: z.string().trim().optional(),
  additionalRepos: z.array(z.string().trim()).optional(),
  refinementType: z.enum(['technical', 'business']).optional(),
});

export type ReformulateRequest = z.infer<typeof reformulateRequestSchema>;

/** Tamanho mínimo do rascunho para acionar a reformulação (US1 AC3). */
export const MIN_DRAFT_LENGTH = 10;

/**
 * Teto de tempo da reformulação; ao exceder, o backend responde 408 (US1 AC4).
 * Ajustado para 55s para ficar abaixo de proxies com timeout fixo em 60s
 * e permitir retry controlado no frontend.
 */
export const REFORMULATION_TIMEOUT_MS = 55_000;
