import { expect, test } from '../fixtures/test';
import { webRoute } from '../utils/urls';

test.describe('page not found', () => {
  test('shows the not-found page for a route that does not exist', async ({ page }) => {
    await page.goto(webRoute('/a-route-that-does-not-exist'));

    await expect(page.getByText('Page not found')).toBeVisible();
  });

  test('offers a way back to the site', async ({ page }) => {
    await page.goto(webRoute('/a-route-that-does-not-exist'));

    await page.getByRole('button', { name: 'Go Home', exact: true }).click();

    await expect(page).not.toHaveURL(/a-route-that-does-not-exist/);
  });
});
