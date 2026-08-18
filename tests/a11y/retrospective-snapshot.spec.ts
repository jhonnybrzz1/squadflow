import { expect, test } from '@playwright/test';

test.describe('retrospective snapshot and actions', () => {
  test('generates snapshot KPIs and creates an action end-to-end', async ({ page }) => {
    // Mock only the long-running / unrelated endpoints; let real POST/PATCH actions flow through.
    await page.route('**/api/retrospective/generate', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'retro-001',
          snapshot: {
            periodStart: '2026-07-19',
            periodEnd: '2026-07-26',
            demands: 10,
            completed: 8,
            failed: 2,
            tokens: 287400,
            cost: 0.0891,
          },
          actions: [],
        }),
      });
    });

    await page.goto('/admin/retrospectiva');
    await page.getByRole('button', { name: /gerar snapshot de evidência/i }).click();

    const snapshotPanel = page.getByTestId('snapshot-panel');
    await expect(snapshotPanel).toBeVisible();
    await expect(snapshotPanel.getByText('Volume de Demandas')).toBeVisible();
    await expect(snapshotPanel.getByText('287.400')).toBeVisible();
    await expect(snapshotPanel.getByText('80.0%')).toBeVisible();

    await page.getByRole('button', { name: /nova ação/i }).click();
    await page.getByPlaceholder(/ex: reduzir consumo de tokens/i).fill('Nova ação');
    await page.getByRole('button', { name: /salvar/i }).click();

    await expect(page.getByText('Nova ação')).toBeVisible();
  });
});
