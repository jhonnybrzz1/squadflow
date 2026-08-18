import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks do banco de dados e do logger para não quebrar ou dar erro
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    run: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletionWithMetadata: vi.fn(),
  },
}));

import { openAIService } from '../server/services/openai-ai';
import { RoundtableOrchestrator } from '../server/services/ai-squad/roundtable-orchestrator';
import { featureFlags } from '../server/services/feature-flags';
import { NumericIntegrityValidator } from '../server/services/numeric-integrity-validator';
import { Demand } from '@shared/schema';

describe('Red-Team: Frente A - Agente Adversarial PO + Reflexion', () => {
  let orchestrator: RoundtableOrchestrator;

  const buildDemand = (overrides?: Partial<Demand>): Demand => ({
    id: 111,
    title: 'Demanda com Métricas de Teste',
    description: 'Queremos criar um novo fluxo de checkout.',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
    ...overrides,
  });

  const mockCandidateConsolidation = JSON.stringify({
    problema: 'Checkout lento.',
    objetivo: 'Simplificar checkout.',
    escopo: 'Checkout modular.',
    criterios_de_aceite: ['Rápido.'],
    riscos: [],
    dependencias: [],
    divergencias: [],
    consolidacao: 'A consolidação candidata propõe redução de 50% e ROI de 4:1.',
  });

  const mockCorrectedConsolidation = JSON.stringify({
    problema: 'Checkout lento.',
    objetivo: 'Simplificar checkout.',
    escopo: 'Checkout modular.',
    criterios_de_aceite: ['Rápido.'],
    riscos: [],
    dependencias: [],
    divergencias: [],
    consolidacao: 'A consolidação corrigida propõe redução qualitativa com ROI sob estimativa.',
  });

  // Falha ALTA
  const mockRedTeamCriticismHigh = JSON.stringify({
    falhas: [
      {
        trecho: 'redução de 50% e ROI de 4:1',
        tipo: 'numero_sem_fonte',
        severidade: 'ALTA',
        sugestao: 'Remova os números e coloque qualitativo.',
      },
    ],
  });

  const mockJudgeApprovalHigh = JSON.stringify({
    falhas_confirmadas: [
      {
        trecho: 'redução de 50% e ROI de 4:1',
        tipo: 'numero_sem_fonte',
        severidade: 'ALTA',
        sugestao: 'Remova os números e coloque qualitativo.',
        motivo: 'De fato, não há baseline ou ROI no debate.',
      },
    ],
  });

  // Falha BAIXA
  const mockRedTeamCriticismLow = JSON.stringify({
    falhas: [
      {
        trecho: 'Checkout modular.',
        tipo: 'redacao_clareza',
        severidade: 'BAIXA',
        sugestao: 'Melhorar a redação.',
      },
    ],
  });

  const mockJudgeApprovalLow = JSON.stringify({
    falhas_confirmadas: [
      {
        trecho: 'Checkout modular.',
        tipo: 'redacao_clareza',
        severidade: 'BAIXA',
        sugestao: 'Melhorar a redação.',
        motivo: 'Pode ser reescrito com clareza.',
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RoundtableOrchestrator(null as any);
  });

  it('deve executar o fluxo completo (consolidação -> red-team crítica ALTA -> juiz confirma -> loop de correção -> sucesso)', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ redTeamEnabled: true });

    vi.mocked(openAIService.generateChatCompletionWithMetadata)
      // 1. Primeira geração de consolidação
      .mockResolvedValueOnce({ content: mockCandidateConsolidation })
      // 2. Red-Team PO critica
      .mockResolvedValueOnce({ content: mockRedTeamCriticismHigh })
      // 3. Juiz confirma
      .mockResolvedValueOnce({ content: mockJudgeApprovalHigh })
      // 4. Segunda geração da consolidação (Reflexion loop)
      .mockResolvedValueOnce({ content: mockCorrectedConsolidation })
      // 5. Red-Team PO valida nova e aprova
      .mockResolvedValueOnce({ content: JSON.stringify({ falhas: [] }) });

    const demand = buildDemand();
    const result = await (orchestrator as any).consolidate(demand, ['Mensagem 1'], [], 0);

    expect(result.problema).toBe('Checkout lento.');
    expect(result.consolidacao).toContain('redução qualitativa');

    expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledTimes(5);

    // N6: Modo adversarial SUBSTITUI a persona do PO
    expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledWith(
      expect.stringContaining('Você é o Product Owner em MODO REVISÃO CRÍTICA.'),
      expect.any(String),
      expect.any(Object),
    );
    expect(openAIService.generateChatCompletionWithMetadata).not.toHaveBeenCalledWith(
      expect.stringContaining('Sua função é FACILITAR o refinamento'),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('deve ignorar falhas de severidade BAIXA para loop de autocorreção', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ redTeamEnabled: true });

    vi.mocked(openAIService.generateChatCompletionWithMetadata)
      // 1. Primeira geração de consolidação
      .mockResolvedValueOnce({ content: mockCandidateConsolidation })
      // 2. Red-Team PO critica com severidade BAIXA
      .mockResolvedValueOnce({ content: mockRedTeamCriticismLow })
      // 3. Juiz confirma severidade BAIXA
      .mockResolvedValueOnce({ content: mockJudgeApprovalLow });

    const demand = buildDemand();
    const result = await (orchestrator as any).consolidate(demand, ['Mensagem 1'], [], 0);

    // O loop deve encerrar imediatamente na iteração 1 sem chamar nova consolidação, pois a única falha confirmada é BAIXA
    expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledTimes(3);
    expect(result.problema).toBe('Checkout lento.');
  });

  it('deve respeitar o teto máximo de 2 iterações adicionais mesmo se o PO continuar insatisfeito', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ redTeamEnabled: true });

    vi.mocked(openAIService.generateChatCompletionWithMetadata)
      // Iteração Inicial:
      .mockResolvedValueOnce({ content: mockCandidateConsolidation }) // Consolidação Inicial
      .mockResolvedValueOnce({ content: mockRedTeamCriticismHigh }) // PO Critica
      .mockResolvedValueOnce({ content: mockJudgeApprovalHigh }) // Juiz Confirma (1 falha alta)

      // Iteração 1:
      .mockResolvedValueOnce({ content: mockCandidateConsolidation }) // Consolidação Iteração 1
      .mockResolvedValueOnce({ content: mockRedTeamCriticismHigh }) // PO Critica de novo
      .mockResolvedValueOnce({ content: mockJudgeApprovalHigh }) // Juiz Confirma de novo (1 falha alta)

      // Iteração 2 (Última do teto de 2 iterações adicionais):
      .mockResolvedValueOnce({ content: mockCandidateConsolidation }); // Consolidação Iteração 2

    const demand = buildDemand();
    await (orchestrator as any).consolidate(demand, ['Mensagem 1'], [], 0);

    // Teto atingido: 3 gerações de consolidação de fato (1 inicial + 2 loops)
    expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledTimes(7);
  });

  it('keep-best: se a iteração de autocorreção piorar a quantidade de falhas altas, deve retornar a versão anterior', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ redTeamEnabled: true });

    // V0: 1 falha alta
    const v0Consolidation = mockCandidateConsolidation;

    // V1: Piorada, com 2 falhas altas
    const v1Consolidation = JSON.stringify({
      problema: 'Checkout lento.',
      objetivo: 'Simplificar checkout.',
      escopo: 'Checkout modular.',
      criterios_de_aceite: ['Rápido.'],
      riscos: [],
      dependencias: [],
      divergencias: [],
      consolidacao: 'A consolidação V1 propõe redução de 90%, ROI de 10:1 e prazo de 2 dias.',
    });

    const mockRedTeamCriticismV1 = JSON.stringify({
      falhas: [
        {
          trecho: 'redução de 90%',
          tipo: 'numero_sem_fonte',
          severidade: 'ALTA',
          sugestao: 'Remover',
        },
        {
          trecho: 'ROI de 10:1',
          tipo: 'numero_sem_fonte',
          severidade: 'ALTA',
          sugestao: 'Remover',
        },
      ],
    });

    const mockJudgeApprovalV1 = JSON.stringify({
      falhas_confirmadas: [
        {
          trecho: 'redução de 90%',
          tipo: 'numero_sem_fonte',
          severidade: 'ALTA',
          sugestao: 'Remover',
          motivo: 'Sem fonte',
        },
        {
          trecho: 'ROI de 10:1',
          tipo: 'numero_sem_fonte',
          severidade: 'ALTA',
          sugestao: 'Remover',
          motivo: 'Sem fonte',
        },
      ],
    });

    vi.mocked(openAIService.generateChatCompletionWithMetadata)
      // Iteração Inicial:
      .mockResolvedValueOnce({ content: v0Consolidation })
      .mockResolvedValueOnce({ content: mockRedTeamCriticismHigh })
      .mockResolvedValueOnce({ content: mockJudgeApprovalHigh })

      // Iteração 1 (Piorou para 2 falhas):
      .mockResolvedValueOnce({ content: v1Consolidation })
      .mockResolvedValueOnce({ content: mockRedTeamCriticismV1 })
      .mockResolvedValueOnce({ content: mockJudgeApprovalV1 });

    const demand = buildDemand();
    const result = await (orchestrator as any).consolidate(demand, ['Mensagem 1'], [], 0);

    // Deve retornar a consolidação V0, que tinha 1 falha alta (melhor que a V1 com 2 falhas altas)
    expect(result.consolidacao).toBe(
      'A consolidação candidata propõe redução de 50% e ROI de 4:1.',
    );
  });

  it('deve aplicar graceful degradation caso ocorra falha na chamada da API no loop', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ redTeamEnabled: true });

    vi.mocked(openAIService.generateChatCompletionWithMetadata)
      .mockResolvedValueOnce({ content: mockCandidateConsolidation })
      .mockRejectedValueOnce(new Error('Timeout na chamada do Red-Team PO'));

    const demand = buildDemand();
    const result = await (orchestrator as any).consolidate(demand, ['Mensagem 1'], [], 0);

    // Deve continuar normalmente com a consolidação inicial sem quebrar a execução
    expect(result.problema).toBe('Checkout lento.');
    expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledTimes(2);
  });
});

