import { describe, expect, it } from 'vitest';
import { ArtifactAdapter } from '../../server/services/artifact-adapter';
import type { RefinementOutput } from '../../server/services/ai-squad/roundtable-orchestrator';

const validOutput: RefinementOutput = {
  problema: 'Usuários não conseguem X',
  objetivo: 'Permitir que usuários façam X',
  escopo: 'Apenas o fluxo de X',
  criterios_de_aceite: ['Given ..., When ..., Then ...'],
  riscos: ['Risco de concorrência'],
  dependencias: ['API externa Y'],
  divergencias: [],
  consolidacao: 'A squad concorda que X deve ser implementado assim.',
};

const context = { demandTitle: 'Demanda de teste', demandDescription: 'desc' };

describe('ArtifactAdapter', () => {
  it('normaliza uma saída válida sem acionar fallback', () => {
    const adapter = new ArtifactAdapter();
    const result = adapter.adapt(validOutput, context);

    expect(result.adapterFallback).toBe(false);
    expect(result.artifact.objetivo).toBe(validOutput.objetivo);
    expect(result.artifact.criteriosAceite).toEqual(validOutput.criterios_de_aceite);
    expect(result.prdMarkdown).toContain('Demanda de teste');
  });

  it('usa o template sequencial quando a saída é inválida (FR-007)', () => {
    const adapter = new ArtifactAdapter();
    const result = adapter.adapt({ garbage: true }, context);

    expect(result.adapterFallback).toBe(true);
    expect(result.artifact.objetivo).toContain('Demanda de teste');
    expect(result.prdMarkdown).toContain('Demanda de teste');
  });

  it('nunca lança, mesmo com input completamente malformado', () => {
    const adapter = new ArtifactAdapter();
    expect(() => adapter.adapt(null, context)).not.toThrow();
    expect(() => adapter.adapt(undefined, context)).not.toThrow();
    expect(() => adapter.adapt('string qualquer', context)).not.toThrow();
  });
});
