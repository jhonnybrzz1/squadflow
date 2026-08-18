import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { F1_CLASSIFIER_PAYLOADS } from '../fixtures/demand-type-f1-payloads';
import { DemandFormPage } from './pages/demand-form.page';
import { DEMAND_TYPES } from '../../shared/demand-types';

test.describe('Spec 009 — classificação e badges', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/demands', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  });

  test('valida visualmente badges ativos e domínios especializados', async ({ page }) => {
    const form = new DemandFormPage(page);
    await form.goto();
    await expect(form.typeTab(/SEGURANÇA/i)).toBeVisible();
    await expect(form.typeTab(/REFACTORING/i)).toBeVisible();
    const infrastructure = form.typeTab(/INFRAESTRUTURA/i);
    await expect(infrastructure).toBeVisible();
    await expect(infrastructure).toBeEnabled();

    const colors = await Promise.all([
      form
        .typeTab(/SEGURANÇA/i)
        .locator('svg')
        .evaluate((element) => getComputedStyle(element).color),
      form
        .typeTab(/REFACTORING/i)
        .locator('svg')
        .evaluate((element) => getComputedStyle(element).color),
      infrastructure.locator('svg').evaluate((element) => getComputedStyle(element).color),
    ]);
    expect(colors).toEqual(['rgb(225, 29, 72)', 'rgb(100, 116, 139)', 'rgb(99, 102, 241)']);

    await page.getByText('DOMÍNIO', { exact: true }).locator('..').getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'PADRÃO' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'LEGALTECH / LGPD' })).toBeVisible();
    await page.keyboard.press('Escape');

    const screenshotDir = path.join(process.cwd(), 'screenshots', 'spec-009');
    await fs.mkdir(screenshotDir, { recursive: true });
    await page
      .getByRole('tablist', { name: 'Tipo de demanda' })
      .screenshot({ path: path.join(screenshotDir, 'badges-fases-1-2.png') });
  });

  test('exercita os 20 payloads mockados no fluxo da UI', async ({ page }) => {
    const form = new DemandFormPage(page);
    await form.goto();

    for (const payload of F1_CLASSIFIER_PAYLOADS) {
      await test.step(payload.id, async () => {
        await form.fillDemand(payload.title, payload.description);
        if (payload.expected === 'fallback') {
          await expect(form.fallbackBanner).toBeVisible();
          await expect(form.fallbackBanner).toContainText('Reclassificar manualmente?');
        } else {
          await expect(page.getByText('POSSÍVEL TIPO INCORRETO')).toBeVisible();
          await expect(
            page.getByRole('button', {
              name: new RegExp(DEMAND_TYPES[payload.expected].label, 'i'),
            }),
          ).toBeVisible();
        }
      });
    }
  });
});
