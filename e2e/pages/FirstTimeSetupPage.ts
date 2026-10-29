import { type Locator, type Page } from '@playwright/test';

export class FirstTimeSetupPage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Set up your account', exact: true });
  }

  get emailInput(): Locator {
    return this.page.locator('input[name="email"]');
  }

  get newPasswordInput(): Locator {
    return this.page.locator('input[name="new-password"]');
  }

  get confirmPasswordInput(): Locator {
    return this.page.locator('input[name="confirm-password"]');
  }

  get finishButton(): Locator {
    return this.page.getByRole('button', { name: 'Save and Continue', exact: true });
  }

  async finish(newPassword: string): Promise<void> {
    await this.newPasswordInput.fill(newPassword);
    await this.confirmPasswordInput.fill(newPassword);
    await this.finishButton.click();
  }
}
