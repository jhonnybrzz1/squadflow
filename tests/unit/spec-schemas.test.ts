import { describe, expect, it } from 'vitest';

import {
  findForbiddenPlaceholders,
  parsePrdMarkdown,
  parseTasksMarkdown,
  validateSpecKitPrd,
  validateSpecKitTasks,
  validateSpecKitDocument,
} from '../../shared/spec-schemas';

const CONFORMANT_PRD = `# PRD - Padronizar documentos

## 1. Problema e Oportunidade
A geração de PRD/Tasks é inconsistente com os templates.

## 2. Objetivo
Padronizar os documentos conforme o SpecKit.

## 3. Critérios de Aceite
- PRD contém Problema, Objetivo e Critérios de Aceite.
`;

const CONFORMANT_TASKS = `# Checklist De Execução - Padronizar documentos

**Versão:** 1.0.0
**Prioridade:** Alta
**Responsável:** @produto-pessoal
**Status:** Não Iniciado

## Agora
- **T1:** Criar schema Zod em shared/spec-schemas.ts
  Critérios de aceite: schema valida PRD e Tasks
  **Dependências:** Nenhuma

- **T2:** Validar de forma síncrona no cognitive-core
  Critérios de sucesso: retry até 2 e needs_review
  **Dependências:** T1
`;

describe('spec-schemas — PRD', () => {
  it('aceita PRD com Problema, Objetivo e Critérios de Aceite (via aliases)', () => {
    const result = validateSpecKitPrd(CONFORMANT_PRD);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reprova PRD sem seção de Objetivo', () => {
    const md = CONFORMANT_PRD.replace('## 2. Objetivo', '## 2. Blá');
    const result = validateSpecKitPrd(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /Objetivo/.test(i.message))).toBe(true);
  });

  it('reprova PRD sem Critérios de Aceite', () => {
    const md = CONFORMANT_PRD.replace('## 3. Critérios de Aceite', '## 3. Outra coisa');
    const result = validateSpecKitPrd(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /Crit[ée]rios de Aceite/.test(i.message))).toBe(true);
  });

  it('reprova PRD com placeholder [PREENCHER]', () => {
    const md = CONFORMANT_PRD + '\n[PREENCHER]\n';
    const result = validateSpecKitPrd(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /placeholder/i.test(i.message))).toBe(true);
  });

  it('não trata [A DEFINIR]/[A MEDIR] como placeholder proibido', () => {
    const md = CONFORMANT_PRD + '\nMétrica: [A MEDIR — sem baseline]; resposta: [A DEFINIR]\n';
    expect(validateSpecKitPrd(md).ok).toBe(true);
  });
});

describe('spec-schemas — Tasks', () => {
  it('aceita Tasks com responsável, ação e critério de sucesso', () => {
    const result = validateSpecKitTasks(CONFORMANT_TASKS);
    expect(result.ok).toBe(true);
  });

  it('parseia as tasks e a ação de cada bloco', () => {
    const parsed = parseTasksMarkdown(CONFORMANT_TASKS);
    expect(parsed.responsavel).toMatch(/^@produto-pessoal/);
    expect(parsed.tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(parsed.tasks[0].acao).toMatch(/Criar schema Zod/);
    expect(parsed.tasks.every((t) => t.hasCriterioDeSucesso)).toBe(true);
  });

  it('reprova Tasks sem responsável', () => {
    const md = CONFORMANT_TASKS.replace('**Responsável:** @produto-pessoal', '');
    const result = validateSpecKitTasks(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /Respons[aá]vel/i.test(i.message))).toBe(true);
  });

  it('reprova task sem critério de sucesso', () => {
    const md = CONFORMANT_TASKS.replace(/Critérios de aceite:.*\n/, '');
    const result = validateSpecKitTasks(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /crit[ée]rio de sucesso/i.test(i.message))).toBe(true);
  });

  it('reprova Tasks sem nenhuma task', () => {
    const md = `# Checklist\n\n**Responsável:** @time\n\n## Agora\n- nada aqui\n`;
    const result = validateSpecKitTasks(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /ao menos uma task/i.test(i.message))).toBe(true);
  });
});

describe('spec-schemas — placeholders e dispatcher', () => {
  it('findForbiddenPlaceholders deduplica e ignora marcadores honestos', () => {
    const found = findForbiddenPlaceholders('[PREENCHER] x [PREENCHER] y [EXEMPLO] z [A MEDIR]');
    expect(found.sort()).toEqual(['[EXEMPLO]', '[PREENCHER]']);
  });

  it('validateSpecKitDocument despacha por tipo', () => {
    expect(validateSpecKitDocument('prd', CONFORMANT_PRD).ok).toBe(true);
    expect(validateSpecKitDocument('tasks', CONFORMANT_TASKS).ok).toBe(true);
  });

  it('parsePrdMarkdown reporta seções detectadas', () => {
    const parsed = parsePrdMarkdown(CONFORMANT_PRD);
    expect(parsed.hasProblema).toBe(true);
    expect(parsed.hasObjetivo).toBe(true);
    expect(parsed.hasCriteriosDeAceite).toBe(true);
    expect(parsed.forbiddenPlaceholders).toEqual([]);
  });
});
