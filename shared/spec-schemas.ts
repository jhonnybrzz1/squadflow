/**
 * SpecKit Spec Schemas — fonte da verdade para a conformidade dos documentos
 * gerados pelo ciclo de refinamento (PRD e Tasks) com os templates do SpecKit.
 *
 * Demanda: "Padronizar o PRD e task e telas para o padrão exigido da speckit".
 *
 * Este módulo é a ÚNICA fonte da verdade (schemas Zod) usada para validar a
 * estrutura mínima obrigatória dos documentos. A validação síncrona com retry e
 * a flag `needs_review` vivem em server/cognitive-core/spec-conformance.ts, que
 * consome os validadores abaixo.
 *
 * MVP (2026-07-21): cobre PRD e Tasks. Telas/mockups ficam para fase posterior
 * (sem template definido) — ver "Fora do Escopo" da demanda.
 *
 * Documentos legados NÃO são migrados: os validadores aceitam os nomes de seção
 * atuais do gerador via aliases semânticos (ex.: "Problema e Oportunidade" conta
 * como "Problema"), de modo que o schema descreve a EXIGÊNCIA, não um layout fixo.
 */

import { z } from 'zod';

/**
 * Placeholders de template que NUNCA podem sobreviver num documento final.
 *
 * Restrito a marcadores inequívocos de template não substituído. NÃO inclui os
 * marcadores honestos que o pipeline emite de propósito quando falta evidência
 * (`[A DEFINIR]`, `[A MEDIR]`) — esses são conteúdo válido, não placeholder.
 */
export const FORBIDDEN_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[PREENCHER\]/i,
  /\[EXEMPLO\]/i,
  /\[FEATURE NAME\]/i,
  /\[T[íi]tulo curto\]/i,
  /\[TODO\]/i,
  /\[DATE\]/i,
  /\[###[^\]]*\]/,
];

/** Retorna os placeholders proibidos encontrados no conteúdo (deduplicados). */
export function findForbiddenPlaceholders(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of FORBIDDEN_PLACEHOLDER_PATTERNS) {
    const matches = content.match(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'),
    );
    if (matches) matches.forEach((m) => found.add(m));
  }
  return [...found];
}

/**
 * Detecta a presença de um cabeçalho `##`/`###` cujo título contém algum dos
 * termos (case/acento-insensível). Suporta prefixos de numeração e emoji
 * (`## 1. 🎯 Objetivo`), no mesmo espírito de server/utils/validateDocuments.ts.
 */
function hasHeadingWith(content: string, terms: string[]): boolean {
  const normalized = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const headingLines = content
    .split('\n')
    .filter((line) => /^#{2,4}\s+/.test(line))
    .map((line) => normalized(line));
  return headingLines.some((line) => terms.some((term) => line.includes(normalized(term))));
}

// ─── Estrutura parseada (o que o schema Zod valida) ──────────────────────────

/**
 * Representação estrutural mínima de um PRD conforme o SpecKit.
 * Critérios de aceite da demanda: seções Problema, Objetivo e Critérios de Aceite.
 */
export const PrdStructureSchema = z.object({
  hasProblema: z.literal(true, {
    errorMap: () => ({
      message: 'PRD deve conter a seção obrigatória "Problema" (ou equivalente).',
    }),
  }),
  hasObjetivo: z.literal(true, {
    errorMap: () => ({
      message: 'PRD deve conter a seção obrigatória "Objetivo" (ou equivalente).',
    }),
  }),
  hasCriteriosDeAceite: z.literal(true, {
    errorMap: () => ({
      message: 'PRD deve conter a seção obrigatória "Critérios de Aceite" (ou equivalente).',
    }),
  }),
  forbiddenPlaceholders: z
    .array(z.string())
    .max(0, { message: 'PRD contém placeholders de template não substituídos.' }),
});
export type PrdStructure = z.infer<typeof PrdStructureSchema>;

/**
 * Representação estrutural mínima de uma task individual conforme o SpecKit.
 * Estrutura mínima da demanda: ação, responsável (documento) e critério de sucesso.
 */
export const TaskStructureSchema = z.object({
  id: z.string().regex(/^T\d+$/, 'ID de task deve seguir o padrão T1, T2, ...'),
  /** A "ação": descrição imperativa do que fazer. */
  acao: z.string().min(3, 'Task deve descrever uma ação.'),
  /** "Critério de sucesso": critérios de aceite verificáveis da task. */
  hasCriterioDeSucesso: z.literal(true, {
    errorMap: () => ({ message: 'Task deve ter critério de sucesso/aceite.' }),
  }),
});
export type TaskStructure = z.infer<typeof TaskStructureSchema>;

/** Representação estrutural mínima do documento de Tasks conforme o SpecKit. */
export const TasksStructureSchema = z.object({
  /** "Responsável" no nível do documento (@time/@pessoa). */
  responsavel: z
    .string()
    .min(1, 'Documento de Tasks deve declarar um Responsável.')
    .regex(/^@[\w-]+/, 'Responsável deve seguir o padrão @nome-do-time ou @nome-pessoa.'),
  tasks: z.array(TaskStructureSchema).min(1, 'Documento de Tasks deve conter ao menos uma task.'),
  forbiddenPlaceholders: z
    .array(z.string())
    .max(0, { message: 'Documento de Tasks contém placeholders de template não substituídos.' }),
});
export type TasksStructure = z.infer<typeof TasksStructureSchema>;

// ─── Parsers markdown → estrutura ────────────────────────────────────────────

/** Extrai a estrutura de um PRD em markdown para validação pelo schema. */
export function parsePrdMarkdown(markdown: string): {
  hasProblema: boolean;
  hasObjetivo: boolean;
  hasCriteriosDeAceite: boolean;
  forbiddenPlaceholders: string[];
} {
  const content = markdown ?? '';
  return {
    hasProblema: hasHeadingWith(content, ['problema', 'contexto', 'dor', 'oportunidade']),
    hasObjetivo: hasHeadingWith(content, ['objetivo', 'decisao de produto', 'decisão de produto']),
    hasCriteriosDeAceite: hasHeadingWith(content, [
      'criterio de aceite',
      'criterios de aceite',
      'criterio de aceitacao',
      'criterios de aceitacao',
      'criterio de sucesso',
      'criterios de sucesso',
    ]),
    forbiddenPlaceholders: findForbiddenPlaceholders(content),
  };
}

/** Bloco de uma task (a partir de `**T<n>**` ou `## T<n>`) até a próxima task/heading. */
function extractTaskBlocks(content: string): Array<{ id: string; body: string }> {
  const blocks: Array<{ id: string; body: string }> = [];
  // Suporta "**T1:**", "**T1**:", "## T1 —", "### T1:"
  const taskHeadRegex = /(?:\*\*|^#{2,4}\s+)T(\d+)\b/gm;
  const heads: Array<{ id: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = taskHeadRegex.exec(content)) !== null) {
    heads.push({ id: `T${match[1]}`, index: match.index });
  }
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : content.length;
    blocks.push({ id: heads[i].id, body: content.slice(start, end) });
  }
  return blocks;
}

