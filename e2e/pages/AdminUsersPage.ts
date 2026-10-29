import { type Locator, type Page } from '@playwright/test';

import { webRoute } from '../utils/urls';

export class AdminUsersPage {
  constructor(private readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Users', exact: true });
  }

  get searchInput(): Locator {
    return this.page.getByPlaceholder('Search name or email', { exact: true });
  }

  get newUserButton(): Locator {
    return this.page.getByRole('button', { name: 'New User', exact: true });
  }

  get rows(): Locator {
    return this.page.getByTestId('user-row');
  }

  filter(label: string): Locator {
    return this.page.getByRole('radio', { name: label, exact: true });
  }

  rowByEmail(email: string): Locator {
    return this.rows.filter({ hasText: email });
  }

  async goto(): Promise<void> {
    await this.page.goto(webRoute('/admin/users'));
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term);
  }
}
