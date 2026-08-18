import { describe, expect, it, vi, beforeEach } from 'vitest';

const contextBuilderMock = vi.hoisted(() => ({
  clearEvolvingContext: vi.fn(),
  buildContext: vi.fn(),
  setExternalContext: vi.fn(),
  setRealityConstraints: vi.fn(),
  getRealityConstraintsText: vi.fn(),
  capContext: vi.fn((text: string) => text),
}));

const refinementMock = vi.hoisted(() => ({
  ingestFromDocuments: vi.fn(),
  buildContext: vi.fn(),
}));

const domainMock = vi.hoisted(() => ({
  buildContext: vi.fn(),
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../server/services/context-builder', () => ({
  contextBuilder: contextBuilderMock,
}));

vi.mock('../../server/services/refinement-rag', () => ({
  refinementRAGService: refinementMock,
}));

vi.mock('../../server/services/domain-knowledge-rag', () => ({
  domainKnowledgeRAGService: domainMock,
}));

vi.mock('../../server/utils/repo-context', () => ({
  resolveDemandRepoFullName: vi.fn(() => null),
}));

vi.mock('../../server/services/ai-squad/evaluation-gate', () => ({
  shouldSkipStage: vi.fn(() => true),
  logSkippedStages: vi.fn(),
}));

import { contextAssembler } from '../../server/services/ai-squad/context-assembler';

describe('ContextAssembler Reality Constraints (#10145)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextBuilderMock.buildContext.mockResolvedValue('BASE CONTEXT');
  });

  it('não chama setRealityConstraints quando realityBasedRefinement não é passado', async () => {
    const demand = {
      id: 1,
      title: 'Test',
      description: 'desc',
      type: 'bug',
    } as any;

    await contextAssembler.assembleInternalContext(demand);

    expect(contextBuilderMock.setRealityConstraints).not.toHaveBeenCalled();
  });

  it('chama setRealityConstraints e inclui reality block no contexto retornado', async () => {
    const demand = {
      id: 2,
      title: 'Bug crítico',
      description: 'desc',
      type: 'bug',
    } as any;

    const fakeReality = {
      getConstraintsForDemandType: vi.fn().mockResolvedValue({
        maturityLevel: 'MVP',
        demandType: 'bug',
        canonicalDemandType: 'bug',
        allowedTechnologies: ['TypeScript'],
        forbiddenTechnologies: ['kubernetes'],
        maxEffortDays: 3,
        minROI: 'N/A',
        outputType: 'bug_fix_plan',
        typeRequirements: ['Root cause analysis', 'Steps to reproduce'],
      }),
    };

    contextBuilderMock.getRealityConstraintsText.mockReturnValue(
      '--- REALITY CONSTRAINTS (MANDATORY) ---\nType Requirements: Root cause analysis, Steps to reproduce',
    );

    const internalContext = await contextAssembler.assembleInternalContext(
      demand,
      undefined,
      fakeReality as any,
    );

    expect(fakeReality.getConstraintsForDemandType).toHaveBeenCalledWith('bug');
    expect(contextBuilderMock.setRealityConstraints).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        demandType: 'bug',
        maxEffortDays: 3,
        outputType: 'bug_fix_plan',
        typeRequirements: ['Root cause analysis', 'Steps to reproduce'],
      }),
    );
    expect(internalContext).toContain('Root cause analysis');
    expect(internalContext).toContain('REALITY CONSTRAINTS');
  });

  it('P1 (auditoria 2026-07-26): marca constraints como indisponíveis quando getConstraintsForDemandType falha, sem fabricar tecnologias/esforço/ROI', async () => {
    const demand = {
      id: 3,
      title: 'Test',
      description: 'desc',
      type: 'security',
    } as any;

    const fakeReality = {
      getConstraintsForDemandType: vi.fn().mockRejectedValue(new Error('boom')),
    };

    contextBuilderMock.getRealityConstraintsText.mockReturnValue(
      '--- REALITY CONSTRAINTS (MANDATORY) ---\n[A DEFINIR — reality check indisponível]',
    );

    const internalContext = await contextAssembler.assembleInternalContext(
      demand,
      undefined,
      fakeReality as any,
    );

    expect(contextBuilderMock.setRealityConstraints).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        maturityLevel: 'MVP',
        demandType: 'security',
        allowedTechnologies: [],
        forbiddenTechnologies: [],
        maxEffortDays: 0,
        minROI: '[A DEFINIR]',
        typeRequirements: [],
        unavailable: true,
      }),
    );
    // Nunca fabricar uma lista técnica plausível no caminho de erro.
    const [, calledWith] = contextBuilderMock.setRealityConstraints.mock.calls[0];
    expect(calledWith.allowedTechnologies).not.toContain('TypeScript');
    expect(calledWith.forbiddenTechnologies).not.toContain('kubernetes');
    expect(internalContext).toContain('A DEFINIR');
  });
});
