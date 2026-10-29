import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class AdminUserPage {
  constructor(private readonly page: Page) {}

  get nameInput(): Locator {
    return this.page.locator('input[name="display-name"]');
  }

  get emailInput(): Locator {
    return this.page.locator('input[name="email"]');
  }

  get stateTag(): Locator {
    return this.page.getByTestId('user-state');
  }

  get saveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save', exact: true });
  }

  stateButton(label: 'Disable account' | 'Enable account'): Locator {
    return this.page.getByRole('button', { name: label, exact: true });
  }

  get signOutButton(): Locator {
    return this.page.getByRole('button', { name: 'Sign out everywhere', exact: true });
  }

  async goto(userId: number): Promise<void> {
    await this.page.goto(webRoute(`/admin/users/${userId}`));
  }
}