describe('Red-Team: Frente B - Ajuste do Validador Numérico', () => {
  const mockDemand = (overrides?: Partial<Demand>): Demand => ({
    id: 222,
    title: 'Demanda de Teste do Validador',
    description: 'Demanda contendo reduzir em 30% o tempo original.',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
    ...overrides,
  });

  it('deve remover ROI fabricado na prosa da Justificativa mantendo afirmação qualitativa', () => {
    const prdProse = `
# PRD
## Justificativa
Esta iniciativa trará benefícios expressivos com ROI 5:1 no primeiro ano.
`;

    const result = NumericIntegrityValidator.validate(prdProse, mockDemand(), []);
    expect(result.cleanPrd).not.toContain('ROI 5:1');
    expect(result.cleanPrd).toContain('benefícios expressivos no primeiro ano');
  });

  it('célula de Meta sem âncora deve virar "Definir após baseline", NUNCA "> A MEDIR"', () => {
    const prdTable = `
# PRD
## Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | 10% | > 80% | Logs do Mixpanel |
`;

    // Criamos uma demanda específica com "10%" ancorado, mas "80%" não ancorado
    const demand = mockDemand({
      description: 'Queremos reduzir em 30% partindo de uma conversão de 10% no onboarding.',
    });

    const result = NumericIntegrityValidator.validate(prdTable, demand, []);
    expect(result.cleanPrd).toContain(
      '| Conversao | 10% | Definir após baseline | Logs do Mixpanel |',
    );
    expect(result.cleanPrd).not.toContain('A MEDIR');
  });

  it('célula de Baseline sem âncora deve virar "A MEDIR — sem baseline"', () => {
    const prdTable = `
# PRD
## Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | 80% | 30% | Logs do Mixpanel |
`;

    // O "30%" de meta está ancorado no input ("reduzir em 30%"), mas o "80%" de baseline não está.
    // O baseline vira "A MEDIR — sem baseline", e a meta permanece "30%".
    const result = NumericIntegrityValidator.validate(prdTable, mockDemand(), []);
    expect(result.cleanPrd).toContain(
      '| Conversao | A MEDIR — sem baseline | 30% | Logs do Mixpanel |',
    );
  });

  it('números presentes no input original (ancorados) devem permanecer inalterados', () => {
    const prdProse = `
# PRD
## Problema e Oportunidade
Queremos reduzir em 30% o tempo original de atendimento.
`;

    const result = NumericIntegrityValidator.validate(prdProse, mockDemand(), []);
    // Como "30%" está contido no input da demanda original ("reduzir em 30%"), ele deve ser mantido
    expect(result.cleanPrd).toContain('reduzir em 30% o tempo original');
  });

  it('validador deve ser idempotente: rodar duas vezes retorna exatamente o mesmo documento', () => {
    const prdTableAndProse = `
# PRD
## Justificativa
Reduz ~80% o retrabalho e traz ROI de 5:1.

## Métricas de Sucesso
| Métrica | Baseline Atual | Meta | Como Medir |
|---------|----------------|------|------------|
| Conversao | 12% | > 50% | Logs |
`;

    const firstPass = NumericIntegrityValidator.validate(prdTableAndProse, mockDemand(), []);
    const secondPass = NumericIntegrityValidator.validate(firstPass.cleanPrd, mockDemand(), []);

    expect(firstPass.cleanPrd).toBe(secondPass.cleanPrd);
    expect(secondPass.removedCount).toBe(0); // Nenhum novo número removido na segunda passagem
  });
});

