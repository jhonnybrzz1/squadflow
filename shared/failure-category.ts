/**
 * Demanda 10089 (item 2) — causa técnica obrigatória ao encerrar uma demanda
 * em `stopped`/`error`.
 *
 * A retrospectiva mostrou demandas paradas sem causa registrada, o que impede
 * diagnóstico posterior. O enum é fechado de propósito: texto livre vira ruído e
 * não agrega. `OUTRO` existe como escape, mas exige detalhe — senão seria só um
 * jeito de burlar a categorização.
 */
import { z } from 'zod';

export const FAILURE_CATEGORIES = [
  'ESCOPO_EXPANDIDO',
  'BLOQUEIO_INTEGRACAO',
  'FALHA_VALIDACAO',
  'DADOS_INVALIDOS',
  'RECURSO_EXCEDIDO',
  'OUTRO',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

/** Rótulos em PT-BR para a UI (o enum em si é estável e não traduzido). */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  ESCOPO_EXPANDIDO: 'Escopo expandiu durante a execução',
  BLOQUEIO_INTEGRACAO: 'Bloqueio de integração/dependência externa',
  FALHA_VALIDACAO: 'Falhou na validação/QA',
  DADOS_INVALIDOS: 'Dados de entrada inválidos ou insuficientes',
  RECURSO_EXCEDIDO: 'Recurso excedido (tempo, custo, limite de provedor)',
  OUTRO: 'Outro (detalhar)',
};

/**
 * Payload da causa técnica. `otherDetail` é obrigatório **apenas** quando a
 * categoria é `OUTRO` — validado no schema, não no handler, para a regra viver
 * junto do tipo.
 */
export const failureReasonSchema = z
  .object({
    failureCategory: failureCategorySchema,
    otherDetail: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.failureCategory !== 'OUTRO' || !!v.otherDetail, {
    message: "otherDetail é obrigatório quando failureCategory é 'OUTRO'",
    path: ['otherDetail'],
  });

export type FailureReason = z.infer<typeof failureReasonSchema>;
