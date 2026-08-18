import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const dashboard = {
  aiUsage: { estimatedCostUsd: 0, byModel: {}, totalTokens: 0, requestCount: 0 },
  system: {},
  rag: null,
  rerank: null,
  demands: { total: 0, completed: 0, processing: 0, error: 0 },
  governance: { reviewAdoptionRate: 0, approvedCount: 0, finalizedCount: 0, avgComments: 0 },
  validation: { invalidFilesBlocked: 0, totalFilesValidated: 0 },
  timestamp: '2026-07-16T12:00:00.000Z',
};

const responses = [
  { name: 'ok', body: { balance: 10, usage: 1, limit: 11, status: 'ok', stale: false } },
  { name: 'baixo', body: { balance: 0.5, usage: 1, limit: 1.5, status: 'low', stale: false } },
  { name: 'esgotado', body: { balance: 0, usage: 1, limit: 1, status: 'empty', stale: false } },
  { name: 'stale', body: { balance: 0.5, usage: 1, limit: 1.5, status: 'error', stale: true } },
] as const;

test('exibe e registra os estados principais do saldo OpenRouter', async ({ page }) => {
  const screenshotDir = path.join(process.cwd(), 'screenshots', 'spec-010');
  await fs.mkdir(screenshotDir, { recursive: true });
  let current = responses[0];

  await page.route('**/api/admin/dashboard', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dashboard),
    }),
  );
  await page.route('**/api/admin/feature-flags', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"flags":[]}' }),
  );
  await page.route('**/model-names', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }),
  );
  await page.route('**/api/billing/balance', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...current.body,
        currency: 'USD',
        cachedAt: '2026-07-16T12:00:00.000Z',
      }),
    }),
  );

  for (const state of responses) {
    current = state;
    await page.goto('/admin/dashboard');
    const card = page.getByRole('status').filter({ hasText: 'Saldo OpenRouter' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(
      state.name === 'ok'
        ? 'OK'
        : state.name === 'baixo'
          ? 'BAIXO'
          : state.name === 'esgotado'
            ? 'ESGOTADO'
            : 'STALE',
    );
    await card.screenshot({ path: path.join(screenshotDir, `${state.name}.png`) });
  }
});