describe('NumericIntegrityValidator: modo mark e ranges (resposta crua do agente)', () => {
  const mockDemand = (overrides?: Partial<Demand>): Demand => ({
    id: 333,
    title: 'Salvar preferência de tema',
    description: 'O app deve lembrar o tema escolhido entre sessões.',
    type: 'melhoria',
    priority: 'media',
    status: 'processing',
    progress: 0,
    refinementType: 'technical',
    createdAt: new Date(),
    ...overrides,
  });

  it('modo mark: substitui número não-ancorado por [A MEDIR] mantendo a frase legível', () => {
    const msg = 'Impacto: aumento de 15% no abandono e Esforço: 2 dias.';
    const result = NumericIntegrityValidator.validate(msg, mockDemand(), [], 'agente', 'mark');
    expect(result.cleanPrd).not.toContain('15%');
    expect(result.cleanPrd).not.toContain('2 dias');
    expect(result.cleanPrd).toContain('[A MEDIR]');
    // Não deve grudar o marcador nas palavras vizinhas
    expect(result.cleanPrd).toContain('aumento de [A MEDIR] no abandono');
    expect(result.cleanPrd).toContain('Esforço: [A MEDIR]');
  });

  it('modo mark: range com hífen/en-dash é tratado como um único match (sem sobra "20-")', () => {
    const msg = 'Estima-se que 20-30% dos usuários e cerca de 5–10% retornam.';
    const result = NumericIntegrityValidator.validate(msg, mockDemand(), [], 'agente', 'mark');
    expect(result.cleanPrd).not.toMatch(/20-(?!\d)/); // nenhuma sobra tipo "20-dos"
    expect(result.cleanPrd).not.toContain('20-30%');
    expect(result.cleanPrd).not.toContain('5–10%');
    expect(result.cleanPrd).toContain('dos usuários');
  });

  it('modo remove (default): range não deixa sobra dangling', () => {
    const msg = 'Reduz 20-30% do retrabalho.';
    const result = NumericIntegrityValidator.validate(msg, mockDemand(), []);
    expect(result.cleanPrd).not.toContain('20-30%');
    expect(result.cleanPrd).not.toMatch(/20-(?!\d)/);
    expect(result.cleanPrd).not.toContain('[A MEDIR]'); // remove não insere marcador
  });

  it('modo mark: prazo decimal (0,5 dias) e horas não deixam resíduo "0,"', () => {
    const msg = 'Esforço: 0,5 dias para implementar e 4 horas de teste.';
    const result = NumericIntegrityValidator.validate(msg, mockDemand(), [], 'agente', 'mark');
    expect(result.cleanPrd).not.toContain('0,5');
    expect(result.cleanPrd).not.toMatch(/0,\s*\[A MEDIR\]/); // sem resíduo de decimal
    expect(result.cleanPrd).not.toContain('4 horas');
    expect(result.cleanPrd).toContain('[A MEDIR]');
  });

  it('modo mark: número ancorado na demanda é preservado', () => {
    const demand = mockDemand({ description: 'Queremos reduzir em 30% o tempo.' });
    const msg = 'A meta é reduzir em 30% o tempo, ganho de 99% inventado.';
    const result = NumericIntegrityValidator.validate(msg, demand, [], 'agente', 'mark');
    expect(result.cleanPrd).toContain('reduzir em 30% o tempo');
    expect(result.cleanPrd).not.toContain('99%');
  });
});
