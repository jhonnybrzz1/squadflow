/**
 * Testes de integridade de dados & contrato
 * Spec 10124: bypass Zod, campos mortos, erros mascarados
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const metricLabels = vi.hoisted(() => vi.fn().mockReturnValue({ inc: vi.fn() }));

vi.mock('../../server/utils/logger', () => ({
  logger: {
    error: loggerError,
    warn: loggerWarn,
    info: loggerInfo,
    debug: vi.fn(),
  },
}));

vi.mock('../../server/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/metrics')>();
  return {
    ...actual,
    squadGraphBuildFailureTotal: { labels: metricLabels },
    register: { registerMetric: vi.fn() },
  };
});

import {
  createDemandPayloadSchema,
  parseInsertDemand,
  toSseSafeDemand,
} from '../../server/routes/shared';
import { toDemandListItem } from '../../server/routes/demand-presenter';
import { ProjectRealityReader } from '../../server/cognitive-core/project-reality-reader';

describe('Bug #8 — bypass de validação Zod', () => {
  it('rejeita campo desconhecido como isAdmin', () => {
    const result = createDemandPayloadSchema.safeParse({
      title: 'Teste',
      description: 'Descrição',
      type: 'bug',
      priority: 'alta',
      isAdmin: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const unknownIssue = result.error.issues.find(
        (i) => i.message.toLowerCase().includes('unrecognized') || i.path.join('.') === 'isAdmin',
      );
      expect(unknownIssue).toBeDefined();
    }
  });

  it('aceita campos injetados pelo orquestrador', () => {
    const result = createDemandPayloadSchema.safeParse({
      title: 'Teste',
      description: 'Descrição',
      type: 'bug',
      priority: 'alta',
      task_type: 'simple',
      additionalRepos: JSON.stringify(['owner/repo']),
      githubRepoOwner: 'owner',
      githubRepoName: 'repo',
      repo_url: 'https://github.com/owner/repo',
      skillRawUrl: '',
      roundtableAgentIds: 'po,tl,qa',
      maxRounds: '3',
      refinementLevel: '2',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_type).toBe('simple');
      expect(result.data.additionalRepos).toEqual(['owner/repo']);
      expect(result.data.githubRepoOwner).toBe('owner');
      expect(result.data.githubRepoName).toBe('repo');
      expect(result.data.roundtableAgentIds).toEqual(['po', 'tl', 'qa']);
      expect(result.data.maxRounds).toBe(3);
      expect(result.data.refinementLevel).toBe(2);
    }
  });

  it('parseInsertDemand lança ZodError para campo malicioso', () => {
    expect(() =>
      parseInsertDemand({
        title: 'Teste',
        description: 'Descrição',
        type: 'bug',
        priority: 'alta',
        externalId: 'injected',
      }),
    ).toThrow();
  });
});

describe('Bug #9 — campos mortos não expostos ao frontend', () => {
  const demand = {
    id: 1,
    title: 'Teste',
    description: 'Descrição',
    originalDescription: 'Original',
    qaEvidence: 'evidence',
    maxEffortOverrideDias: 10,
    maxEffortOverrideBy: 'user',
    maxEffortOverrideJustification: 'justification',
    chatMessages: [],
  } as any;

  it('toDemandListItem omite campos mortos', () => {
    const item = toDemandListItem(demand);
    expect(item).not.toHaveProperty('originalDescription');
    expect(item).not.toHaveProperty('qaEvidence');
    expect(item).not.toHaveProperty('maxEffortOverrideDias');
    expect(item).not.toHaveProperty('maxEffortOverrideBy');
    expect(item).not.toHaveProperty('maxEffortOverrideJustification');
  });

  it('toSseSafeDemand omite campos mortos', () => {
    const item = toSseSafeDemand(demand);
    expect(item).not.toHaveProperty('originalDescription');
    expect(item).not.toHaveProperty('qaEvidence');
    expect(item).not.toHaveProperty('maxEffortOverrideDias');
    expect(item).not.toHaveProperty('maxEffortOverrideBy');
    expect(item).not.toHaveProperty('maxEffortOverrideJustification');
  });
});

describe('Bug #10 — erros de SQLite não mascarados como info', () => {
  const originalReaddirSync = { current: undefined as any };

  beforeEach(() => {
    loggerError.mockClear();
    originalReaddirSync.current = (globalThis as any).readdirSyncPlaceholder;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('project-reality-reader loga error ao falhar leitura de diretório', () => {
    const reader = new ProjectRealityReader('/nonexistent/root');
    // Force readdirSync to throw by mocking fs directly inside the module is hard;
    // instead, use a root that cannot be read.
    reader.readProjectReality();

    expect(loggerError).toHaveBeenCalled();
    const call = loggerError.mock.calls[0][0];
    expect(call).toContain('database');
  });
});
