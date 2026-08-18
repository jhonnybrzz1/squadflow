/**
 * Spec 008 / US7: linguagem do PRD consistente — placeholders "[A MEDIR]" não
 * podem quebrar frases (QA 007-03: "MVP em [A MEDIR] )", "custo: ~ [A MEDIR]")
 * e o aviso de evidências não pode usar jargão ("Evidence Block declarado").
 */
import { describe, expect, it } from 'vitest';

import {
  NumericIntegrityValidator,
  polishMeasurementMarkers,
} from '../../server/services/numeric-integrity-validator';
import { PromptParser } from '../../server/services/ai-squad/prompt-parser';
import type { Demand } from '../../shared/schema';

const mockDemand = (): Demand =>
  ({
    id: 1,
    title: 'Melhoria de teste',
    description: 'Sem números na descrição.',
    type: 'melhoria',
    priority: 'media',
    status: 'processing',
    progress: 0,
    refinementType: 'technical',
    createdAt: new Date(),
  }) as never;

describe('polishMeasurementMarkers (spec 008 / US7)', () => {
  it('remove aproximadores órfãos antes do marcador', () => {
    expect(polishMeasurementMarkers('Custo de implementação: ~ [A MEDIR] no total.')).toBe(
      'Custo de implementação: [A MEDIR] no total.',
    );
    expect(polishMeasurementMarkers('aprox. [A MEDIR] de ganho')).toBe('[A MEDIR] de ganho');
  });

  it('normaliza espaços dentro de parênteses', () => {
    expect(polishMeasurementMarkers('MVP em ( [A MEDIR] ) para o time')).toBe(
      'MVP em ([A MEDIR]) para o time',
    );
    expect(polishMeasurementMarkers('(MVP em [A MEDIR] )')).toBe('(MVP em [A MEDIR])');
  });

  it('colapsa marcadores duplicados consecutivos', () => {
    expect(polishMeasurementMarkers('redução de [A MEDIR] a [A MEDIR] por sprint')).toBe(
      'redução de [A MEDIR] por sprint',
    );
  });

  it('remove parênteses esvaziados', () => {
    expect(polishMeasurementMarkers('Configurar planilha ( ) depois')).toBe(
      'Configurar planilha depois',
    );
  });

  it('não altera prosa sem marcadores', () => {
    const prose = 'Recomendação conceitual baseada em hipóteses explícitas.';
    expect(polishMeasurementMarkers(prose)).toBe(prose);
  });
});

describe('NumericIntegrityValidator modo mark — frases legíveis (spec 008 / US7)', () => {
  it('número não-ancorado dentro de parênteses não deixa pontuação quebrada', () => {
    const msg = 'Criar template no Notion (MVP em 2-3 dias) com automação (~ 40% de ganho).';
    const result = NumericIntegrityValidator.validate(msg, mockDemand(), [], 'agente', 'mark');

    expect(result.cleanPrd).not.toContain('2-3 dias');
    expect(result.cleanPrd).not.toContain('40%');
    // Sem espaço preso antes do fecha-parênteses nem "~" órfão
    expect(result.cleanPrd).not.toMatch(/\[A MEDIR\]\s+\)/);
    expect(result.cleanPrd).not.toMatch(/~\s*\[A MEDIR\]/);
  });
});

describe('Aviso de evidências sem jargão (spec 008 / US7)', () => {
  it('nota de documento sem evidências usa linguagem de produto, não "Evidence Block"', () => {
    const body = PromptParser.appendDocumentEvidenceNote('# PRD\nConteúdo.', undefined, [
      'algum issue',
    ]);

    expect(body).not.toContain('Evidence Block');
    expect(body).toContain('sem evidências verificáveis declaradas');
    expect(body).toContain('provisórias até verificação manual');
  });
});
