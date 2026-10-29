import { type Locator, type Page } from '@playwright/test';

export const fieldError = (page: Page, inputName: string): Locator =>
  page
    .getByTestId('form-field')
    .filter({ has: page.locator(`input[name="${inputName}"]`) })
    .getByTestId('field-error');
