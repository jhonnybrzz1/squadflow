/**
 * PRD Hallucination Acceptance Tests (CT01-CT05)
 *
 * These tests validate the anti-hallucination fix for evidence blocks in PRD/TDD
 * generation. The fix ensures that the PM/Tech Lead agents can ONLY cite file
 * paths that were verified during refinement (T1-T4 in ai-squad.ts).
 *
 * Coverage target: lines 2665-2731 in ai-squad.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies BEFORE importing the service under test
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    // Drizzle ORM query-builder methods
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    // dbRun (db-utils.ts) checks db.run first, then db.execute
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
    generateChatCompletion: vi.fn(),
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

vi.mock('../server/metrics', () => ({
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
  },
  documentHallucinationTotal: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
  numericProvenanceViolationsTotal: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
  citedPathViolationsTotal: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
}));

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
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../server/services/model-governance', () => ({
  validateContract: vi.fn(),
}));

// Import after mocks
import { openAIService } from '../server/services/openai-ai';
import { repoService } from '../server/services/repo-service';
import { contextBuilder } from '../server/services/context-builder';
import { logger } from '../server/utils/logger';
import { PromptParser } from '../server/services/ai-squad/prompt-parser';
import type { Demand } from '@shared/schema';

const owner = 'example-org';
const repoName = 'AiChatFlow1';

/**
 * Helper to build a minimal demand object for testing
 */
function buildDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: 1,
    title: 'Test Demand',
    description: 'Test description',
    type: 'descoberta',
    priority: 'média',
    status: 'pending',
    prd: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    complexity: null,
    tags: [],
    ...overrides,
  } as Demand;
}

/**
 * Helper to build a PRD with an Evidence Block
 */
function buildPrdWithEvidence(
  files: string[],
  sourceType: 'direct_read' | 'blocked' = 'direct_read',
): string {
  const evidenceBlock =
    files.length > 0
      ? `{
  "sourceType": "${sourceType}",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ${JSON.stringify(files)}
}`
      : `{
  "sourceType": "blocked",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": []
}`;

  return `# PRD - Test Demand

## 1. Decisão De Produto
Conectar o frontend ao SSE existente para atualizações em tempo real.

## 2. Problema e Oportunidade
O usuário precisa ver atualizações de refinamento em tempo real.

## 3. Escopo da Entrega
### Faremos
- Integrar frontend com backend SSE

### Não Faremos Agora
- Migração para WebSocket

## 4. Métricas de Sucesso
- Latência de notificação < 1s

## Requisitos Funcionais
- RF1: Teste estrutural do validador.

## Critérios de Aceite
- Critério 1: Passar no teste de aceitação de alucinações.

## Dependências
- Owner: Time de Desenvolvimento
- Impacto: Alto impacto/risco.

## Decisões
- Decisão 1: Gravar o artefato.

## Evidências do Refinamento
${files.length > 0 ? files.map((f) => `- Verificado: ${f}`).join('\n') : '- Sem evidências verificáveis até o momento'}

**Evidence Block:**
\`\`\`json
${evidenceBlock}
\`\`\`
`;
}

