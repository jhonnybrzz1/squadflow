/**
 * MR-04 hot-path E2E. Provider SDK I/O and ancillary persistence sinks are
 * isolated; registry, bridge, governance, inference orchestration, promotion,
 * rollback and in-memory usage tracking execute their real implementations.
 */

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@shared/schema';
import type { DbClient } from '../../server/db';
import { clearModelFamiliesCache } from '../../server/services/model-family-rules';
import { ModelPromoter } from '../../server/services/model-promoter';
import { ModelRegistry, modelRegistry } from '../../server/services/model-registry';

vi.mock('../../server/services/openrouter-pricing', () => ({
  getCachedPricingWithMetadata: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../server/services/request-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/services/request-telemetry')>()),
  requestTelemetryService: { recordEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../server/services/llm-audit-log', () => ({
  llmAuditLogService: { record: vi.fn() },
}));

const ALIAS = 'deepseek-v4-flash-latest';
const CURRENT_MODEL = 'deepseek/deepseek-v4-flash';
const CANDIDATE_MODEL = 'deepseek/deepseek-v5-flash';
/**
 * The DeepSeek families are homologated to Tencent TokenHub, so the id that
 * actually reaches the client is the Tencent-normalized one (see
 * `normalizeModelForProvider`). `CANDIDATE_MODEL` is a hypothetical v5 id that
 * the normalization table does not know, so it is sent through unchanged.
 */
const CURRENT_MODEL_SENT = 'deepseek-v4-flash-202605';

const SCHEMA_SQL = `
  CREATE TABLE model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    active_model_id TEXT NOT NULL,
    fallback_model_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'static-fallback',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_validated_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at INTEGER,
    last_rollback_at INTEGER
  );
  CREATE TABLE model_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    current_model_id TEXT NOT NULL,
    candidate_model_id TEXT NOT NULL,
    candidate_version TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    selection_reason TEXT,
    evidence TEXT DEFAULT '{}',
    capabilities TEXT DEFAULT '{}',
    discovered_at INTEGER NOT NULL,
    validated_at INTEGER,
    validation_error TEXT
  );
  CREATE TABLE model_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    previous_model_id TEXT,
    new_model_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );
`;

describe('MR-04: persisted alias → real chat hot path → promotion → rollback', () => {
  let sqlite: Database.Database;
  let db: DbClient;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let testRegistry: ModelRegistry;
  let promoter: ModelPromoter;
  let restoreRegistryResolve: () => void;
  let restoreRegistryInvalidate: () => void;
  let restoreGetClient: () => void;
  let restoreHasClient: () => void;
  let restoreIsProviderAvailable: () => void;
  let providerCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.MODEL_REGISTRY_ENABLED = 'true';
    process.env.LLM_LOGS_ENABLED = 'false';
    clearModelFamiliesCache();
    sqlite = new Database(':memory:');
    sqlite.exec(SCHEMA_SQL);
    drizzleDb = drizzle(sqlite, { schema });
    db = drizzleDb as unknown as DbClient;
    testRegistry = new ModelRegistry(db);
    promoter = new ModelPromoter(db);

    const now = new Date();
    drizzleDb
      .insert(schema.modelAliases)
      .values({
        alias: ALIAS,
        family: 'deepseek-v4-flash',
        provider: 'tencent',
        activeModelId: CURRENT_MODEL,
        status: 'active',
        source: 'database',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    drizzleDb
      .insert(schema.modelCandidates)
      .values({
        alias: ALIAS,
        family: 'deepseek-v4-flash',
        provider: 'tencent',
        currentModelId: CURRENT_MODEL,
        candidateModelId: CANDIDATE_MODEL,
        status: 'discovered',
        selectionReason: 'mr-04-e2e',
        capabilities: { contextLength: 1_048_576, inputModalities: ['text'] },
        discoveredAt: now,
      })
      .run();

    const resolveSpy = vi
      .spyOn(modelRegistry, 'resolve')
      .mockImplementation((value) => testRegistry.resolve(value));
    const invalidateSpy = vi
      .spyOn(modelRegistry, 'invalidate')
      .mockImplementation((value) => testRegistry.invalidate(value));
    restoreRegistryResolve = () => resolveSpy.mockRestore();
    restoreRegistryInvalidate = () => invalidateSpy.mockRestore();

    providerCreate = vi.fn(async (payload: { model: string; stream?: boolean }) => {
      if (payload.stream) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: `stream:${payload.model}` } }] };
          },
        };
      }
      return {
        choices: [{ message: { content: `completion:${payload.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    });
    const { llmClientManager } = await import('../../server/services/llm-client-manager');
    const getClientSpy = vi
      .spyOn(llmClientManager, 'getClient')
      .mockReturnValue({ chat: { completions: { create: providerCreate } } } as never);
    const hasClientSpy = vi.spyOn(llmClientManager, 'hasClient').mockReturnValue(true);
    const isProviderAvailableSpy = vi
      .spyOn(llmClientManager, 'isProviderAvailable')
      .mockReturnValue(true);
    restoreGetClient = () => getClientSpy.mockRestore();
    restoreHasClient = () => hasClientSpy.mockRestore();
    restoreIsProviderAvailable = () => isProviderAvailableSpy.mockRestore();

    const { aiUsageTracker } = await import('../../server/services/ai-usage-tracker');
    aiUsageTracker.reset();
  });

  afterEach(() => {
    restoreRegistryResolve?.();
    restoreRegistryInvalidate?.();
    restoreGetClient?.();
    restoreHasClient?.();
    restoreIsProviderAvailable?.();
    sqlite.close();
    delete process.env.MODEL_REGISTRY_ENABLED;
    delete process.env.LLM_LOGS_ENABLED;
    vi.restoreAllMocks();
  });

  function activeModel(): string {
    return drizzleDb
      .select({ activeModelId: schema.modelAliases.activeModelId })
      .from(schema.modelAliases)
      .where(eq(schema.modelAliases.alias, ALIAS))
      .get()!.activeModelId;
  }

  it('changes non-streaming and streaming inference, tracking and governance across promotion/rollback', async () => {
    const { openAIService } = await import('../../server/services/openai-ai');
    const { aiUsageTracker } = await import('../../server/services/ai-usage-tracker');
    const { ModelGovernanceError, validateModelAllowed } =
      await import('../../server/services/model-governance');

    const generate = () =>
      openAIService.generateChatCompletionWithMetadata('system', 'hello', {
        model: CURRENT_MODEL,
        cache: false,
        semanticCacheDisabled: true,
        skipInjectionCheck: true,
        agentName: 'mr-04-e2e',
        operation: 'mr-04.non-stream',
      });
    const stream = () => {
      const chunks: string[] = [];
      return openAIService
        .generateChatCompletionStreamingWithMetadata('system', 'hello', {
          model: CURRENT_MODEL,
          cache: false,
          skipInjectionCheck: true,
          agentName: 'mr-04-e2e',
          operation: 'mr-04.stream',
          onChunk: (chunk) => chunks.push(chunk),
        })
        .then((result) => ({ result, chunks }));
    };

    expect((await testRegistry.resolve(ALIAS)).modelId).toBe(CURRENT_MODEL);
    const initial = await generate();
    expect(initial.metadata).toMatchObject({
      modelUsed: CURRENT_MODEL_SENT,
      provider: 'tencent',
    });

    const validation = await promoter.validate({ alias: ALIAS, candidateId: 1 });
    expect(validation.success).toBe(true);
    const promotion = await promoter.promote({
      alias: ALIAS,
      candidateId: 1,
      triggeredBy: 'mr-04-e2e',
    });
    expect(promotion.success).toBe(true);
    expect(activeModel()).toBe(CANDIDATE_MODEL);
    expect((await testRegistry.resolve(ALIAS)).modelId).toBe(CANDIDATE_MODEL);

    const promoted = await generate();
    expect(promoted.metadata).toMatchObject({
      modelUsed: CANDIDATE_MODEL,
      provider: 'tencent',
    });
    const promotedStream = await stream();
    expect(promotedStream.result.metadata.modelUsed).toBe(CANDIDATE_MODEL);
    expect(promotedStream.chunks).toEqual([`stream:${CANDIDATE_MODEL}`]);

    const providerCallsBeforeDenial = providerCreate.mock.calls.length;
    expect(() =>
      validateModelAllowed('unapproved/provider-model', 'mr-04-e2e', 'mr-04.governance-denial'),
    ).toThrow(ModelGovernanceError);
    expect(providerCreate).toHaveBeenCalledTimes(providerCallsBeforeDenial);

    const rollback = await promoter.rollback({ alias: ALIAS, triggeredBy: 'mr-04-e2e' });
    expect(rollback.success).toBe(true);
    expect(activeModel()).toBe(CURRENT_MODEL);
    const restored = await generate();
    expect(restored.metadata.modelUsed).toBe(CURRENT_MODEL_SENT);

    const usage = aiUsageTracker
      .getAllRecords()
      .filter((record) => record.operation.startsWith('mr-04.'));
    expect(usage.map((record) => record.model)).toEqual([
      `tencent:${CURRENT_MODEL_SENT}`,
      `tencent:${CANDIDATE_MODEL}`,
      `tencent:${CANDIDATE_MODEL}`,
      `tencent:${CURRENT_MODEL_SENT}`,
    ]);
    expect(usage.every((record) => record.modelAlias === ALIAS)).toBe(true);

    const history = drizzleDb
      .select()
      .from(schema.modelHistory)
      .where(eq(schema.modelHistory.alias, ALIAS))
      .all();
    expect(history.map((entry) => entry.action)).toEqual(['promoted', 'rolled_back']);
    expect(modelRegistry.invalidate).toHaveBeenCalledTimes(2);
  });
});
