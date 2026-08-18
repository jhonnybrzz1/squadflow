/** DocuMente export with persisted claim/lease concurrency control. */

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';

import { demandExternalDocs } from '@shared/schema';
import { db as defaultDb, dbTransaction, type DbClient } from '../db';
import { documenteExportFailureTotal, documenteExportTotal } from '../metrics';
import { logger } from '../utils/logger';
import { asReader, asWriter } from './drizzle-helpers';

export interface DocuMenteExportResult {
  ok: boolean;
  externalId?: string;
  externalUrl?: string;
  status: 'success' | 'failed' | 'already_exported';
  errorMessage?: string;
}

export interface DocuMenteExportOptions {
  demandId: number;
  title: string;
  docType: 'epic' | 'userstories';
  prdContent: string;
  docuMenteUrl: string;
  apiKey?: string;
}

interface ExportRow {
  id: number;
  externalId: string | null;
  externalUrl: string | null;
  status: 'pending' | 'success' | 'failed';
  operationToken: string | null;
  leaseExpiresAt: Date | null;
}

interface ClaimOwner {
  kind: 'owner';
  id: number;
  token: string;
}

interface ClaimWait {
  kind: 'wait';
}

interface ClaimComplete {
  kind: 'complete';
  row: ExportRow;
}

type ClaimResult = ClaimOwner | ClaimWait | ClaimComplete;

interface DocuMenteExportServiceOptions {
  fetchFn?: typeof fetch;
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class DocuMenteExportService {
  private readonly inFlight = new Map<string, Promise<DocuMenteExportResult>>();
  private readonly fetchFn: typeof fetch;
  private readonly leaseMs: number;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly database: DbClient = defaultDb,
    options: DocuMenteExportServiceOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
  }

