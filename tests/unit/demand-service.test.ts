/* eslint-disable no-restricted-syntax -- test fixtures use agent role strings to exercise the service without importing shared enums. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DemandService } from '../../server/services/demand-service';
import { demandRepository } from '../../server/repositories/demand-repository';
import { demandGenerationJobsService } from '../../server/services/demand-generation-jobs';
import { enqueueDemandGenerationJob } from '../../server/workers/demand-generation-worker';
import { featureFlags } from '../../server/services/feature-flags';
import { repoService } from '../../server/services/repo-service';
import { resolveRefinementInput } from '../../server/services/refinement-input';
import { resolveDemandStartContract } from '../../server/services/demand-start-contract';
import {
  fetchSkillRawContent,
  wrapSkillContentAsUntrusted,
} from '../../server/services/skill-raw-fetch';
import { selectAgentsForDemand } from '../../server/services/dynamic-agent-triage';
import { MIN_ROUNDTABLE_AGENTS } from '@shared/agent-roles';

vi.mock('../../server/services/demand-generation-jobs', () => ({
  demandGenerationJobsService: {
    enqueue: vi.fn(),
  },
}));

vi.mock('../../server/workers/demand-generation-worker', () => ({
  enqueueDemandGenerationJob: vi.fn(),
}));

vi.mock('../../server/services/feature-flags', () => ({
  featureFlags: {
    getFlags: vi.fn(),
  },
}));

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn(),
  },
}));

vi.mock('../../server/services/refinement-input', () => ({
  resolveRefinementInput: vi.fn(),
  RefinementInputError: class RefinementInputError extends Error {
    errorCode = 'REFINEMENT_INPUT_ERROR';
  },
}));

vi.mock('../../server/services/demand-start-contract', () => ({
  resolveDemandStartContract: vi.fn(),
  parseInsertDemand: vi.fn(),
  createDemandPayloadSchema: {},
  refinementTypeSchema: {},
  type: {},
}));

vi.mock('../../server/services/skill-raw-fetch', () => ({
  fetchSkillRawContent: vi.fn(),
  wrapSkillContentAsUntrusted: vi.fn((content) => `\n<!-- skill.sh -->\n${content}`),
}));

vi.mock('../../server/services/dynamic-agent-triage', () => ({
  selectAgentsForDemand: vi.fn(),
}));

describe('DemandService.create', () => {
  it('delegates to repository.create with parsed data', async () => {
    const fakeDemand = { id: 1, title: 'Test' } as unknown as Awaited<
      ReturnType<typeof demandRepository.create>
    >;
    const repository = {
      create: vi.fn().mockResolvedValue(fakeDemand),
    } as unknown as typeof demandRepository;

    const result = await DemandService.create(
      {
        title: 'Test',
        description: 'desc',
        originalDescription: 'original',
        type: 'melhoria',
        priority: 'media',
      },
      repository,
    );

    expect(repository.create).toHaveBeenCalled();
    expect(result).toBe(fakeDemand);
  });
});

describe('DemandService.dispatch', () => {
  beforeEach(() => {
    vi.mocked(demandGenerationJobsService.enqueue).mockResolvedValue('job-123');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues demand generation job and returns generationJobId', async () => {
    const result = await DemandService.dispatch(42, {
      agentIds: ['product_owner', 'tech_lead'],
      maxRounds: 3,
      refinementLevel: 3,
    });

    expect(result.generationJobId).toBe('job-123');
    expect(demandGenerationJobsService.enqueue).toHaveBeenCalledWith(42, {
      agentIds: ['product_owner', 'tech_lead'],
      maxRounds: 3,
      refinementLevel: 3,
    });
    expect(enqueueDemandGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-123',
        demandId: 42,
        status: 'pending',
        attempts: 0,
      }),
    );
  });
});

describe('DemandService.enrich', () => {
  const baseInput = {
    title: 'T',
    description: 'Original description',
    type: 'melhoria' as const,
    priority: 'media' as const,
    files: [],
  };

  beforeEach(() => {
    vi.mocked(resolveRefinementInput).mockResolvedValue({
      ideaText: 'Idea text',
      refinementInputSource: 'text',
      documentTextLength: 0,
      ideaTextLength: 9,
    });
    vi.mocked(resolveDemandStartContract).mockReturnValue(null);
    vi.mocked(featureFlags.getFlags).mockReturnValue({ enableDynamicAgentTriage: false } as never);
    vi.mocked(selectAgentsForDemand).mockResolvedValue({
      selectedAgents: [],
      fallback: true,
      reasoning: '',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds createInput and generationConfig with defaults', async () => {
    const result = await DemandService.enrich(baseInput);

    expect(result.createInput.title).toBe('T');
    expect(result.createInput.description).toBe('Idea text');
    expect(result.createInput.originalDescription).toBe('Original description');
    expect(result.generationConfig.maxRounds).toBeGreaterThan(0);
    expect([1, 2, 3]).toContain(result.generationConfig.refinementLevel);
    expect(result.generationConfig.agentIds.length).toBeGreaterThan(0);
    expect(result.refinementMetadata.refinementInputSource).toBe('text');
  });

  it('appends repo context when githubRepoOwner/githubRepoName are provided', async () => {
    vi.mocked(repoService.getOrCreateRepo).mockResolvedValue({
      fullName: 'owner/repo',
      description: 'Repo desc',
      language: 'TypeScript',
    });

    const result = await DemandService.enrich({
      ...baseInput,
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
    });

    expect(repoService.getOrCreateRepo).toHaveBeenCalledWith('owner', 'repo');
    expect(result.createInput.description).toContain('Contexto do Repositório GitHub');
    expect(result.createInput.description).toContain('owner/repo');
    expect(result.createInput.repoFullName).toBe('owner/repo');
  });

  it('falls back to basic repo info when getOrCreateRepo returns no description', async () => {
    vi.mocked(repoService.getOrCreateRepo).mockResolvedValue({
      fullName: null,
      description: null,
      language: null,
    });

    const result = await DemandService.enrich({
      ...baseInput,
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
    });

    expect(result.createInput.description).toContain('owner/repo');
  });

  it('appends start contract markdown when present', async () => {
    vi.mocked(resolveDemandStartContract).mockReturnValue({
      readiness: 100,
      markdown: '## Contract',
    });

    const result = await DemandService.enrich({
      ...baseInput,
      demandStartContractPayload: '{}',
    });

    expect(resolveDemandStartContract).toHaveBeenCalled();
    expect(result.createInput.description).toContain('## Contract');
  });

  it('appends skill.sh content as untrusted when skillRawUrl is provided', async () => {
    vi.mocked(fetchSkillRawContent).mockResolvedValue({
      content: 'skill content',
      injectionWarning: undefined,
      rejectedReason: undefined,
    });

    const result = await DemandService.enrich({
      ...baseInput,
      skillRawUrl: 'https://skill.sh/test',
    });

    expect(fetchSkillRawContent).toHaveBeenCalledWith('https://skill.sh/test');
    expect(result.createInput.description).toContain('skill content');
    expect(wrapSkillContentAsUntrusted).toHaveBeenCalledWith('skill content');
  });

  it('uses dynamic triage when feature flag is on and no explicit agent ids', async () => {
    vi.mocked(featureFlags.getFlags).mockReturnValue({ enableDynamicAgentTriage: true } as never);
    vi.mocked(selectAgentsForDemand).mockResolvedValue({
      selectedAgents: ['product_owner', 'architect', 'tech_lead'],
      fallback: false,
      reasoning: 'reasoning text',
    });

    const result = await DemandService.enrich(baseInput);

    expect(selectAgentsForDemand).toHaveBeenCalled();
    expect(result.generationConfig.agentIds).toEqual(['product_owner', 'architect', 'tech_lead']);
    expect(result.roundtableConfig.triageReasoning).toBe('reasoning text');
  });

  // ALTO-01: o quórum é responsabilidade da triagem (topUpToQuorum). Se ela
  // devolvesse menos que o mínimo, a demanda era rejeitada com 400 no caminho
  // vivo de POST /api/demands.
  it('rejects a triage result below the roundtable quorum', async () => {
    vi.mocked(featureFlags.getFlags).mockReturnValue({ enableDynamicAgentTriage: true } as never);
    vi.mocked(selectAgentsForDemand).mockResolvedValue({
      selectedAgents: ['product_owner', 'architect'],
      fallback: false,
      reasoning: 'squad enxuta demais',
    });

    await expect(DemandService.enrich(baseInput)).rejects.toThrow(
      `Mesa redonda requer pelo menos ${MIN_ROUNDTABLE_AGENTS} agentes selecionados.`,
    );
  });

  it('uses explicit maxRounds when provided', async () => {
    const result = await DemandService.enrich({
      ...baseInput,
      maxRounds: 5,
    });

    expect(result.generationConfig.maxRounds).toBe(5);
    expect(result.roundtableConfig.maxRounds).toBe(5);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
  ] as const)('accepts refinementLevel=%d and keeps it', async (input, expected) => {
    const result = await DemandService.enrich({
      ...baseInput,
      type: 'melhoria',
      refinementLevel: input,
    });

    expect(result.generationConfig.refinementLevel).toBe(expected);
  });

  it('maps files into insertFileSchema shape', async () => {
    const file = {
      filename: 'file.pdf',
      originalname: 'file.pdf',
      mimetype: 'application/pdf',
      size: 1234,
      path: '/tmp/file.pdf',
    } as Express.Multer.File;

    const result = await DemandService.enrich({
      ...baseInput,
      files: [file],
    });

    expect(result.createInput.files).toHaveLength(1);
    expect(result.createInput.files?.[0]).toMatchObject({
      filename: 'file.pdf',
      originalName: 'file.pdf',
      mimeType: 'application/pdf',
      size: 1234,
      path: '/tmp/file.pdf',
    });
  });
});
