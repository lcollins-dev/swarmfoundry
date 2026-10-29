import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class DashboardPage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Dashboard', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/dashboard'));
  }
}
