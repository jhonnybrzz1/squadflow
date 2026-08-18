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
    error: vi.fn((msg, meta) => {
      console.error(msg, meta);
    }),
    debug: vi.fn(),
  },
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletion: vi.fn(),
  },
}));

// Groundedness has its own focused suite. Keep Reflexion call-count assertions
// scoped to document generation/repair rather than counting the LLM judge.
vi.mock('../server/services/groundedness-validator', () => ({
  GroundednessValidator: {
    validate: vi.fn().mockResolvedValue({ isGrounded: true, score: 1, issues: [] }),
  },
}));

vi.mock('../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn(),
    getRepoWithFiles: vi.fn(),
  },
}));

vi.mock('../server/services/github', () => ({
  gitHubService: {
    verifyFilesExist: vi.fn(),
  },
}));

vi.mock('../server/metrics', () => {
  const counter = () => {
    const fn = vi.fn();
    fn.labels = vi.fn().mockReturnValue({ inc: vi.fn() });
    fn.inc = vi.fn();
    return fn;
  };
  return {
    metrics: {
      increment: vi.fn(),
      gauge: vi.fn(),
      histogram: vi.fn(),
    },
    register: {
      registerMetric: vi.fn(),
      contentType: 'text/plain',
      metrics: '',
    },
    documentHallucinationTotal: counter(),
    numericProvenanceViolationsTotal: counter(),
    citedPathViolationsTotal: counter(),
    contextSummarizationTokensSaved: counter(),
  };
});

vi.mock('../server/storage', () => ({
  storage: {
    getDemand: vi.fn(),
    updateDemand: vi.fn(),
    createChatMessage: vi.fn(),
  },
}));

