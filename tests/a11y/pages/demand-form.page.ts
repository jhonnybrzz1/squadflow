import type { Locator, Page } from '@playwright/test';

export class DemandFormPage {
  readonly title: Locator;
  readonly description: Locator;
  readonly fallbackBanner: Locator;

  constructor(private readonly page: Page) {
    this.title = page.getByLabel(/TÍTULO DA DEMANDA/i);
    this.description = page.getByLabel(/DESCRIÇÃO DETALHADA/i);
    this.fallbackBanner = page.getByTestId('classifier-fallback-banner');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.page.getByRole('banner').waitFor();
  }

  async fillDemand(title: string, description: string): Promise<void> {
    await this.title.fill(title);
    await this.description.fill(description);
  }

  typeTab(name: RegExp): Locator {
    return this.page.getByRole('tab', { name });
  }
}
