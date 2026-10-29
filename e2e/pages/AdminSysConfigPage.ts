import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class AdminSysConfigPage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'System config', exact: true });
  }

  get registrationSwitch(): Locator {
    return this.page.getByRole('switch', { name: 'Registration', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/admin/sys-config'));
  }
}
