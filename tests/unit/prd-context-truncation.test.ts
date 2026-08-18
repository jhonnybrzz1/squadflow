/**
 * Demanda 10110 — PRDs com descrições longas não devem incluir conteúdo bruto.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../server/db', () => ({
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

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletion: vi.fn(),
  },
}));

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn(),
    getRepoWithFiles: vi.fn(),
  },
}));

vi.mock('../../server/services/github', () => ({
  gitHubService: {
    verifyFilesExist: vi.fn(),
  },
}));

vi.mock('../../server/metrics', () => ({
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

vi.mock('../../server/storage', () => ({
  storage: {
    getDemand: vi.fn(),
    updateDemand: vi.fn(),
    createChatMessage: vi.fn(),
  },
}));

vi.mock('../../server/events/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../server/services/model-governance', () => ({
  validateContract: vi.fn(),
}));

import { openAIService } from '../../server/services/openai-ai';
import { PromptParser } from '../../server/services/ai-squad/prompt-parser';
import type { Demand } from '@shared/schema';

type SpyableSquad = Record<
  | 'resolveDemandRefinementType'
  | 'getDemandTypePrdGuidance'
  | 'buildOperationalOrientation'
  | 'resolveDocumentGenerationModel'
  | 'resolveDocumentGenerationFallback'
  | 'getBusinessPRDPrompt',
  (...args: unknown[]) => unknown
>;

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

async function buildService() {
  const { AISquadService } = await import('../../server/services/ai-squad');
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

describe('Demanda 10110: descrições longas são truncadas e o prompt prioriza refinamento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openAIService.generateChatCompletion).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('não inclui descrição bruta completa quando ela excede 4000 caracteres', async () => {
    const longDescription = 'Lorem ipsum dolor sit amet. '.repeat(200);
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('# PRD gerado');
    const service = await buildService();

    await service.generatePRDWithPM(
      buildDemand({ description: longDescription }),
      [],
      'test-model',
    );

    const calls = vi.mocked(openAIService.generateChatCompletion).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = calls.find((call) => {
      const prompt = call[1] as string;
      return prompt.includes('Descrição (sintetizada');
    });
    expect(firstCall).toBeDefined();
    const userPrompt = firstCall?.[1] as string;

    expect(userPrompt).toContain('[...descrição truncada');
    expect(userPrompt).not.toContain(longDescription);
    expect(userPrompt.length).toBeLessThan(longDescription.length + 5000);
  });

  it('mantém prioridade do refinamento da squad no prompt', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('# PRD gerado');
    const service = await buildService();

    await service.generatePRDWithPM(buildDemand(), [], 'test-model');

    const calls = vi.mocked(openAIService.generateChatCompletion).mock.calls;
    const systemPrompt = calls[0][0] as string;
    const userPrompt = calls[0][1] as string;

    expect(systemPrompt).toContain('REGRA DE SÍNTESE');
    expect(systemPrompt).toContain('NUNCA reproduza trechos longos');
    expect(userPrompt.indexOf('REFINAMENTO DA SQUAD')).toBeLessThan(
      userPrompt.indexOf('CONTRATO DO TIPO DE DEMANDA'),
    );
  });

  it('trunca descrições em 3 níveis de tamanho (curto <500, médio 500-1500, longo >1500 tokens)', async () => {
    const short = 'a'.repeat(400); // <500 tokens aprox
    const medium = 'a'.repeat(3000); // ~500-1500 tokens
    const long = 'Lorem ipsum dolor sit amet. '.repeat(400); // >1500 tokens

    const service = await buildService();
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValue('# PRD gerado');

    const prompts: string[] = [];
    for (const desc of [short, medium, long]) {
      vi.mocked(openAIService.generateChatCompletion).mockClear();
      await service.generatePRDWithPM(buildDemand({ description: desc }), [], 'test-model');
      const prdCall = vi
        .mocked(openAIService.generateChatCompletion)
        .mock.calls.find(
          (call) => typeof call[1] === 'string' && call[1].includes('=== SUA TAREFA'),
        );
      prompts.push((prdCall?.[1] as string) ?? '');
    }

    // Curto: descrição completa
    expect(prompts[0]).toContain(short);
    expect(prompts[0]).not.toContain('[...descrição truncada');

    // Médio: ainda completo (limite é 4000 chars)
    expect(prompts[1]).toContain(medium);

    // Longo: truncado
    expect(prompts[2]).toContain('[...descrição truncada');
    expect(prompts[2]).not.toContain(long);
  });
});
