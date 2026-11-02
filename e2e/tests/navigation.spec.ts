import { expect, test } from '../fixtures/test';
import { webRoute } from '../utils/urls';

test.describe('navigation', () => {
  test('opens the app authenticated and does not bounce to sign-in', async ({ page }) => {
    await page.goto(webRoute('/overview'));

    await expect(page).not.toHaveURL(/\/sign-in/);
  });

  test('reaches the overview from an authenticated session', async ({ overviewPage, page }) => {
    await overviewPage.goto();

    await expect(page).toHaveURL(/\/overview$/);
    await expect(overviewPage.heading).toBeVisible();
  });
});
