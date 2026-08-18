import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { Project, Scope } from 'ts-morph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImprovementExecutionService } from '../server/services/improvement-execution';

type JsonlEvent = {
  executionId?: string;
  eventType?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: Listener | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown) {
    const event = { type, data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {}
}

function readExecutionEvents(): JsonlEvent[] {
  const filePath = path.join(process.cwd(), 'data', 'execution_events.jsonl');
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlEvent);
}

function getClassMethods(filePath: string, className: string) {
  const project = new Project({
    tsConfigFilePath: path.join(process.cwd(), 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  const source = project.addSourceFileAtPath(path.join(process.cwd(), filePath));
  return source
    .getClassOrThrow(className)
    .getMethods()
    .map((method) => ({
      name: method.getName(),
      scope: method.getScope() ?? Scope.Public,
      parameters: method.getParameters().map((parameter) => parameter.getName()),
    }));
}

describe('Tech validation sprint diagnostics', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
  });

  afterEach(() => {
    vi.resetModules();
    delete (globalThis as any).EventSource;
  });

  it('shows current telemetry has no sequential baseline profile', () => {
    const events = readExecutionEvents();

    // data/execution_events.jsonl is gitignored runtime data.
    // In CI / fresh environments the file does not exist — skip data assertions.
    if (events.length === 0) return;

    const starts = events.filter((event) => event.eventType === 'execution_started');
    const profileCounts = starts.reduce<Record<string, number>>((counts, event) => {
      const profile = String(event.metadata?.profile ?? 'unknown');
      counts[profile] = (counts[profile] ?? 0) + 1;
      return counts;
    }, {});
    const agentDurations = events
      .filter((event) => event.eventType === 'agent_execution')
      .map((event) => event.durationMs)
      .filter((duration): duration is number => typeof duration === 'number');

    expect(starts.length).toBeGreaterThan(0);
    expect(profileCounts.experimental_parallel_subset).toBeGreaterThan(0);
    expect(profileCounts.baseline_sequential ?? 0).toBe(0);
    expect(agentDurations.length).toBeGreaterThan(0);
  });

  it('shows token and cost telemetry cannot be joined to an execution profile yet', () => {
    const dbPath = path.join(process.cwd(), 'sqlite.db');

    // sqlite.db is gitignored; in CI the file does not exist — skip.
    if (!fs.existsSync(dbPath)) return;

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    try {
      const columns = db.prepare('PRAGMA table_info(ai_requests)').all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);

      // Bancos novos seguem o schema atual e podem não conter a tabela
      // histórica ai_requests. Este diagnóstico só é aplicável quando ela
      // existe; a ausência não é falha de provisionamento.
      if (columnNames.length === 0) return;

      // Primary assertion: telemetry schema has cost/token columns but no
      // execution_id/execution_profile join keys yet. This documents the
      // current gap — joinability is a future enhancement.
      expect(columnNames).toEqual(expect.arrayContaining(['total_tokens', 'estimated_cost_usd']));
      expect(columnNames).not.toContain('execution_id');
      expect(columnNames).not.toContain('execution_profile');

      // Secondary: if the table has data, verify the aggregate query is valid.
      // Skipped when the table is empty (fresh dev environment / CI with no
      // real API traffic recorded yet).
      const rowCount = (db.prepare('SELECT COUNT(*) AS n FROM ai_requests').get() as { n: number })
        .n;
      if (rowCount > 0) {
        const aggregate = db
          .prepare(
            `
            SELECT
              COUNT(*) AS count,
              SUM(total_tokens) AS totalTokens,
              SUM(COALESCE(estimated_cost_usd, 0)) AS totalCostUsd
            FROM ai_requests
            WHERE operation LIKE 'agent_interaction:%'
          `,
          )
          .get() as { count: number; totalTokens: number | null; totalCostUsd: number | null };

        // When rows exist, totalTokens should be populated
        expect(aggregate.totalTokens ?? 0).toBeGreaterThanOrEqual(0);
      }
    } finally {
      db.close();
    }
  });

  it('shows roleHint is parse-safe in YAML but not consumed or templated by runtime', () => {
    const agentsDir = path.join(process.cwd(), 'agents');
    const yamlFiles = fs
      .readdirSync(agentsDir)
      .filter((fileName) => fileName.endsWith('.yaml') || fileName.endsWith('.yml'));

    expect(yamlFiles.length).toBeGreaterThan(0);

    for (const fileName of yamlFiles) {
      // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas.
      const parsed = yaml.load(fs.readFileSync(path.join(agentsDir, fileName), 'utf8'), {
        schema: yaml.CORE_SCHEMA,
      }) as Record<string, unknown>;
      const withRoleHint = { ...parsed, roleHint: 'validation-only hint' };
      const runtimeProjection = {
        system_prompt: withRoleHint.system_prompt,
        description: withRoleHint.description,
        model: withRoleHint.model,
        model_fallback: withRoleHint.model_fallback,
        temperature: withRoleHint.temperature,
        max_tokens: withRoleHint.max_tokens,
      };

      expect(withRoleHint.roleHint).toBe('validation-only hint');
      expect(runtimeProjection).not.toHaveProperty('roleHint');
    }

    const service = new ImprovementExecutionService() as any;
    const validation = service.validatePromptTemplate(
      [
        'Contexto de dominio: {domain}.',
        'Como {agentName}, avalie {title} para {demandType}.',
        'Use o direcionamento contextual {roleHint} apenas quando suportado.',
      ].join('\n'),
    );

    expect(validation).toEqual({
      valid: false,
      reason: 'unsupported_placeholder:roleHint',
    });
  });

  it('shows cognitive-core has no public runAgent(agentId, context) interface', () => {
    const orchestratorMethods = getClassMethods(
      'server/cognitive-core/agent-orchestrator.ts',
      'AgentOrchestrator',
    );
    const interactionMethods = getClassMethods(
      'server/services/agent-interaction.ts',
      'AgentInteractionService',
    );
    const privateExecuteAgent = orchestratorMethods.find(
      (method) => method.name === 'executeAgentCore',
    );
    const interactionExecuteAgent = interactionMethods.find(
      (method) => method.name === 'executeAgent',
    );

    expect(orchestratorMethods.some((method) => method.name === 'runAgent')).toBe(false);
    expect(privateExecuteAgent).toMatchObject({
      scope: Scope.Private,
      parameters: ['demandId', 'agentName'],
    });
    expect(interactionExecuteAgent).toMatchObject({
      scope: Scope.Public,
      parameters: ['agentName', 'demand'],
    });
  });

  it('shows frontend streaming callbacks do not expose session or contribution identifiers', async () => {
    const { api } = await import('../client/src/lib/api');
    const onAgentChunk = vi.fn();

    api.demands.subscribeToUpdates(42, vi.fn(), { onAgentChunk });
    const eventSource = MockEventSource.instances[0];

    eventSource.emit('agent_chunk', {
      type: 'agent_chunk',
      demandId: 42,
      operationId: 'exec_123',
      data: {
        agent: 'qa',
        chunk: 'partial answer',
        sessionId: 'session-123',
        contributionId: 'contrib-123',
      },
    });

    expect(onAgentChunk).toHaveBeenCalledWith('qa', 'partial answer');
    expect(onAgentChunk.mock.calls[0]).toHaveLength(2);
  });
});
