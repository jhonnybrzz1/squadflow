/**
 * Bug 1 da demanda 10071 — falha de LLM não pode virar documento falso.
 *
 * Antes do fix, uma resposta vazia/erro da LLM era substituída por um
 * documento-stub ("PRD gerado com base no refinamento da squad." / checklist
 * placeholder) que o caller persistia como se fosse real. Estes testes provam
 * que agora a geração ABORTA (AppError 502) e nada é persistido.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies BEFORE importing the service under test
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
  prdGroundingDegradedTotal: {
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

// AC do Bug 1: "nenhum documento é persistido" — o mock prova que o caminho de
// persistência nunca é alcançado quando a LLM devolve vazio.
vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: {
    save: vi.fn(),
  },
}));

// Import after mocks
import { openAIService } from '../server/services/openai-ai';
import { documentVersioningService } from '../server/services/document-versioning';
import { AppError } from '../server/middleware/error-handler';
import { PromptParser } from '../server/services/ai-squad/prompt-parser';
import type { Demand } from '@shared/schema';

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

// Métodos privados do parent que o gerador consome; tipados como shape para
// permitir vi.spyOn sem `any` (respeita o orçamento de lint no-explicit-any).
type SpyableSquad = Record<
  | 'resolveDemandRefinementType'
  | 'getDemandTypePrdGuidance'
  | 'buildOperationalOrientation'
  | 'resolveDocumentGenerationModel'
  | 'resolveDocumentGenerationFallback'
  | 'getBusinessPRDPrompt',
  (...args: unknown[]) => unknown
>;

async function buildService() {
  const { AISquadService } = await import('../server/services/ai-squad');
  const service = new AISquadService();
  const spyable = service as unknown as SpyableSquad;

  vi.spyOn(PromptParser, 'buildRefinementDigest').mockReturnValue('');
  vi.spyOn(spyable, 'resolveDemandRefinementType').mockReturnValue('business');
  vi.spyOn(spyable, 'getDemandTypePrdGuidance').mockReturnValue('');
  vi.spyOn(spyable, 'buildOperationalOrientation').mockReturnValue('');
  vi.spyOn(spyable, 'resolveDocumentGenerationModel').mockReturnValue('test-model');
  vi.spyOn(spyable, 'resolveDocumentGenerationFallback').mockReturnValue(undefined);
  vi.spyOn(spyable, 'getBusinessPRDPrompt').mockReturnValue('');

  return service;
}

describe('Bug 1 (10071): resposta vazia da LLM aborta a geração sem persistir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generatePRDWithPM lança AppError 502 PRD_GENERATION_FAILED quando a LLM devolve vazio', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('');
    const service = await buildService();

    // O DOCUMENT_GENERATION_EMPTY interno é re-embrulhado pelo catch externo em
    // PRD_GENERATION_FAILED — o que importa é: AppError 502, nunca um stub.
    await expect(service.generatePRDWithPM(buildDemand(), [], 'test-model')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(502);
        expect((err as AppError).errorCode).toBe('PRD_GENERATION_FAILED');
        return true;
      },
    );

    expect(documentVersioningService.save).not.toHaveBeenCalled();
  });

  it('generatePRDWithPM trata resposta só de whitespace como vazia', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('  \n\t ');
    const service = await buildService();

    await expect(service.generatePRDWithPM(buildDemand(), [], 'test-model')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).errorCode).toBe('PRD_GENERATION_FAILED');
        return true;
      },
    );

    expect(documentVersioningService.save).not.toHaveBeenCalled();
  });

  it('generateTasksWithPM converte o vazio em AppError 502 TASKS_GENERATION_FAILED (sem checklist-stub)', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('');
    const service = await buildService();

    await expect(
      service.generateTasksWithPM(buildDemand(), '# PRD - Test', 'test-model'),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(502);
      expect((err as AppError).errorCode).toBe('TASKS_GENERATION_FAILED');
      return true;
    });

    expect(documentVersioningService.save).not.toHaveBeenCalled();
  });
});

describe('Demanda 10079: geração de documentos não deve fail-closed em soluço do guardrail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Conteúdo do PRD/Tasks vem da squad já refinada, não de input bruto de
  // usuário — por isso deve seguir a mesma convenção de
  // roundtable-orchestrator.ts (failOpenOnError: true), para que um soluço
  // transitório do classificador de guardrails (JSON malformado, timeout,
  // etc.) não derrube a geração do documento inteiro.

  it('generatePRDWithPM chama a LLM com failOpenOnError: true', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('# PRD gerado');
    const service = await buildService();

    await service.generatePRDWithPM(buildDemand(), [], 'test-model');

    expect(openAIService.generateChatCompletion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ failOpenOnError: true }),
    );
  });

  it('generateTasksWithPM chama a LLM com failOpenOnError: true', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('## Agora\n- T1: teste');
    const service = await buildService();

    await service.generateTasksWithPM(buildDemand(), '# PRD - Test', 'test-model');

    expect(openAIService.generateChatCompletion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ failOpenOnError: true }),
    );
  });
});

/**
 * Auditoria 2026-08-03 — documento truncado não pode virar entregável.
 *
 * `llm_audit_logs` mostrou 7 das 8 últimas gerações de Tasks parando em
 * EXATAMENTE `completion_tokens = 2000`, o teto então vigente: o checklist saía
 * cortado no meio de uma frase e mesmo assim era persistido, versionado e
 * materializado em `specs/{id}-handoff/tasks.md` como se estivesse completo.
 * Ninguém lia `finish_reason`.
 */
describe('Auditoria 2026-08-03: geração de documentos detecta truncamento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generateTasksWithPM pede failOnTruncation e teto alinhado ao do PRD', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('## Agora\n- T1: teste');
    const service = await buildService();

    await service.generateTasksWithPM(buildDemand(), '# PRD - Test', 'test-model');

    expect(openAIService.generateChatCompletion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ failOnTruncation: true, maxTokens: 4000 }),
    );
  });

  it('generatePRDWithPM pede failOnTruncation', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('# PRD gerado');
    const service = await buildService();

    await service.generatePRDWithPM(buildDemand(), [], 'test-model');

    expect(openAIService.generateChatCompletion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ failOnTruncation: true }),
    );
  });

  it('truncamento aborta a geração — nenhum checklist parcial é devolvido', async () => {
    const { ResponseTruncatedError } = await import('../server/services/openai-ai/errors');
    vi.mocked(openAIService.generateChatCompletion).mockRejectedValue(
      new ResponseTruncatedError('document:tasks', 4000),
    );
    const service = await buildService();

    // O erro específico é logado com o objeto original (para quem opera) e
    // convertido na mensagem amigável do Bug 1 (para quem usa). O que importa
    // aqui é que a geração REJEITA: nada parcial volta para ser persistido.
    await expect(
      service.generateTasksWithPM(buildDemand(), '# PRD - Test', 'test-model'),
    ).rejects.toThrow(/Falha na geração das tasks/i);
  });
});
