import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const screenshotDir = path.join(process.cwd(), 'screenshots', 'reduced-motion');

const animatedTargets = [
  {
    key: 'header-pulse',
    selector: '.animate-pulse',
    description: 'Badge pulsante do header/home',
  },
  {
    key: 'squad-status-dot',
    selector: '.status-dot',
    description: 'Indicador online da squad',
  },
] as const;

function durationToMs(rawValue: string): number {
  const value = rawValue.split(',')[0]?.trim() ?? '0ms';

  if (value.endsWith('ms')) {
    return Number.parseFloat(value);
  }

  if (value.endsWith('s')) {
    return Number.parseFloat(value) * 1000;
  }

  return Number.NaN;
}

test.describe('reduced motion accessibility', () => {
  test('freezes animated home elements when prefers-reduced-motion is reduce', async ({ page }) => {
    await fs.mkdir(screenshotDir, { recursive: true });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/demands', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
    await page.route('**/api/demands/*/messages', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();

    await page.getByRole('button', { name: /squad ativa/i }).click();
    await expect(page.locator('#squad-content')).toBeVisible();

    const missingTargets: string[] = [];

    for (const target of animatedTargets) {
      const locator = page.locator(target.selector).first();
      const count = await page.locator(target.selector).count();

      if (count === 0) {
        missingTargets.push(`${target.description} (${target.selector})`);
        continue;
      }

      await expect(locator).toBeVisible();

      const style = await locator.evaluate((element) => {
        const computed = window.getComputedStyle(element);
        return {
          animationName: computed.animationName,
          animationDuration: computed.animationDuration,
          transitionDuration: computed.transitionDuration,
          transform: computed.transform,
          opacity: computed.opacity,
          filter: computed.filter,
        };
      });

      const animationDurationMs = durationToMs(style.animationDuration);
      expect(
        animationDurationMs <= 0.01,
        `${target.description}: animationDuration esperado <= 0.01ms, recebido ${style.animationDuration}`,
      ).toBeTruthy();

      expect(
        style.transform === 'none',
        `${target.description}: transform residual detectado (${style.transform})`,
      ).toBeTruthy();

      const screenshotPaths: string[] = [];
      const visualStates: Array<{ opacity: string; transform: string; filter: string }> = [];
      for (let index = 0; index < 3; index += 1) {
        const filename = `${target.key}-${index + 1}.png`;
        const absolutePath = path.join(screenshotDir, filename);
        screenshotPaths.push(absolutePath);
        await locator.screenshot({ path: absolutePath });
        visualStates.push(
          await locator.evaluate((element) => {
            const computed = window.getComputedStyle(element);
            return {
              opacity: computed.opacity,
              transform: computed.transform,
              filter: computed.filter,
            };
          }),
        );
        if (index < 2) {
          await page.waitForTimeout(200);
        }
      }

      const screenshotStats = await Promise.all(
        screenshotPaths.map((filePath) => fs.stat(filePath)),
      );

      expect(
        screenshotStats.every((entry) => entry.size > 0),
        `${target.description}: screenshots nao foram persistidos corretamente`,
      ).toBeTruthy();

      expect(
        visualStates.every(
          (state) =>
            state.opacity === visualStates[0].opacity &&
            state.transform === visualStates[0].transform &&
            state.filter === visualStates[0].filter,
        ),
        `${target.description}: estado visual variou entre frames sob reduced motion`,
      ).toBeTruthy();
    }

    expect(
      missingTargets,
      `Nenhum elemento encontrado para validacao: ${missingTargets.join(', ') || 'lista vazia'}`,
    ).toHaveLength(0);
  });
});
