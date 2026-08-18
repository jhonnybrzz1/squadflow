/**
 * Spec 008 / US5: `--validate-dataset` deve explicar o que é holdout e indicar
 * ação corretiva — "LACUNA: sem-holdout" sozinho era jargão inacionável (QA 006-01).
 */
import { describe, expect, it } from 'vitest';

import {
  formatCoverageGuidance,
  type DatasetCoverageEntry,
} from '../../server/evaluation/evaluate-agent';

function entry(agent: string, gaps: string[], holdout = 0, train = 10): DatasetCoverageEntry {
  return { agent, gaps, holdoutCount: holdout, trainCount: train };
}

describe('formatCoverageGuidance (spec 008 / US5)', () => {
  it('explica holdout, indica onde configurar e sugere dry-run quando falta holdout', () => {
    const lines = formatCoverageGuidance([entry('qa', ['sem-holdout'])], 5);
    const text = lines.join('\n');

    // (a) definição do conceito
    expect(text).toContain('Holdout é o conjunto de casos separado exclusivamente para avaliar');
    // (b) por que importa
    expect(text).toContain('nunca é injetado como exemplo few-shot');
    // (c) tamanho recomendado
    expect(text).toContain('piso para nota conclusiva: 5');
    expect(text).toContain('meta: 30+ casos/agente');
    // (d) onde configurar
    expect(text).toContain('datasets/few-shot/');
    expect(text).toContain('"split": "holdout"');
    // (e) próximo comando sugerido
    expect(text).toContain('npm run evaluate-agent -- --agent <agente> --dry-run');
  });

  it('explica sem-casos separadamente de sem-holdout (edge case do spec)', () => {
    const lines = formatCoverageGuidance(
      [entry('pm_innovation', ['sem-casos'], 0, 0), entry('qa', ['sem-holdout'])],
      5,
    );
    const text = lines.join('\n');

    expect(text).toContain('sem-casos: o agente não tem nenhum caso no dataset');
    expect(text).toContain('sem-holdout: o agente tem casos, mas nenhum reservado para medição');
  });

  it('não emite orientação quando não há lacunas', () => {
    expect(formatCoverageGuidance([entry('qa', [], 30, 40)], 5)).toEqual([]);
  });

  it('só explica os tipos de lacuna efetivamente presentes', () => {
    const text = formatCoverageGuidance([entry('qa', ['sem-holdout'])], 5).join('\n');
    expect(text).not.toContain('sem-casos:');
    expect(text).not.toContain('sem-rubrica:');
  });
});
