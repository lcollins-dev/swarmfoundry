import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class OverviewPage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Overview', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/overview'));
  }
}
