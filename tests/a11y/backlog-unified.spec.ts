import { expect, test } from '@playwright/test';

test.describe('backlog unified page', () => {
  test('redirects /admin/backlog/activities to /admin/backlog?tab=activities', async ({ page }) => {
    await page.route('**/api/backlog/activities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activities: [] }),
      });
    });
    await page.route('**/api/demands', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/admin/backlog/activities');
    await page.waitForURL('/admin/backlog?tab=activities');
    await expect(page.getByTestId('backlog-unified-page')).toBeVisible();
  });

  test('switches tabs without reload and updates URL', async ({ page }) => {
    await page.route('**/api/backlog/activities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activities: [] }),
      });
    });
    await page.route('**/api/demands', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/admin/backlog');
    await expect(page.getByTestId('backlog-unified-page')).toBeVisible();

    const activitiesTab = page.getByRole('tab', { name: /atividades/i });
    await activitiesTab.click();
    await expect(page).toHaveURL('/admin/backlog?tab=activities');
    await expect(page.getByTestId('backlog-activities-page')).toBeVisible();

    const specsTab = page.getByRole('tab', { name: /catálogo de specs/i });
    await specsTab.click();
    await expect(page).toHaveURL('/admin/backlog?tab=specs');
    await expect(page.getByTestId('backlog-page')).toBeVisible();
  });

  test('renders empty state CTA on activities tab', async ({ page }) => {
    await page.route('**/api/backlog/activities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activities: [] }),
      });
    });
    await page.route('**/api/demands', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/admin/backlog?tab=activities');
    const cta = page.getByRole('link', { name: /iniciar refinamento/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/');
  });
});
