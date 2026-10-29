import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class AdminUserCreatePage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'New user', exact: true });
  }

  get nameInput(): Locator {
    return this.page.locator('input[name="display-name"]');
  }

  get emailInput(): Locator {
    return this.page.locator('input[name="email"]');
  }

  get passwordInput(): Locator {
    return this.page.locator('input[name="new-password"]');
  }

  get confirmPasswordInput(): Locator {
    return this.page.locator('input[name="confirm-password"]');
  }

  get createButton(): Locator {
    return this.page.getByRole('button', { name: 'Create User', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/admin/users/create'));
  }

  async fill(credentials: { name: string; email: string; password: string }): Promise<void> {
    await this.nameInput.fill(credentials.name);
    await this.emailInput.fill(credentials.email);
    await this.passwordInput.fill(credentials.password);
    await this.confirmPasswordInput.fill(credentials.password);
  }
}