describe('PRD Hallucination Acceptance Tests (CT01-CT05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default repo mock - files exist in the repo
    (repoService.getRepoWithFiles as any).mockResolvedValue({
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'server/services/sse/manager.ts' }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * CT01: Happy Path (Demanda Realtime)
   *
   * Scenario: A realtime demand with WebSocket/SSE requirements.
   * The squad verified one file during refinement.
   * The LLM correctly cites only that file.
   *
   * Expected: hasHallucination = false
   */
  describe('CT01: Happy Path - Demanda Realtime', () => {
    it('deve retornar hasHallucination: false quando LLM cita apenas arquivos permitidos', async () => {
      const verifiedFiles = ['server/services/sse/manager.ts'];

      // Spy on getVerifiedEvidenceFiles to return the allowed list
      const getVerifiedSpy = vi
        .spyOn(contextBuilder, 'getVerifiedEvidenceFiles')
        .mockReturnValue(verifiedFiles);

      // Mock LLM to return a PRD with ONLY allowed paths
      const mockPrd = buildPrdWithEvidence(verifiedFiles, 'direct_read');
      (openAIService.generateChatCompletion as any).mockResolvedValue(mockPrd);

      // Import and instantiate the service
      const { AISquadService } = await import('../server/services/ai-squad');
      const service = new AISquadService();

      // Mock internal methods needed for generatePRDWithPM
      vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('digest');
      vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
      vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('guidance');
      vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('orientation');
      vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
      vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
      vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('system prompt');
      vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

      const demand = buildDemand({
        title: 'Correção de Atualização em Tempo Real',
        description: 'WebSocket/SSE realtime updates',
      });

      await service.generatePRDWithPM(demand, [], 'test-model');

      // Verify getVerifiedEvidenceFiles was called
      expect(getVerifiedSpy).toHaveBeenCalledWith(demand.id);

      // Check the structured hallucination metric log
      expect(logger.info).toHaveBeenCalledWith(
        'PRD/TSD evidence hallucination metric',
        expect.objectContaining({
          context: expect.objectContaining({
            demandId: demand.id,
            hasHallucination: false,
            citedPaths: verifiedFiles,
          }),
        }),
      );

      // Should NOT log any hallucination warnings
      const warnCalls = (logger.warn as any).mock.calls;
      const hallucinationWarnings = warnCalls.filter((call: any[]) =>
        call[0]?.includes?.('Arquivos alucinados'),
      );
      expect(hallucinationWarnings).toHaveLength(0);
    });
  });

  /**
   * CT02: Lista Vazia (Demanda Conceitual)
   *
   * Scenario: A generic/conceptual demand with no code evidence.
   * The squad did not verify any files during refinement.
   * The LLM correctly uses sourceType: 'blocked'.
   *
   * Expected: citedPaths = [], hasHallucination = false
   */
  describe('CT02: Lista Vazia - Demanda Conceitual', () => {
    it('deve aceitar PRD com sourceType blocked quando lista de arquivos verificados está vazia', async () => {
      const verifiedFiles: string[] = [];

      vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue(verifiedFiles);

      // LLM correctly returns blocked with empty files
      const mockPrd = buildPrdWithEvidence([], 'blocked');
      (openAIService.generateChatCompletion as any).mockResolvedValue(mockPrd);

      const { AISquadService } = await import('../server/services/ai-squad');
      const service = new AISquadService();

      vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
      vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
      vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
      vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
      vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');
      vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

      const demand = buildDemand({
        title: 'Demanda Conceitual Genérica',
        description: 'Uma ideia de produto sem código envolvido',
      });

      await service.generatePRDWithPM(demand, [], 'test-model');

      // Check the metric log shows no hallucination and empty citedPaths
      expect(logger.info).toHaveBeenCalledWith(
        'PRD/TSD evidence hallucination metric',
        expect.objectContaining({
          context: expect.objectContaining({
            demandId: demand.id,
            hasHallucination: false,
            citedPaths: [],
          }),
        }),
      );
    });
  });

  /**
   * CT03: LLM Teimoso (Filtragem de Alucinação)
   *
   * Scenario: The squad verified one file, but the LLM stubbornly
   * includes an additional hallucinated path in its response.
   *
   * The anti-hallucination fix works in TWO layers:
   * 1. contextBuilder.validateDocumentEvidence() - checks files exist in repo
   * 2. Server-side filtering against verifiedEvidenceFiles (ALLOWED_FILE_PATHS)
   *
   * For layer 2 to trigger, the files must pass layer 1 (exist in repo).
   * This test mocks the repo to contain ALL cited files, so the hallucination
   * detection happens at the ALLOWED_FILE_PATHS layer.
   *
   * Expected: Hallucinated path is filtered out, hasHallucination = true
   */
  describe('CT03: LLM Teimoso - Filtragem de Alucinação', () => {
    it('deve filtrar paths alucinados e registrar hasHallucination: true', async () => {
      const verifiedFiles = ['server/services/sse/manager.ts'];
      const hallucinatedFile = 'server/events/RefinementEvents.ts';
      const allCitedFiles = [...verifiedFiles, hallucinatedFile];

      vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue(verifiedFiles);

      // IMPORTANT: Mock repo to contain ALL cited files so they pass the repo validation
      // This allows the ALLOWED_FILE_PATHS filtering logic to be tested
      (repoService.getRepoWithFiles as any).mockResolvedValue({
        id: 1,
        owner,
        name: repoName,
        files: allCitedFiles.map((path) => ({ path })),
      });

      // LLM returns both allowed AND hallucinated paths
      const mockPrd = buildPrdWithEvidence(allCitedFiles, 'direct_read');
      (openAIService.generateChatCompletion as any).mockResolvedValue(mockPrd);

      const { AISquadService } = await import('../server/services/ai-squad');
      const service = new AISquadService();

      vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
      vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
      vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
      vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
      vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');
      vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

      const demand = buildDemand({
        title: 'Realtime Updates',
        description: 'SSE integration',
      });

      await service.generatePRDWithPM(demand, [], 'test-model');

      // Should log a warning about hallucinated files (files not in ALLOWED_FILE_PATHS)
      expect(logger.warn).toHaveBeenCalledWith(
        'Arquivos alucinados detectados e filtrados do PRD/TSD',
        expect.objectContaining({
          context: expect.objectContaining({
            demandId: demand.id,
            hallucinatedFiles: [hallucinatedFile],
            remainingFiles: verifiedFiles,
          }),
        }),
      );

      // The metric log should show hasHallucination: true
      expect(logger.info).toHaveBeenCalledWith(
        'PRD/TSD evidence hallucination metric',
        expect.objectContaining({
          context: expect.objectContaining({
            demandId: demand.id,
            hasHallucination: true,
          }),
        }),
      );
    });

    it('deve converter sourceType para blocked quando TODOS os arquivos citados são alucinados', async () => {
      const verifiedFiles = ['server/services/sse/manager.ts'];
      const allHallucinated = [
        'server/events/RefinementEvents.ts',
        'client/src/components/FakeComponent.tsx',
      ];

      vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue(verifiedFiles);

      // Mock repo to contain ALL the hallucinated files (so they pass repo validation)
      (repoService.getRepoWithFiles as any).mockResolvedValue({
        id: 1,
        owner,
        name: repoName,
        files: allHallucinated.map((path) => ({ path })),
      });

      // LLM returns ONLY hallucinated paths (ignores the allowed list completely)
      const mockPrd = buildPrdWithEvidence(allHallucinated, 'direct_read');
      (openAIService.generateChatCompletion as any).mockResolvedValue(mockPrd);

      const { AISquadService } = await import('../server/services/ai-squad');
      const service = new AISquadService();

      vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
      vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
      vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
      vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
      vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');
      vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

      const demand = buildDemand({ title: 'Test' });

      await service.generatePRDWithPM(demand, [], 'test-model');

      // Should log hallucination warning with all files removed
      expect(logger.warn).toHaveBeenCalledWith(
        'Arquivos alucinados detectados e filtrados do PRD/TSD',
        expect.objectContaining({
          context: expect.objectContaining({
            hallucinatedFiles: allHallucinated,
            remainingFiles: [],
          }),
        }),
      );

      // The metric log should show hasHallucination: true and empty citedPaths
      expect(logger.info).toHaveBeenCalledWith(
        'PRD/TSD evidence hallucination metric',
        expect.objectContaining({
          context: expect.objectContaining({
            hasHallucination: true,
            citedPaths: [],
          }),
        }),
      );
    });
  });

  /**
   * CT04: Regressão Non-Realtime
   *
   * Scenario: A non-realtime demand (e.g., login screen improvement).
   * The PRD generation should work normally and contain all required sections.
   *
   * Expected: PRD format intact with all mandatory sections
   */
  describe('CT04: Regressão Non-Realtime', () => {
    it('deve gerar PRD com todas as seções obrigatórias para demanda non-realtime', async () => {
      const verifiedFiles: string[] = [];

      vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue(verifiedFiles);

      const completePrd = `# PRD - Melhoria na Tela de Login

## 1. Decisão De Produto
Simplificar o processo de login para melhorar a experiência do usuário.

## 2. Problema e Oportunidade
Usuários abandonam o fluxo de login devido à complexidade.

## 3. Escopo da Entrega
### Faremos
- Adicionar login social (Google)
- Simplificar formulário

### Não Faremos Agora
- Login biométrico

## 4. Métricas de Sucesso
- Redução de 30% no abandono de login

## 5. Riscos e Mitigações
- Risco: Dependência do OAuth Google. Mitigação: Manter login tradicional como fallback.

## Evidências do Refinamento
- Sem evidências verificáveis até o momento

**Evidence Block:**
\`\`\`json
{
  "sourceType": "blocked",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": []
}
\`\`\`
`;

      (openAIService.generateChatCompletion as any).mockResolvedValue(completePrd);

      const { AISquadService } = await import('../server/services/ai-squad');
      const service = new AISquadService();

      vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
      vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
      vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
      vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
      vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
      vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');
      vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation((doc) => doc);
      vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

      const demand = buildDemand({
        title: 'Melhoria na tela de login',
        description: 'Simplificar processo de autenticação',
        type: 'melhoria',
      });

      const result = await service.generatePRDWithPM(demand, [], 'test-model');

      // Verify PRD contains all mandatory sections
      expect(result).toContain('# PRD');
      expect(result).toContain('## 1. Decisão De Produto');
      expect(result).toContain('## 2. Problema e Oportunidade');
      expect(result).toContain('## 3. Escopo da Entrega');
      expect(result).toContain('### Faremos');
      expect(result).toContain('### Não Faremos Agora');
      expect(result).toContain('## 4. Métricas de Sucesso');
      expect(result).toContain('## 5. Riscos e Mitigações');

      // Should not have hallucination issues
      expect(logger.info).toHaveBeenCalledWith(
        'PRD/TSD evidence hallucination metric',
        expect.objectContaining({
          context: expect.objectContaining({
            hasHallucination: false,
          }),
        }),
      );
    });
  });

  /**
   * CT05: Métrica Agregada
   *
   * Scenario: Execute multiple realtime demands and verify the aggregate
   * hallucination rate is 0% (all LLM responses comply with allowed paths).
   *
   * Expected: 0% hallucination rate across all demands
   */
  describe('CT05: Métrica Agregada', () => {
    it('deve manter taxa de alucinação 0% quando LLM sempre obedece à lista permitida', async () => {
      const demands = [
        {
          id: 1,
          title: 'Realtime Feature 1',
          verifiedFiles: ['server/services/sse/manager.ts'],
        },
        {
          id: 2,
          title: 'Realtime Feature 2',
          verifiedFiles: ['server/services/sse/manager.ts', 'server/events/event-bus.ts'],
        },
        {
          id: 3,
          title: 'Realtime Feature 3',
          verifiedFiles: ['client/src/hooks/useSSE.ts'],
        },
      ];

      const hallucinationResults: boolean[] = [];

      // Capture hallucination status from each call
      (logger.info as any).mockImplementation((message: string, data: any) => {
        if (message === 'PRD/TSD evidence hallucination metric') {
          hallucinationResults.push(data.context.hasHallucination);
        }
      });

      const { AISquadService } = await import('../server/services/ai-squad');

      for (const demandData of demands) {
        vi.clearAllMocks();
        hallucinationResults.length = 0; // Clear for this iteration

        // Re-setup logger mock
        (logger.info as any).mockImplementation((message: string, data: any) => {
          if (message === 'PRD/TSD evidence hallucination metric') {
            hallucinationResults.push(data.context.hasHallucination);
          }
        });

        vi.spyOn(contextBuilder, 'getVerifiedEvidenceFiles').mockReturnValue(
          demandData.verifiedFiles,
        );

        // Mock repo to have the verified files
        (repoService.getRepoWithFiles as any).mockResolvedValue({
          id: 1,
          owner,
          name: repoName,
          files: demandData.verifiedFiles.map((path) => ({ path })),
        });

        // LLM obeys - returns only allowed files
        const mockPrd = buildPrdWithEvidence(demandData.verifiedFiles, 'direct_read');
        (openAIService.generateChatCompletion as any).mockResolvedValue(mockPrd);

        const service = new AISquadService();

        vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
        vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
        vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
        vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
        vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
        vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
        vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');
        vi.spyOn(PromptParser, 'appendDocumentEvidenceNote').mockImplementation((doc) => doc);
        vi.spyOn(PromptParser, 'ensurePrdContainsDemandType').mockImplementation((doc) => doc);
        vi.spyOn(PromptParser, 'ensurePrdReflectsRefinement').mockImplementation((doc) => doc);
        vi.spyOn(PromptParser, 'ensurePrdHasOperationalOrientation').mockImplementation(
          (doc) => doc,
        );
        vi.spyOn(PromptParser, 'ensurePrdMatchesRefinementType').mockImplementation((doc) => doc);

        const demand = buildDemand({
          id: demandData.id,
          title: demandData.title,
        });

        await service.generatePRDWithPM(demand, [], 'test-model');

        // Each demand should have no hallucination
        expect(hallucinationResults).toContain(false);
        expect(hallucinationResults.filter((h) => h === true)).toHaveLength(0);
      }
    });

    it('deve calcular taxa de alucinação corretamente quando algumas demandas têm LLM teimoso', async () => {
      const scenarios = [
        { id: 1, verified: ['file1.ts'], cited: ['file1.ts'], expectHallucination: false },
        {
          id: 2,
          verified: ['file2.ts'],
          cited: ['file2.ts', 'fake.ts'], // 'fake.ts' is hallucinated
          expectHallucination: true,
        },
        { id: 3, verified: ['file3.ts'], cited: ['file3.ts'], expectHallucination: false },
        { id: 4, verified: [], cited: [], expectHallucination: false },
      ];

      const hallucinationResults: { id: number; hasHallucination: boolean }[] = [];

      const scenarioVerifiedMap = new Map(scenarios.map((s) => [s.id, s.verified]));
      const scenarioCitedMap = new Map(scenarios.map((s) => [s.id, s.cited]));

      const verifiedSpy = vi
        .spyOn(contextBuilder, 'getVerifiedEvidenceFiles')
        .mockImplementation((id: number) => scenarioVerifiedMap.get(id) ?? []);
      const repoSpy = vi.spyOn(repoService, 'getRepoWithFiles');
      const chatSpy = vi.spyOn(openAIService, 'generateChatCompletion');
      const digestSpy = vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
      const evidenceNoteSpy = vi
        .spyOn(PromptParser, 'appendDocumentEvidenceNote')
        .mockImplementation((doc) => doc);
      const demandTypeSpy = vi
        .spyOn(PromptParser, 'ensurePrdContainsDemandType')
        .mockImplementation((doc) => doc);
      const reflectsSpy = vi
        .spyOn(PromptParser, 'ensurePrdReflectsRefinement')
        .mockImplementation((doc) => doc);
      const orientationSpy = vi
        .spyOn(PromptParser, 'ensurePrdHasOperationalOrientation')
        .mockImplementation((doc) => doc);
      const matchesSpy = vi
        .spyOn(PromptParser, 'ensurePrdMatchesRefinementType')
        .mockImplementation((doc) => doc);

      for (const scenario of scenarios) {
        (logger.info as any).mockImplementation((message: string, data: any) => {
          if (message === 'PRD/TSD evidence hallucination metric') {
            hallucinationResults.push({
              id: data.context.demandId,
              hasHallucination: data.context.hasHallucination,
            });
          }
        });

        // IMPORTANT: Mock repo to contain ALL cited files so they pass repo validation
        // This allows the ALLOWED_FILE_PATHS filtering logic to be tested
        repoSpy.mockResolvedValue({
          id: 1,
          owner,
          name: repoName,
          files: scenario.cited.map((path) => ({ path })),
        } as any);

        const sourceType = scenario.cited.length === 0 ? 'blocked' : 'direct_read';
        const mockPrd = buildPrdWithEvidence(scenario.cited, sourceType as any);
        chatSpy.mockResolvedValue(mockPrd as any);

        const { AISquadService } = await import('../server/services/ai-squad');
        const service = new AISquadService();

        vi.spyOn(service as any, 'resolveDemandRefinementType').mockReturnValue('business');
        vi.spyOn(service as any, 'getDemandTypePrdGuidance').mockReturnValue('');
        vi.spyOn(service as any, 'buildOperationalOrientation').mockReturnValue('');
        vi.spyOn(service as any, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
        vi.spyOn(service as any, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
        vi.spyOn(service as any, 'getBusinessPRDPrompt').mockReturnValue('');

        await service.generatePRDWithPM(buildDemand({ id: scenario.id }), [], 'test-model');
      }

      // Calculate hallucination rate per unique demand
      const totalDemands = scenarios.length;
      const hallucinatedDemands = new Set(
        hallucinationResults.filter((r) => r.hasHallucination).map((r) => r.id),
      );
      const hallucinatedCount = hallucinatedDemands.size;
      const hallucinationRate = (hallucinatedCount / totalDemands) * 100;

      // Expect 1 out of 4 to have hallucination = 25%
      expect(hallucinationRate).toBe(25);
      expect(hallucinatedCount).toBe(1);

      // Verify the specific demand that hallucinated
      expect(hallucinatedDemands.has(2)).toBe(true);
    });
  });
});
