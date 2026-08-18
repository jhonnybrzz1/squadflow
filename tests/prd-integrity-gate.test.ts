import { describe, it, expect } from 'vitest';
import { contextBuilder } from '../server/services/context-builder';
import { PromptParser } from '../server/services/ai-squad/prompt-parser';
import { NumericIntegrityValidator } from '../server/services/numeric-integrity-validator';
import {
  applyEvidenceIntegrityPrompt,
  EVIDENCE_INTEGRITY_PROMPT_SUFFIX,
} from '../server/services/ai-squad/AgentFactory';
import { Demand, ChatMessage } from '@shared/schema';
import { z } from 'zod';

describe('PRD Integrity and Evidence Gate Tests - P2', () => {
  describe('extractFreeTextFileReferences', () => {
    it('should return [] for "usar 2/3 e 5/5, ligado/desligado"', () => {
      const text = 'usar 2/3 e 5/5, ligado/desligado';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toEqual([]);
    });

    it('should return ["server/services/ai-squad.ts"] for "ver server/services/ai-squad.ts"', () => {
      const text = 'ver server/services/ai-squad.ts';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toEqual(['server/services/ai-squad.ts']);
    });

    it('should ignore candidates if no segment contains letters (e.g. 3/5)', () => {
      const text = 'Esta operacao tem precisao de 3/5 ou 2.0/3.0.';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toEqual([]);
    });

    it('should ignore common denylisted Portuguese expressions with slashes', () => {
      const text = 'Sistema de entrada/saída ligado/desligado e fluxo sim/não.';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toEqual([]);
    });

    it('should extract valid directories starting with known root dirs', () => {
      const text = 'Verifique sob server/services/ e client/src/ para detalhes.';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toContain('server/services/');
      expect(references).toContain('client/src/');
      expect(references).toHaveLength(2);
    });

    it('should ignore directories that do not start with a known root dir', () => {
      const text = 'Verifique sob outra/pasta/ ou invalid/dir/ para detalhes.';
      const references = (contextBuilder as any).extractFreeTextFileReferences(text);
      expect(references).toEqual([]);
    });
  });
});

