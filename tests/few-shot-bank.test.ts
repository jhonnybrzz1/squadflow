import { describe, it, expect } from 'vitest';
import {
  extractFewShotExamples,
  loadFewShotBank,
  getFewShotExamplesForAgent,
  loadStructuredFewShot,
  getStructuredFewShotForAgent,
  structuredFewShotExampleSchema,
  renderFewShotBlock,
  type FewShotExample,
  type StructuredFewShotExample,
} from '../server/services/few-shot-bank';

describe('few-shot-bank (Fase 4 / slice 1)', () => {
  describe('extractFewShotExamples', () => {
    const prompt = `Você é um agente.

# CHECKLIST
- item

# EXEMPLO CORRETO
**Análise:** algo concreto.
**Recomendação:** fazer X.

# EXEMPLO INCORRETO
"Testar tudo." Sem critério.

# REGRA DE OURO
Evidência reproduzível.`;

    it('extrai os blocos correto e incorreto, delimitados pelo próximo heading', () => {
      const { positive, negative } = extractFewShotExamples(prompt);
      expect(positive).toContain('**Análise:** algo concreto.');
      expect(positive).toContain('**Recomendação:** fazer X.');
      expect(positive).not.toContain('REGRA DE OURO');
      expect(negative).toBe('"Testar tudo." Sem critério.');
    });

    it('retorna undefined quando não há exemplos', () => {
      const { positive, negative } = extractFewShotExamples('Prompt sem exemplos.');
      expect(positive).toBeUndefined();
      expect(negative).toBeUndefined();
    });
  });

  describe('loadFewShotBank (YAMLs reais)', () => {
    const bank = loadFewShotBank();

    it('carrega exemplos de múltiplos agentes', () => {
      expect(bank.length).toBeGreaterThan(0);
      // qa.yaml tem # EXEMPLO CORRETO e # EXEMPLO INCORRETO
      const qa = getFewShotExamplesForAgent('qa', bank);
      expect(qa).toBeDefined();
      expect(qa?.positive).toBeTruthy();
      expect(qa?.negative).toBeTruthy();
    });

    it('cada entrada tem ao menos um exemplo (positivo ou negativo)', () => {
      for (const example of bank) {
        expect(Boolean(example.positive || example.negative)).toBe(true);
      }
    });
  });
});

describe('few-shot dataset estruturado (Fase 4 / slice 2)', () => {
  it('valida a tupla completa via schema', () => {
    const ok = structuredFewShotExampleSchema.safeParse({
      id: 'x-1',
      agent: 'qa',
      demand: { title: 'T', description: 'D' },
      validOutput: 'saída válida',
    });
    expect(ok.success).toBe(true);

    const bad = structuredFewShotExampleSchema.safeParse({ id: 'x-2', agent: 'qa' });
    expect(bad.success).toBe(false);
  });

  it('carrega a semente versionável de datasets/few-shot e a indexa por agente', () => {
    const dataset = loadStructuredFewShot();
    expect(dataset.length).toBeGreaterThan(0);

    const qa = getStructuredFewShotForAgent('qa', dataset);
    expect(qa.length).toBeGreaterThan(0);
    expect(qa[0].demand.title).toBeTruthy();
    expect(qa[0].validOutput).toContain('**Análise:**');
    expect(qa[0].rejectedOutput).toBeTruthy();
  });
});

describe('renderFewShotBlock (Fase 4 / slice 3)', () => {
  const structured: StructuredFewShotExample[] = [
    {
      id: 'qa-1',
      agent: 'qa',
      demand: { title: 'T', description: 'D' },
      validOutput: 'saída boa do dataset',
      rejectedOutput: 'saída ruim do dataset',
    },
  ];
  const bank: FewShotExample[] = [
    { agent: 'ux', positive: 'positivo do yaml', negative: 'negativo do yaml' },
  ];

  it('prefere o dataset estruturado quando há exemplos', () => {
    const block = renderFewShotBlock('qa', 2, structured, bank);
    expect(block).toContain('=== EXEMPLOS DE REFERÊNCIA ===');
    expect(block).toContain('EXEMPLO VÁLIDO:\nsaída boa do dataset');
    expect(block).toContain('EXEMPLO REJEITADO (não faça assim):\nsaída ruim do dataset');
  });

  it('cai para o banco extraído do YAML quando não há dataset para o agente', () => {
    const block = renderFewShotBlock('ux', 2, structured, bank);
    expect(block).toContain('positivo do yaml');
    expect(block).toContain('negativo do yaml');
  });

  it('retorna string vazia quando não há exemplo algum', () => {
    expect(renderFewShotBlock('inexistente', 2, structured, bank)).toBe('');
  });
});
