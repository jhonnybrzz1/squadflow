/**
 * Demanda 10037 — geração de fluxogramas pós-refinamento.
 * Cobre US2 (gerar), US5 (mascarar PII) e a decisão do ADR-0002
 * (nenhuma dependência de browser no servidor).
 */

import { describe, it, expect } from 'vitest';
import {
  maskPii,
  extractProcesses,
  buildFlowchart,
  validateFlowchart,
  generateFlowchart,
  ArtifactGenerationError,
  MAX_FLOWCHART_NODES,
} from '../../server/services/artifact-flowchart';

describe('maskPii (US5)', () => {
  it('mascara CPF com e sem pontuação', () => {
    expect(maskPii('cliente 123.456.789-00 aprovado')).toBe('cliente [REDACTED] aprovado');
    expect(maskPii('cliente 12345678900 aprovado')).toBe('cliente [REDACTED] aprovado');
  });

  it('mascara email', () => {
    expect(maskPii('contato dev@example.com aqui')).toBe('contato [REDACTED] aqui');
  });

  it('mascara telefone BR com e sem DDI', () => {
    expect(maskPii('ligar (11) 98765-4321')).toContain('[REDACTED]');
    expect(maskPii('ligar +55 11 98765-4321')).toContain('[REDACTED]');
  });

  it('mascara CNPJ', () => {
    expect(maskPii('empresa 12.345.678/0001-90 ativa')).toBe('empresa [REDACTED] ativa');
  });

  it('mascara chaves de API e JWT', () => {
    expect(maskPii('use sk-abcdefghij0123456789 agora')).toBe('use [REDACTED] agora');
    expect(maskPii('token tp-sk4ovzlpfwtxx2nayzipefvnyxz')).toBe('token [REDACTED]');
    expect(
      maskPii('bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNH'), // gitleaks:allow -- synthetic JWT fixture
    ).toBe('bearer [REDACTED]');
  });

  it('não altera texto sem PII', () => {
    const text = 'Refinamento concluido com tres processos mapeados';
    expect(maskPii(text)).toBe(text);
  });
});

describe('extractProcesses', () => {
  it('prefere títulos de tarefa quando existem', () => {
    const md = [
      '# PRD',
      '## Contexto',
      '### T1 — Criar endpoint',
      '### T2 — Validar entrada',
      '### T3 — Persistir resultado',
    ].join('\n');

    expect(extractProcesses(md)).toEqual([
      'Criar endpoint',
      'Validar entrada',
      'Persistir resultado',
    ]);
  });

  it('cai para cabeçalhos de seção quando não há tarefas', () => {
    const md = ['# Doc', '## Levantamento', '## Consolidação', '## Entrega'].join('\n');
    expect(extractProcesses(md)).toEqual(['Levantamento', 'Consolidação', 'Entrega']);
  });

  it('cai para lista numerada', () => {
    const md = ['Passos:', '1. Receber demanda', '2. Refinar', '3. Aprovar'].join('\n');
    expect(extractProcesses(md)).toEqual(['Receber demanda', 'Refinar', 'Aprovar']);
  });

  it('cai para lista com marcador', () => {
    const md = ['- Analisar', '- Implementar', '- Validar'].join('\n');
    expect(extractProcesses(md)).toEqual(['Analisar', 'Implementar', 'Validar']);
  });

  it('remove marcação inline dos rótulos', () => {
    const md = [
      '1. Chamar `POST /api/x`',
      '2. Validar **entrada**',
      '3. Ver [doc](http://a.b)',
    ].join('\n');
    expect(extractProcesses(md)).toEqual(['Chamar POST /api/x', 'Validar entrada', 'Ver doc']);
  });

  it('remove duplicados preservando a ordem', () => {
    const md = ['- Validar', '- Implementar', '- validar', '- Entregar'].join('\n');
    expect(extractProcesses(md)).toEqual(['Validar', 'Implementar', 'Entregar']);
  });

  it('limita a MAX_FLOWCHART_NODES', () => {
    const md = Array.from({ length: 40 }, (_, i) => `${i + 1}. Passo ${i + 1}`).join('\n');
    expect(extractProcesses(md)).toHaveLength(MAX_FLOWCHART_NODES);
  });

  it('retorna vazio quando nada é reconhecido', () => {
    expect(extractProcesses('texto corrido sem estrutura alguma')).toEqual([]);
  });

  it('exige ao menos dois passos para adotar uma estratégia', () => {
    expect(extractProcesses('## Unica secao')).toEqual([]);
  });
});