describe('PRD Integrity and Evidence Gate Tests - P1', () => {
  describe('NumericIntegrityValidator', () => {
    const demand: Demand = {
      id: 123,
      title: 'Melhorar onboarding de clientes',
      description: 'Queremos reduzir o tempo de onboarding de 10 dias para 2 dias.',
      type: 'melhoria',
      priority: 'alta',
      status: 'processing',
      progress: 0,
      refinementType: 'business',
      createdAt: new Date(),
    };

    const refinementMessages: ChatMessage[] = [
      {
        id: '1',
        agent: 'qa',
        message: 'Identifiquei que 40% das falhas de onboarding ocorrem por falta de documentação.',
        timestamp: new Date().toISOString(),
        type: 'completed',
      },
    ];

    it('should preserve numbers that are anchored in the user input or squad discussion', () => {
      const prdMarkdown = `# PRD - onboarding
## Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Tempo onboarding | 10 dias | 2 dias | Logs do sistema |
| Falhas onboarding | 40% | 5% | Logs de erro |
`;

      const result = NumericIntegrityValidator.validate(prdMarkdown, demand, refinementMessages);
      expect(result.cleanPrd).toContain('40%');
      expect(result.cleanPrd).toContain('Definir após baseline');
      expect(result.removedCount).toBe(1);
    });

    it('Fase 3: registra a provenance de cada claim numérico no ledger', () => {
      const prdMarkdown = `# PRD - onboarding
## Métricas
A taxa de falhas é de 40% segundo o QA, mas o ROI de 4:1 não tem base.
`;
      const result = NumericIntegrityValidator.validate(prdMarkdown, demand, refinementMessages);

      // 40% está ancorado na mensagem do QA -> mantido, com provenance registrada
      const anchored = result.ledger.find((c) => c.value.includes('40%'));
      expect(anchored?.anchored).toBe(true);
      expect(anchored?.action).toBe('kept');
      expect(anchored?.anchoredBy).toContain('40%');

      // 4:1 não aparece em nenhuma fonte -> removido, sem provenance
      const fabricated = result.ledger.find((c) => c.value.includes('4:1'));
      expect(fabricated?.anchored).toBe(false);
      expect(fabricated?.action).toBe('removed');
      expect(fabricated?.anchoredBy).toBeUndefined();
    });

    it('Fase 3: não ancora dígito isolado contido em número maior na fonte (fix do falso-positivo)', () => {
      const demandLocal: Demand = {
        ...demand,
        title: 'Conversão',
        description: 'Meta de 500 usuários ativos no ano de 2025.',
      };
      const prdMarkdown = `# PRD
## Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---|---|---|---|
| Conversão | 5 por dia | 50 por dia | Logs |
`;
      const result = NumericIntegrityValidator.validate(prdMarkdown, demandLocal, []);

      // "5"/"50" só aparecem DENTRO de "500"/"2025" na fonte: com substring (bug
      // antigo) seriam ancorados; com fronteira numérica são marcados.
      expect(result.cleanPrd).toContain('A MEDIR — sem baseline');
      const baselineClaim = result.ledger.find((c) => c.field === 'baseline');
      expect(baselineClaim?.anchored).toBe(false);
      expect(baselineClaim?.action).toBe('marked');
    });

    it('should remove fabricated ROI formats in prose', () => {
      const prdMarkdown = `# PRD - onboarding
## ROI
O ROI esperado para esta iniciativa é de 4:1 com tempo estimado de 2 semanas.
`;

      const result = NumericIntegrityValidator.validate(prdMarkdown, demand, refinementMessages);
      expect(result.cleanPrd).not.toContain('4:1');
      expect(result.cleanPrd).not.toContain('2 semanas');
      expect(result.removedCount).toBe(2);
    });

    it('Fase 3: não ancora número da prosa contido em número maior na fonte (fronteira na prosa)', () => {
      const demandLocal: Demand = {
        ...demand,
        title: 'Prazo',
        description: 'O prazo combinado com o cliente é de 12 semanas.',
      };
      const prdMarkdown = `# PRD
## Prazo
A entrega será em 2 semanas conforme alinhado.
`;
      const result = NumericIntegrityValidator.validate(prdMarkdown, demandLocal, []);

      // "2 semanas" só aparece DENTRO de "12 semanas" na fonte: substring (bug antigo)
      // ancoraria; com fronteira numérica é removido.
      expect(result.cleanPrd).not.toContain('2 semanas');
      const claim = result.ledger.find((c) => c.value.includes('2 semanas'));
      expect(claim?.anchored).toBe(false);
      expect(claim?.action).toBe('removed');
    });

    it('should remove fabricated monetary formats in prose', () => {
      const prdMarkdown = `# PRD - onboarding
## Custo de Atraso
A cada dia de atraso, perdemos $0.50 por usuário.
`;

      const result = NumericIntegrityValidator.validate(prdMarkdown, demand, refinementMessages);
      expect(result.cleanPrd).not.toContain('$0.50');
      expect(result.cleanPrd).toContain('perdemos por usuário');
      expect(result.removedCount).toBe(1);
    });
  });
});

describe('PRD Integrity and Evidence Gate Tests - P3', () => {
  describe('PromptParser.enforceReadinessGate', () => {
    it('should downgrade to "Pronta para instrumentar" if baseline is A MEDIR and howToMeasure is not defined', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | A MEDIR | 10% | a definir |
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 0);
      expect(updated).toContain('- **Status:** Pronta para instrumentar');
    });

    it('should downgrade to "Pronta após baseline" if baseline is A MEDIR and howToMeasure IS defined', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | A MEDIR | 10% | Logs do Mixpanel |
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 0);
      expect(updated).toContain('- **Status:** Pronta após baseline');
    });

    it('should downgrade to "Pronta para detalhar" if there are open decisions in the body', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.

## 4. Escopo
Para a integracao, usaremos o backend da [A DEFINIR] para autenticacao.
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 0);
      expect(updated).toContain('- **Status:** Pronta para detalhar');
    });

    it('should downgrade to "Pronta para detalhar" if there are open questions in section 2', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.
- **Perguntas abertas:** Qual o limite de rate limiting correto?
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 0);
      expect(updated).toContain('- **Status:** Pronta para detalhar');
    });

    it('should downgrade to "Pronta para detalhar" if there are removed numbers (removedCount > 0)', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 1);
      expect(updated).toContain('- **Status:** Pronta para detalhar');
    });

    it('should preserve "Pronta" status if all conditions are satisfied', () => {
      const prdMarkdown = `# PRD - onboarding
## 2. Prontidão Da Demanda
- **Status:** Pronta
- **Por que:** Refinada.
- **Perguntas abertas:** Nenhuma que bloqueie a execução imediata.

## 8. Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | 10% | 20% | Logs do Mixpanel |
`;
      const updated = PromptParser.enforceReadinessGate(prdMarkdown, 0);
      expect(updated).toContain('- **Status:** Pronta');
    });
  });
});