  async export(options: DocuMenteExportOptions): Promise<DocuMenteExportResult> {
    const key = `${options.demandId}:${options.docType}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      const result = await existing;
      return result.ok ? { ...result, status: 'already_exported' } : result;
    }

    const operation = this.exportWithClaim(options);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async exportWithClaim(options: DocuMenteExportOptions): Promise<DocuMenteExportResult> {
    const claim = await this.claim(options);
    if (claim.kind === 'complete') return this.fromExisting(options.docType, claim.row);
    if (claim.kind === 'wait') return this.waitForOwner(options);
    return this.performOwnedExport(options, claim);
  }

  private async claim(options: DocuMenteExportOptions): Promise<ClaimResult> {
    const token = randomUUID();
    const now = new Date();
    // SQLite's Drizzle `timestamp` mode persists whole seconds. Round the
    // requested deadline up so a sub-second lease can never expire earlier
    // than configured merely because fractional milliseconds were truncated.
    const leaseExpiresAt = new Date(Math.ceil((now.getTime() + this.leaseMs) / 1000) * 1000);

    return dbTransaction(async (tx) => {
      let row = await this.findCurrent(tx, options.demandId, options.docType);
      if (!row) {
        const insertion = (asWriter(tx) as any).insert(demandExternalDocs).values({
          demandId: options.demandId,
          docType: options.docType,
          docuMenteUrl: options.docuMenteUrl,
          status: 'pending',
          isCurrent: true,
          operationToken: token,
          leaseExpiresAt,
          createdAt: now,
        });
        const inserted = (await insertion
          .onConflictDoNothing()
          .returning({ id: demandExternalDocs.id })) as Array<{ id: number }>;
        if (inserted[0]) return { kind: 'owner', id: inserted[0].id, token };
        row = await this.findCurrent(tx, options.demandId, options.docType);
      }

      if (!row) throw new Error('claim-row-unavailable');
      if (row.status === 'success') return { kind: 'complete', row };
      if (
        row.status === 'pending' &&
        row.operationToken &&
        row.leaseExpiresAt &&
        row.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return { kind: 'wait' };
      }

      const claimed = (await (asWriter(tx) as any)
        .update(demandExternalDocs)
        .set({
          status: 'pending',
          docuMenteUrl: options.docuMenteUrl,
          errorMessage: null,
          externalId: null,
          externalUrl: null,
          completedAt: null,
          operationToken: token,
          leaseExpiresAt,
        })
        .where(
          and(
            eq(demandExternalDocs.id, row.id),
            eq(demandExternalDocs.isCurrent, true),
            or(
              ne(demandExternalDocs.status, 'pending'),
              isNull(demandExternalDocs.operationToken),
              isNull(demandExternalDocs.leaseExpiresAt),
              lte(demandExternalDocs.leaseExpiresAt, now),
            ),
          ),
        )
        .returning({ id: demandExternalDocs.id })) as Array<{ id: number }>;
      if (!claimed[0]) return { kind: 'wait' };
      return { kind: 'owner', id: row.id, token };
    }, this.database);
  }

  private async waitForOwner(options: DocuMenteExportOptions): Promise<DocuMenteExportResult> {
    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const row = await this.findCurrent(this.database, options.demandId, options.docType);
      if (!row || row.status === 'failed') return this.export(options);
      if (row.status === 'success') return this.fromExisting(options.docType, row);
      if (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now()) {
        return this.export(options);
      }
    }

    documenteExportFailureTotal.labels({ reason: 'wait_timeout' }).inc();
    return {
      ok: false,
      status: 'failed',
      errorMessage: 'A DocuMente export is still in progress. Try again shortly.',
    };
  }

  private async performOwnedExport(
    options: DocuMenteExportOptions,
    claim: ClaimOwner,
  ): Promise<DocuMenteExportResult> {
    // H-7: removed hardcoded 'documente_dev_key' fallback — a hardcoded
    // API key in source code is a credential leak. If no key is provided
    // via options or env, the export fails with a clear error instead of
    // silently using a known key that could be exploited.
    const effectiveApiKey = options.apiKey || process.env.DOCUMENTE_API_KEY;
    if (!effectiveApiKey) {
      await this.markFailed(claim, 'DOCUMENTE_API_KEY not configured');
      this.recordFailure(options.docType, 'missing_api_key');
      documenteExportFailureTotal.labels({ reason: 'missing_api_key' }).inc();
      return {
        ok: false,
        status: 'failed',
        errorMessage: 'DocuMente export failed: DOCUMENTE_API_KEY is not set.',
      };
    }
    try {
      const response = await this.fetchFn(`${options.docuMenteUrl}/api/external/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': effectiveApiKey },
        body: JSON.stringify({
          title: options.title,
          type: options.docType,
          demand: options.prdContent,
          calculateQuality: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        await this.markFailed(claim, `HTTP ${response.status}: ${details.slice(0, 200)}`);
        this.recordFailure(options.docType, 'http');
        return {
          ok: false,
          status: 'failed',
          errorMessage: `DocuMente returned HTTP ${response.status}`,
        };
      }

      const body = (await response.json()) as { id?: string; url?: string };
      const finalized = (await (asWriter(this.database) as any)
        .update(demandExternalDocs)
        .set({
          status: 'success',
          externalId: body.id ?? null,
          externalUrl: body.url ?? null,
          completedAt: new Date(),
          operationToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(demandExternalDocs.id, claim.id),
            eq(demandExternalDocs.operationToken, claim.token),
          ),
        )
        .returning({ id: demandExternalDocs.id })) as Array<{ id: number }>;
      if (!finalized[0]) {
        this.recordFailure(options.docType, 'ownership');
        return { ok: false, status: 'failed', errorMessage: 'Export ownership expired.' };
      }

      documenteExportTotal.labels({ doc_type: options.docType, outcome: 'success' }).inc();
      return { ok: true, externalId: body.id, externalUrl: body.url, status: 'success' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.markFailed(claim, message);
      this.recordFailure(options.docType, 'network');
      logger.warn('DocuMente export failed', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: options.demandId, docType: options.docType },
      });
      return { ok: false, status: 'failed', errorMessage: message };
    }
  }

  private async markFailed(claim: ClaimOwner, errorMessage: string): Promise<void> {
    await asWriter(this.database)
      .update(demandExternalDocs)
      .set({
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
        operationToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(demandExternalDocs.id, claim.id),
          eq(demandExternalDocs.operationToken, claim.token),
        ),
      );
  }

  private recordFailure(docType: DocuMenteExportOptions['docType'], reason: string): void {
    documenteExportTotal.labels({ doc_type: docType, outcome: 'failed' }).inc();
    documenteExportFailureTotal.labels({ reason }).inc();
  }

  private fromExisting(
    docType: DocuMenteExportOptions['docType'],
    row: ExportRow,
  ): DocuMenteExportResult {
    documenteExportTotal.labels({ doc_type: docType, outcome: 'already_exported' }).inc();
    return {
      ok: true,
      externalId: row.externalId ?? undefined,
      externalUrl: row.externalUrl ?? undefined,
      status: 'already_exported',
    };
  }

  private async findCurrent(
    database: DbClient,
    demandId: number,
    docType: DocuMenteExportOptions['docType'],
  ): Promise<ExportRow | undefined> {
    const rows = (await asReader(database)
      .select({
        id: demandExternalDocs.id,
        externalId: demandExternalDocs.externalId,
        externalUrl: demandExternalDocs.externalUrl,
        status: demandExternalDocs.status,
        operationToken: demandExternalDocs.operationToken,
        leaseExpiresAt: demandExternalDocs.leaseExpiresAt,
      })
      .from(demandExternalDocs)
      .where(
        and(
          eq(demandExternalDocs.demandId, demandId),
          eq(demandExternalDocs.docType, docType),
          eq(demandExternalDocs.isCurrent, true),
        ),
      )
      .limit(1)) as unknown as ExportRow[];
    return rows[0];
  }

  async listForDemand(demandId: number) {
    return asReader(this.database)
      .select()
      .from(demandExternalDocs)
      .where(eq(demandExternalDocs.demandId, demandId));
  }
}

export const docuMenteExportService = new DocuMenteExportService();
