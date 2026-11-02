import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class SetPasswordPage {
  constructor(private readonly page: Page) {}

  get form(): Locator {
    return this.page.getByTestId('set-password-form');
  }

  get problem(): Locator {
    return this.page.getByTestId('set-password-problem');
  }

  get passwordInput(): Locator {
    return this.page.locator('input[name="new-password"]');
  }

  get confirmPasswordInput(): Locator {
    return this.page.locator('input[name="confirm-password"]');
  }

  async goto(token: string): Promise<void> {
    await this.page.goto(webRoute(`/set-password#${token}`));
  }

  async choose(password: string, submitLabel: string): Promise<void> {
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    await this.page.getByRole('button', { name: submitLabel, exact: true }).click();
  }
}