describe('PRD Integrity and Evidence Gate Tests - Frente B (Redução na Fonte)', () => {
  describe('applyEvidenceIntegrityPrompt', () => {
    it('should inject the evidence integrity prompt suffix into system prompt', () => {
      const systemPrompt = 'Você é um agente prestador de serviços.';
      const result = applyEvidenceIntegrityPrompt(systemPrompt);
      expect(result).toContain(EVIDENCE_INTEGRITY_PROMPT_SUFFIX);
    });

    it('should be idempotent and not duplicate prompt suffix if run multiple times', () => {
      const systemPrompt = 'Você é um agente prestador de serviços.';
      const firstRun = applyEvidenceIntegrityPrompt(systemPrompt);
      const secondRun = applyEvidenceIntegrityPrompt(firstRun);
      expect(secondRun).toEqual(firstRun);

      // Conta ocorrências do sufixo
      const occurrences = (secondRun?.match(/REGRA DE INTEGRIDADE NUMÉRICA/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('AgentMessageSchema with evidence_for_numbers', () => {
    const AgentMessageSchema = z.object({
      type: z
        .enum(['response', 'divergence', 'question', 'support'])
        .transform((type) => (type === 'support' ? 'response' : type)),
      content: z.string(),
      response_to: z.string().optional(),
      references: z.array(z.string()).optional(),
      evidence_for_numbers: z.string().optional(),
    });

    it('should parse messages with evidence_for_numbers successfully', () => {
      const msg = {
        type: 'response',
        content: 'Temos 80% de precisão nos testes.',
        evidence_for_numbers: 'qa.yaml restrições',
      };
      const parsed = AgentMessageSchema.safeParse(msg);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.evidence_for_numbers).toBe('qa.yaml restrições');
    });

    it('should parse messages without evidence_for_numbers successfully', () => {
      const msg = {
        type: 'response',
        content: 'Apenas uma mensagem sem números.',
      };
      const parsed = AgentMessageSchema.safeParse(msg);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.evidence_for_numbers).toBeUndefined();
    });
  });
});

describe('NumericIntegrityValidator.verifyDeclaredProvenance (Fase 3 / slice 5)', () => {
  const demand: Demand = {
    id: 7,
    title: 'Onboarding',
    description: 'Queremos reduzir o tempo de onboarding de 10 dias para 2 dias.',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
  };
  const refinementMessages: ChatMessage[] = [
    {
      id: '1',
      agent: 'qa',
      message: 'Identifiquei que 40% das falhas de onboarding ocorrem por falta de documentação.',
      timestamp: new Date().toISOString(),
      type: 'completed',
    },
  ];

  const withBlock = (json: string) =>
    `Texto do PRD.\n\n**Numeric Provenance:**\n\`\`\`json\n${json}\n\`\`\``;

  it('sem bloco declarado não bloqueia e mantém o conteúdo', () => {
    const result = NumericIntegrityValidator.verifyDeclaredProvenance(
      'PRD sem bloco.',
      demand,
      refinementMessages,
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.cleanContent).toBe('PRD sem bloco.');
  });

  it('aceita provenance cuja fonte é real e contém o número; remove o bloco', () => {
    const content = withBlock(
      '{ "claims": [ { "value": "40%", "source": "40% das falhas de onboarding" } ] }',
    );
    const result = NumericIntegrityValidator.verifyDeclaredProvenance(
      content,
      demand,
      refinementMessages,
    );
    expect(result.valid).toBe(true);
    expect(result.cleanContent).toBe('Texto do PRD.');
    expect(result.cleanContent).not.toContain('Numeric Provenance');
  });

  it('rejeita fonte declarada inexistente', () => {
    const content = withBlock(
      '{ "claims": [ { "value": "99%", "source": "99% de melhoria garantida no trimestre" } ] }',
    );
    const result = NumericIntegrityValidator.verifyDeclaredProvenance(
      content,
      demand,
      refinementMessages,
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Fonte declarada não encontrada'))).toBe(
      true,
    );
  });

  it('rejeita número que não consta na fonte real declarada', () => {
    const content = withBlock(
      '{ "claims": [ { "value": "7 dias", "source": "reduzir o tempo de onboarding de 10 dias" } ] }',
    );
    const result = NumericIntegrityValidator.verifyDeclaredProvenance(
      content,
      demand,
      refinementMessages,
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('não consta na fonte declarada'))).toBe(
      true,
    );
  });
});
