import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class AdminUserInvitePage {
  constructor(private readonly page: Page) {}

  get nameInput(): Locator {
    return this.page.locator('input[name="name"]');
  }

  get emailInput(): Locator {
    return this.page.locator('input[name="email"]');
  }

  get sendButton(): Locator {
    return this.page.getByRole('button', { name: 'Send Invite', exact: true });
  }

  get linkValue(): Locator {
    return this.page.getByTestId('password-link-value');
  }

  get viewUserButton(): Locator {
    return this.page.getByRole('button', { name: 'View User', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/users/invite'));
  }

  async invite(person: { name: string; email: string }): Promise<void> {
    await this.nameInput.fill(person.name);
    await this.emailInput.fill(person.email);
    await this.sendButton.click();
  }
}
