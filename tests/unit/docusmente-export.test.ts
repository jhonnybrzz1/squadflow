import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@shared/schema';
import type { DbClient } from '../../server/db';
import { DocuMenteExportService } from '../../server/services/docusmente-export';

const EXPORT_OPTIONS = {
  demandId: 7,
  title: 'Demand 7 - Epic',
  docType: 'epic' as const,
  prdContent: 'PRD content',
  docuMenteUrl: 'http://localhost:3000',
  apiKey: 'test-api-key',
};

function successResponse(id = 'ext-1', url = 'https://documente.local/doc/1'): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ id, url }),
  } as unknown as Response;
}

describe('DocuMenteExportService claim/lease', () => {
  let sqlite: Database.Database;
  let database: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'));
    sqlite.exec(
      fs.readFileSync(path.resolve('migrations/0032_reconcile_external_docs.sql'), 'utf8'),
    );
    database = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    sqlite.close();
  });

  function createService(fetchFn: typeof fetch, overrides = {}) {
    return new DocuMenteExportService(database as unknown as DbClient, {
      fetchFn,
      leaseMs: 250,
      waitTimeoutMs: 500,
      pollIntervalMs: 5,
      ...overrides,
    });
  }

  function rows() {
    return database.select().from(schema.demandExternalDocs).all();
  }

  it('returns a restart-visible successful export without another remote call', async () => {
    database
      .insert(schema.demandExternalDocs)
      .values({
        ...EXPORT_OPTIONS,
        docuMenteUrl: EXPORT_OPTIONS.docuMenteUrl,
        status: 'success',
        externalId: 'existing-id',
        externalUrl: 'https://documente.local/existing',
        isCurrent: true,
        createdAt: new Date(),
      })
      .run();
    const fetchFn = vi.fn<typeof fetch>();
    const restartedService = createService(fetchFn);

    const result = await restartedService.export(EXPORT_OPTIONS);

    expect(result).toMatchObject({
      ok: true,
      status: 'already_exported',
      externalId: 'existing-id',
      externalUrl: 'https://documente.local/existing',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows exactly one remote request for two concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await gate;
      return successResponse();
    });
    const service = createService(fetchFn);

    const first = service.export(EXPORT_OPTIONS);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const second = service.export(EXPORT_OPTIONS);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(firstResult.status).toBe('success');
    expect(secondResult.status).toBe('already_exported');
    expect(firstResult.externalUrl).toBe(secondResult.externalUrl);
    expect(rows()).toHaveLength(1);
  });

  it('uses the persisted lease to deduplicate callers from separate service instances', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await gate;
      return successResponse();
    });
    const firstService = createService(fetchFn);
    const secondService = createService(fetchFn);

    const claimStartedAt = Date.now();
    const first = firstService.export(EXPORT_OPTIONS);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(rows()[0].leaseExpiresAt?.getTime()).toBeGreaterThanOrEqual(claimStartedAt + 250);
    const second = secondService.export(EXPORT_OPTIONS);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await Promise.all([first, second]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('permits only the current owner token to finalize', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await gate;
      return successResponse();
    });
    const service = createService(fetchFn);
    const pending = service.export(EXPORT_OPTIONS);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    database
      .update(schema.demandExternalDocs)
      .set({ operationToken: 'new-owner-token' })
      .where(eq(schema.demandExternalDocs.demandId, EXPORT_OPTIONS.demandId))
      .run();
    release();

    expect(await pending).toMatchObject({
      ok: false,
      status: 'failed',
      errorMessage: 'Export ownership expired.',
    });
    expect(rows()[0].status).toBe('pending');
    expect(rows()[0].operationToken).toBe('new-owner-token');
  });

  it('takes over an expired lease', async () => {
    database
      .insert(schema.demandExternalDocs)
      .values({
        demandId: EXPORT_OPTIONS.demandId,
        docType: EXPORT_OPTIONS.docType,
        docuMenteUrl: EXPORT_OPTIONS.docuMenteUrl,
        status: 'pending',
        isCurrent: true,
        operationToken: 'abandoned-owner',
        leaseExpiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(),
      })
      .run();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(successResponse());

    const result = await createService(fetchFn).export(EXPORT_OPTIONS);

    expect(result.status).toBe('success');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(rows()[0].operationToken).toBeNull();
  });

  it('persists failure and allows a new service instance to retry', async () => {
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('unavailable'),
    } as unknown as Response);
    const first = await createService(failedFetch).export(EXPORT_OPTIONS);
    expect(first.status).toBe('failed');
    expect(rows()[0].status).toBe('failed');

    const retryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse('retry-id', 'https://documente.local/retry'));
    const restartedService = createService(retryFetch);
    const retried = await restartedService.export(EXPORT_OPTIONS);

    expect(retried).toMatchObject({
      ok: true,
      status: 'success',
      externalId: 'retry-id',
    });
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });
});