describe('buildFlowchart', () => {
  it('monta um flowchart linear', () => {
    expect(buildFlowchart(['A', 'B'])).toBe(
      ['flowchart TD', '  N0["A"]', '  N1["B"]', '  N0 --> N1'].join('\n'),
    );
  });
});

describe('validateFlowchart', () => {
  it('aceita diagrama bem formado', () => {
    expect(validateFlowchart(buildFlowchart(['A', 'B', 'C']))).toEqual({ ok: true });
  });

  it('rejeita cabeçalho ausente', () => {
    const result = validateFlowchart('N0["A"]\nN0 --> N1');
    expect(result.ok).toBe(false);
  });

  it('rejeita diagrama vazio', () => {
    expect(validateFlowchart('').ok).toBe(false);
  });

  it('rejeita diagrama sem nós', () => {
    expect(validateFlowchart('flowchart TD').ok).toBe(false);
  });

  it('rejeita aresta para nó inexistente', () => {
    const result = validateFlowchart('flowchart TD\n  N0["A"]\n  N0 --> N9');
    expect(result).toEqual({ ok: false, reason: 'aresta referencia nó inexistente: "N9"' });
  });

  it('rejeita linha não reconhecida', () => {
    expect(validateFlowchart('flowchart TD\n  N0["A"]\n  {{lixo}}').ok).toBe(false);
  });
});

describe('generateFlowchart (pipeline)', () => {
  it('gera diagrama válido a partir de um refinamento', () => {
    const md = ['### T1 — Receber demanda', '### T2 — Refinar', '### T3 — Aprovar'].join('\n');
    const result = generateFlowchart(md);

    expect(result.nodeCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(validateFlowchart(result.source)).toEqual({ ok: true });
    expect(result.source).toContain('Receber demanda');
  });

  it('mascara PII antes de o rótulo virar nó', () => {
    const md = ['1. Notificar joao@empresa.com', '2. Registrar CPF 123.456.789-00'].join('\n');
    const result = generateFlowchart(md);

    expect(result.source).not.toContain('joao@empresa.com');
    expect(result.source).not.toContain('123.456.789-00');
    expect(result.source).toContain('[REDACTED]');
  });

  it('rejeita entrada vazia', () => {
    expect(() => generateFlowchart('')).toThrow(ArtifactGenerationError);
    expect(() => generateFlowchart('   ')).toThrow(/vazio/i);
  });

  it('rejeita refinamento sem processos identificáveis', () => {
    expect(() => generateFlowchart('texto corrido sem estrutura')).toThrow(
      /não foi possível identificar processos/i,
    );
  });

  it('neutraliza caracteres com significado sintático no Mermaid', () => {
    const md = ['1. Passo com [colchete] e {chave}', '2. Passo com "aspas" e |pipe|'].join('\n');
    const result = generateFlowchart(md);

    expect(validateFlowchart(result.source)).toEqual({ ok: true });
    expect(result.source).not.toMatch(/\[colchete\]/);
  });

  it('lida com Unicode sem quebrar', () => {
    const md = ['1. Ação de refinamento 中文 🚀', '2. Conclusão'].join('\n');
    const result = generateFlowchart(md);

    expect(validateFlowchart(result.source)).toEqual({ ok: true });
    expect(result.source).toContain('Conclusão');
  });

  it('sinaliza truncamento quando excede o limite de nós', () => {
    const md = Array.from({ length: 30 }, (_, i) => `${i + 1}. Passo ${i + 1}`).join('\n');
    expect(generateFlowchart(md).truncated).toBe(true);
  });
});