vi.mock('../server/events/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

import { openAIService } from '../server/services/openai-ai';
import { contextBuilder } from '../server/services/context-builder';
import { PromptParser } from '../server/services/ai-squad/prompt-parser';
import { AISquadService } from '../server/services/ai-squad';
import { featureFlags } from '../server/services/feature-flags';
import { logger } from '../server/utils/logger';
import { Demand } from '@shared/schema';

describe('Reflexion Loop: Autocorreção de Artefatos', () => {
  let service: AISquadService;

  const buildDemand = (overrides?: Partial<Demand>): Demand => ({
    id: 999,
    title: 'Demanda de Teste',
    description: 'Demanda para validação do Reflexion',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
    ...overrides,
  });

  // PRD de melhoria COMPLETO: passa no gate estrutural (governança) E no gate de
  // qualidade tiered (validateImprovementPlan nível 3). Sem números não-ancorados,
  // para não ser alterado pelo NumericIntegrityValidator.
  const validPrdContent = `
# PRD - Melhoria Completa com Mais de Duzentos Caracteres para Passar no Contrato de Markdown
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente e válido para o fluxo.

## 4. Objetivo
### 4.1 Objetivo Principal
Reduzir o retrabalho do fluxo de refinamento da squad de forma incremental.

## 5. Escopo da Entrega
### 5.1 Fazer Agora
- Implementar o gate unificado de qualidade no document-generator.

## Requisitos Funcionais
- RF: Validar a integridade estrutural e de dados dos artefatos produzidos no fluxo.

## Critérios de Aceite
- [ ] O loop deve executar no máximo duas vezes e convergir.

## 8. Métricas de Sucesso
| Métrica | Baseline | Meta | Como Medir |
| --- | --- | --- | --- |
| Tempo de refino | A medir | Reduzir | Cronômetro do fluxo |

## 10. Riscos e Mitigação
- Risco: regressão no gate. Mitigação: manter a guarda keep-best.

## 12. Plano de Execução
- Passo: integrar o validador tiered no loop de Reflexion.

## 13. Casos de Borda
- Documento sem seções de melhoria deve disparar o reparo.

## Dependências
- Owner: Time de Engenharia do AiChatFlow
- Impacto: Alto impacto/risco caso falhe.

## Decisões
- Decisão: usar o validador de improvement-execution no document-generator.
`;

  // Passa no gate estrutural (tem as 4 seções obrigatórias da governança) mas NÃO
  // satisfaz o gate de qualidade tiered (faltam Objetivo, Fazer Agora, tabela de
  // métricas completa, Plano de Execução e Casos de Borda).
  const structurallyValidTieredIncomplete = `
# PRD - Estruturalmente Válido com Mais de Duzentos Caracteres para Passar no Contrato de Markdown e no Gate Estrutural
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente.
## Requisitos Funcionais
- RF1: Teste funcional do loop de autocorreção.

## Critérios de Aceite
- Critério 1: O loop deve executar no máximo duas vezes.

## Dependências
- Owner: Time de Engenharia do AiChatFlow
- Impacto: Alto impacto/risco caso falhe.

## Decisões
- Decisão 1: Usar o GovernanceGatingService no document-generator.ts.
`;

  // Checklist de melhoria COMPLETO: passa no validateImprovementTasks nível 3
  // (task [IMPLEMENTAÇÃO], seção ## Agora com IDs, ## Depois, ## Não Fazer, ## Métricas).
  const validTasksContent = `# Checklist De Execução - Demanda de Teste

**Versão:** 1.0.0
**Prioridade:** Alta
**Responsável:** @produto-pessoal
**Status:** Não Iniciado

## Agora
- **T1:** [DIAGNÓSTICO] Medir o baseline atual do fluxo.
  Critérios de aceite: baseline registrado.
  **Dependências:** Nenhuma
  **Vinculado ao PRD:** §8 Métricas de Sucesso
- **T2:** [IMPLEMENTAÇÃO] Aplicar a mudança real no document-generator.
  Critérios de aceite: gate tiered ativo no fluxo.
  **Dependências:** T1
  **Vinculado ao PRD:** §5.1 Fazer Agora

## Depois
- Melhoria futura que não bloqueia a entrega atual.

## Não Fazer
- Refatoração arquitetural fora de escopo.

## Métricas de Sucesso
- Indicador de que a task [IMPLEMENTAÇÃO] funcionou.
`;

  // Checklist sem task [IMPLEMENTAÇÃO] e sem as seções obrigatórias de nível 3:
  // falha no validateImprovementTasks (apenas diagnóstico).
  const invalidTasksContent = `# Checklist De Execução - Demanda de Teste

**Versão:** 1.0.0
**Prioridade:** Alta
**Status:** Não Iniciado

## Agora
- **T1:** [DIAGNÓSTICO] Apenas medir, sem aplicar nenhuma mudança real.
  **Vinculado ao PRD:** §8 Métricas de Sucesso
`;

  // Mais de 200 caracteres, mas faltam "Critérios de Aceite", "Dependências" e "Decisões"
  const invalidPrdContentMissingSections = `
# PRD - Incompleto de Teste com Mais de Duzentos Caracteres para Passar no Validador de Contrato de Markdown e Não Lançar Exceções Inesperadas
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente.
## Requisitos Funcionais
- RF1: O sistema deve validar a integridade estrutural e de dados dos artefatos produzidos no fluxo.
`;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new AISquadService();

    // Mocks de helpers e setup para generatePRDWithPM não quebrar
    vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue([]);
    vi.spyOn(contextBuilder, 'getInsightsSummary').mockReturnValue('insights');
    vi.spyOn(contextBuilder, 'validateDocumentEvidence').mockImplementation(async (doc) => ({
      cleanMessage: doc,
      evidence: { sourceType: 'allowed', evidenceFiles: [] },
      issues: [],
    }));
    vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('digest');
    vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
    vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('guidance');
    vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('orientation');
    vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
    vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
    vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('system prompt');

    // Desabilitar helpers para simplificar e focar no retorno direto
    vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
    vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
    vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
    vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
    vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);
  });

  it('CT01: Entrega imediata quando o primeiro documento já for válido', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(validPrdContent);

    const demand = buildDemand();
    const result = await service.generatePRDWithPM(demand, []);

    expect(result).toBe(validPrdContent);
    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[Reflexion] Validando primeira versão do documento',
      expect.any(Object),
    );
  });

  it('CT02: Corrige documento na primeira iteração de refinamento (V1 válida)', async () => {
    vi.mocked(openAIService.generateChatCompletion)
      .mockResolvedValueOnce(invalidPrdContentMissingSections) // V0 (inválida)
      .mockResolvedValueOnce(validPrdContent); // V1 (válida)

    const demand = buildDemand();
    const result = await service.generatePRDWithPM(demand, []);

    expect(result).toBe(validPrdContent);
    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(2);

    // Deve logar que iniciou o refinamento
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[Reflexion] Iniciando iteração de refinamento 1/2'),
      expect.any(Object),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Reflexion] Documento passou no gate unificado (governança + qualidade tiered). Encerrando o loop de autocrítica.',
      ),
    );
  });

  it('CT03: Limita a exatamente 2 iterações adicionais (3 chamadas no total) e entrega a melhor versão', async () => {
    vi.mocked(openAIService.generateChatCompletion)
      .mockResolvedValueOnce(invalidPrdContentMissingSections) // V0 (inválida)
      .mockResolvedValueOnce(invalidPrdContentMissingSections) // V1 (inválida)
      .mockResolvedValueOnce(invalidPrdContentMissingSections); // V2 (inválida)

    const demand = buildDemand();
    const result = await service.generatePRDWithPM(demand, []);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(3); // 1 inicial + 2 refinamentos
    expect(result).toBe(invalidPrdContentMissingSections);
  });

  it('CT04: Guarda "keep best" mantém a versão anterior se o refinamento seguinte for pior', async () => {
    // V0: Faltando apenas Critérios de Aceite e Decisões (2 erros estruturais)
    const v0Prd = `
# PRD - Teste Inicial com Mais de Duzentos Caracteres para Validação do Contrato de Markdown no Vitest
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente.
## Requisitos Funcionais
- RF1: Teste funcional inicial.

## Dependências
- Owner: Time de Engenharia
- Impacto: Alto impacto/risco.
`;

    // V1: Piorada, faltando Requisitos Funcionais, Critérios de Aceite, Dependências e Decisões (4 erros estruturais)
    const v1Prd = `
# PRD - Piorado com Mais de Duzentos Caracteres para Validação do Contrato de Markdown no Vitest
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente.
Sem nenhuma das seções obrigatórias necessárias estruturadas aqui.
`;

    // V2: Faltando Critérios de Aceite, Dependências e Decisões (3 erros estruturais)
    const v2Prd = `
# PRD - Teste V2 com Mais de Duzentos Caracteres para Validação do Contrato de Markdown no Vitest
Este é um texto longo de preenchimento para garantir que o validador de contrato de markdown considere este documento longo o suficiente.
## Requisitos Funcionais
- RF1: Teste funcional da iteração V2.
`;

    vi.mocked(openAIService.generateChatCompletion)
      .mockResolvedValueOnce(v0Prd) // V0 (2 falhas)
      .mockResolvedValueOnce(v1Prd) // V1 (4 falhas) - pior, deve ser descartada
      .mockResolvedValueOnce(v2Prd); // V2 (3 falhas) - pior que V0, deve ser descartada

    const demand = buildDemand();
    const result = await service.generatePRDWithPM(demand, []);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(3);
    // Deve retornar V0 (que tinha 2 erros estruturais, melhor que os 4 de V1 e 3 de V2)
    expect(result).toBe(v0Prd);
  });

  it('CT05: gate tiered dispara reparo quando o documento passa no estrutural mas falha na qualidade (melhoria)', async () => {
    // Sozinho, o gate estrutural entregaria este documento em 1 chamada. O gate de
    // qualidade tiered (validateImprovementPlan) o reprova e força o loop até o teto.
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(
      structurallyValidTieredIncomplete,
    );

    const demand = buildDemand(); // melhoria + business → gate tiered ativo
    const result = await service.generatePRDWithPM(demand, []);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(3); // 1 inicial + 2 reparos
    expect(result).toBe(structurallyValidTieredIncomplete);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[Reflexion] Iniciando iteração de refinamento 1/2'),
      expect.any(Object),
    );
  });

  it('CT06: fora do escopo de melhoria não-técnica o gate tiered não se aplica (entrega imediata)', async () => {
    // Refinamento técnico → isTechnical=true → gate tiered desativado: o mesmo
    // documento estruturalmente válido é entregue em 1 chamada (controle negativo de CT05).
    vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('technical');
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(
      structurallyValidTieredIncomplete,
    );

    const demand = buildDemand();
    const result = await service.generatePRDWithPM(demand, []);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(1);
    expect(result).toBe(structurallyValidTieredIncomplete);
  });

  it('CT06b: falha na API de IA retorna erro controlado sem gerar documento inválido (spec 10059)', async () => {
    const apiError = Object.assign(new Error('Provider timeout'), { status: 504 });
    vi.mocked(openAIService.generateChatCompletion).mockRejectedValue(apiError);

    const demand = buildDemand();
    await expect(service.generatePRDWithPM(demand, [])).rejects.toThrow(
      'Falha na geração do PRD. Os dados de refinamento foram preservados. Tente novamente mais tarde.',
    );

    const [_, __, options] = vi.mocked(openAIService.generateChatCompletion).mock.calls[0];
    expect(options).toMatchObject({ retryAttempts: 3, retryDelayMs: 1000 });
    expect(logger.error).toHaveBeenCalledWith(
      'Erro ao gerar PRD com PM',
      expect.objectContaining({ context: { demandId: demand.id } }),
    );
  });

  it('CT07: checklist de melhoria válido na primeira geração é entregue imediatamente', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(validTasksContent);

    const demand = buildDemand(); // melhoria → gate de tasks ativo
    const result = await service.generateTasksWithPM(demand, validPrdContent);

    expect(result).toBe(validTasksContent);
    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[Reflexion] Validando primeira versão do checklist de tasks',
      expect.any(Object),
    );
  });

  it('CT08: checklist sem [IMPLEMENTAÇÃO] dispara reparo e converge quando a versão seguinte é válida', async () => {
    vi.mocked(openAIService.generateChatCompletion)
      .mockResolvedValueOnce(invalidTasksContent) // V0 inválida (só diagnóstico)
      .mockResolvedValueOnce(validTasksContent); // V1 válida

    const demand = buildDemand();
    const result = await service.generateTasksWithPM(demand, validPrdContent);

    expect(result).toBe(validTasksContent);
    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Reflexion] Checklist de tasks passou no gate de qualidade tiered. Encerrando o loop.',
      ),
      expect.any(Object),
    );
  });

  it('CT09: checklist sempre inválido limita a 3 chamadas e entrega a melhor versão', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(invalidTasksContent);

    const demand = buildDemand();
    const result = await service.generateTasksWithPM(demand, validPrdContent);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(3); // 1 inicial + 2 reparos
    expect(result).toBe(invalidTasksContent);
  });

  it('CT10: fora de melhoria o gate de tasks não se aplica — geração única (controle negativo)', async () => {
    // Demanda de bug usa o prompt inline de tasks e não exige [IMPLEMENTAÇÃO]:
    // mesmo um checklist sem as seções de melhoria é entregue em 1 chamada.
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue(invalidTasksContent);

    const demand = buildDemand({ type: 'bug' });
    const result = await service.generateTasksWithPM(demand, validPrdContent);

    expect(openAIService.generateChatCompletion).toHaveBeenCalledTimes(1);
    expect(result).toBe(invalidTasksContent);
  });
});

describe('Faixa B: gating do Response Contract por agente', () => {
  let svc: AISquadService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new AISquadService();
  });

  it('desativado quando a master flag está off', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      agentResponseSchemaPilot: false,
      agentResponseSchemaPilotAgents: ['scrum_master'],
    });
    expect(svc.isResponseContractEnabledForAgent('scrum_master')).toBe(false);
  });

  it('ativa apenas para agentes na lista quando a master flag está on', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      agentResponseSchemaPilot: true,
      agentResponseSchemaPilotAgents: ['scrum_master', 'qa'],
    });
    expect(svc.isResponseContractEnabledForAgent('scrum_master')).toBe(true);
    expect(svc.isResponseContractEnabledForAgent('qa')).toBe(true);
    expect(svc.isResponseContractEnabledForAgent('tech_lead')).toBe(false);
  });

  it('default para scrum_master quando a lista é omitida (compatibilidade com o piloto)', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ agentResponseSchemaPilot: true });
    expect(svc.isResponseContractEnabledForAgent('scrum_master')).toBe(true);
    expect(svc.isResponseContractEnabledForAgent('qa')).toBe(false);
  });
});