/** Extrai a estrutura de um documento de Tasks em markdown para validação. */
export function parseTasksMarkdown(markdown: string): {
  responsavel: string;
  tasks: Array<{ id: string; acao: string; hasCriterioDeSucesso: boolean }>;
  forbiddenPlaceholders: string[];
} {
  const content = markdown ?? '';
  const responsibleMatch = content.match(/\*\*Respons[aá]vel:?\*\*:?\s*(\S[^\n]*)/i);
  const responsavel = responsibleMatch ? responsibleMatch[1].trim() : '';

  const criterioRegex = /crit[ée]rios?\s+de\s+(aceite|sucesso|aceita[cç][aã]o)/i;
  const tasks = extractTaskBlocks(content).map(({ id, body }) => {
    // A "ação": primeira linha do bloco depois do ID, sem os metadados.
    const firstLine =
      body
        .replace(/^\s*(?:\*\*|#{2,4}\s+)T\d+\b[:*\s—-]*/, '')
        .split('\n')[0]
        ?.trim() ?? '';
    return {
      id,
      acao: firstLine.replace(/\*\*/g, '').trim(),
      hasCriterioDeSucesso: criterioRegex.test(body),
    };
  });

  return { responsavel, tasks, forbiddenPlaceholders: findForbiddenPlaceholders(content) };
}

// ─── Resultado e validadores públicos ────────────────────────────────────────

export interface SpecValidationIssue {
  field: string;
  message: string;
}

export interface SpecValidationResult {
  ok: boolean;
  issues: SpecValidationIssue[];
}

function toIssues(error: z.ZodError): SpecValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(documento)',
    message: issue.message,
  }));
}

/** Valida um PRD em markdown contra o schema SpecKit. Fonte da verdade. */
export function validateSpecKitPrd(markdown: string): SpecValidationResult {
  const parsed = parsePrdMarkdown(markdown);
  const result = PrdStructureSchema.safeParse(parsed);
  if (result.success) return { ok: true, issues: [] };
  return { ok: false, issues: toIssues(result.error) };
}

/** Valida um documento de Tasks em markdown contra o schema SpecKit. */
export function validateSpecKitTasks(markdown: string): SpecValidationResult {
  const parsed = parseTasksMarkdown(markdown);
  const result = TasksStructureSchema.safeParse(parsed);
  if (result.success) return { ok: true, issues: [] };
  return { ok: false, issues: toIssues(result.error) };
}

export type SpecDocumentKind = 'prd' | 'tasks';

/** Dispatcher por tipo de documento. */
export function validateSpecKitDocument(
  kind: SpecDocumentKind,
  markdown: string,
): SpecValidationResult {
  return kind === 'prd' ? validateSpecKitPrd(markdown) : validateSpecKitTasks(markdown);
}
