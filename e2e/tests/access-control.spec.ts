import { createTestUser } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { LOGGED_OUT_STORAGE_STATE } from '../utils/paths';
import { webRoute } from '../utils/urls';

const ADMIN_ROUTES = ['/triggers', '/queue', '/tasks', '/api-keys', '/users', '/config', '/batch-jobs'];

test.use({ storageState: LOGGED_OUT_STORAGE_STATE });

test.describe('access control', () => {
  test('shows a user without roles the not-found page at every admin route', async ({ signInPage, page, request }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);

    for (const route of ADMIN_ROUTES) {
      await page.goto(webRoute(route));

      await expect(page).toHaveURL(webRoute(route));
      await expect(page.getByText('Page not found')).toBeVisible();
    }
  });

  test('sends a user without roles from home to their profile, as the overview needs a role', async ({
    signInPage,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);

    for (const route of ['/', '/overview']) {
      await page.goto(webRoute(route));

      await expect(page).toHaveURL(/\/edit-profile$/);
    }
  });

  test('sends a signed-out visitor to sign-in from an admin route', async ({ page }) => {
    await page.goto(webRoute('/users'));

    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('keeps a signed-in user without roles off the sign-in page, sending them to their profile', async ({
    signInPage,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);

    await page.goto(webRoute('/sign-in'));

    await expect(page).toHaveURL(/\/edit-profile$/);
  });
});
