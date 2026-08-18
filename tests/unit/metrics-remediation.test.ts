import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as schema from '@shared/schema';
import type { DbClient } from '../../server/db';
import { register } from '../../server/metrics';
import { defineTool, executeTool, registerTool } from '../../server/services/agent-tools-registry';
import { DocuMenteExportService } from '../../server/services/docusmente-export';
import { GitHubService } from '../../server/services/github';

describe('mandatory remediation metrics', () => {
  let sqlite: Database.Database | undefined;

  afterAll(() => sqlite?.close());

  it('emits and exposes all five metrics with bounded labels after real operations', async () => {
    const github = new GitHubService('ghp_test_token');
    vi.spyOn(github, 'getDefaultBranchSha').mockResolvedValue('fixed-sha');
    vi.spyOn(github, 'getRepoContentWithMetadata')
      .mockResolvedValueOnce({
        data: { path: 'src/index.ts', size: 12, encoding: 'base64' } as never,
        rateLimit: { remaining: 40, resetAt: null },
      })
      .mockResolvedValueOnce({
        data: { path: 'assets/logo.png', size: 4, encoding: 'base64' } as never,
        rateLimit: { remaining: 39, resetAt: null },
      });
    vi.spyOn(github, 'getBinaryContent')
      .mockResolvedValueOnce(Buffer.from('export {}'))
      .mockResolvedValueOnce(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect((await github.getSafeTextContent('owner', 'repo', 'src/index.ts')).status).toBe(
      'content',
    );
    expect((await github.getSafeTextContent('owner', 'repo', 'assets/logo.png')).status).toBe(
      'omitted',
    );

    registerTool(
      defineTool({
        name: 'metrics_fast_internal',
        description: 'metric success',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        execute: async () => ({ ok: true, source: 'metrics_fast_internal' }),
      }),
    );
    registerTool(
      defineTool({
        name: 'metrics_slow_internal',
        description: 'metric timeout',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        timeoutMs: 5,
        execute: async () => new Promise(() => undefined),
      }),
    );
    await executeTool('metrics_fast_internal', {});
    await executeTool('metrics_slow_internal', {});

    sqlite = new Database(':memory:');
    sqlite.exec(fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'));
    sqlite.exec(
      fs.readFileSync(path.resolve('migrations/0032_reconcile_external_docs.sql'), 'utf8'),
    );
    const database = drizzle(sqlite, { schema });
    const exporter = new DocuMenteExportService(database as unknown as DbClient, {
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('unavailable'),
      } as unknown as Response),
      pollIntervalMs: 1,
      waitTimeoutMs: 20,
      leaseMs: 100,
    });
    expect(
      (
        await exporter.export({
          demandId: 901,
          title: 'Metric failure',
          docType: 'epic',
          prdContent: 'safe fixture',
          docuMenteUrl: 'http://localhost:3000',
        })
      ).status,
    ).toBe('failed');

    const scrape = await register.metrics();
    expect(scrape).toContain('# TYPE github_content_indexed counter');
    expect(scrape).toContain('# TYPE github_content_index_failure counter');
    expect(scrape).toContain('# TYPE tool_execution_duration histogram');
    expect(scrape).toContain('# TYPE tool_execution_timeout counter');
    expect(scrape).toContain('# TYPE documente_export_failure counter');

    const requiredSamples = scrape
      .split('\n')
      .filter((line) =>
        /^(?:github_content_indexed_total|github_content_index_failure_total|tool_execution_duration_(?:bucket|sum|count)|tool_execution_timeout_total|documente_export_failure_total)/.test(
          line,
        ),
      );
    expect(requiredSamples.length).toBeGreaterThan(5);
    expect(requiredSamples.join('\n')).toMatch(/source="file"/);
    expect(requiredSamples.join('\n')).toMatch(/reason="binary"/);
    expect(requiredSamples.join('\n')).toMatch(/tool_class="internal"/);
    expect(requiredSamples.join('\n')).toMatch(/outcome="(?:success|timeout)"/);
    expect(requiredSamples.join('\n')).not.toMatch(
      /(?:owner|repo|path|url|model|alias|prompt|error|message)=/,
    );
  });
});
