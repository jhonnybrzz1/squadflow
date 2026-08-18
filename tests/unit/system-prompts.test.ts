import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveVersion = vi.hoisted(() => vi.fn());

vi.mock('../../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    isPostgres: false,
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

vi.mock('../../server/services/prompt-version', () => ({
  promptVersionService: {
    resolveVersion: (...args: any[]) => resolveVersion(...args),
  },
}));

describe('system-prompts getPromptForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveVersion.mockResolvedValue(null);
  });

  it('retorna prompt versionado do SQLite quando existe active version', async () => {
    resolveVersion.mockResolvedValue({
      version: '1.0.0',
      content: 'You are a versioned tech lead.',
      source: 'active',
    });

    const { getPromptForAgent } = await import('../../server/services/system-prompts');
    const result = await getPromptForAgent('tech_lead', 'session-1');

    expect(result).not.toBeNull();
    expect(result?.content).toBe('You are a versioned tech lead.');
    expect(result?.sourcePath).toBe('prompt_version:tech_lead:1.0.0');
    expect(resolveVersion).toHaveBeenCalledWith('tech_lead', 'session-1');
  });

  it('faz fallback para o system_prompt do YAML quando não há versão ativa', async () => {
    const { getPromptForAgent } = await import('../../server/services/system-prompts');
    const result = await getPromptForAgent('tech_lead', 'session-1');

    expect(result).not.toBeNull();
    expect(result?.content).toContain('PAPEL');
    expect(result?.sourcePath).toContain('agents/tech_lead.yaml');
  });

  it('faz fallback para prompts/system/{agent}.md quando não há YAML', async () => {
    const { getPromptForAgent } = await import('../../server/services/system-prompts');
    const result = await getPromptForAgent('nao_existe', 'session-1');

    expect(result).toBeNull();
  });

  it('faz fallback quando resolveVersion retorna conteúdo inválido', async () => {
    resolveVersion.mockResolvedValue({ version: '1.0.0', content: '   ', source: 'active' });

    const { getPromptForAgent } = await import('../../server/services/system-prompts');
    const result = await getPromptForAgent('tech_lead', 'session-1');

    expect(result).not.toBeNull();
    expect(result?.content).toContain('PAPEL');
  });
});
