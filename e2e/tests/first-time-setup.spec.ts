import { uniqueEmail } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { createFlaggedAdmin, deleteUser, type IFlaggedAdmin } from '../utils/db';
import { LOGGED_OUT_STORAGE_STATE } from '../utils/paths';
import { BASE_URL, webRoute } from '../utils/urls';

test.use({ storageState: LOGGED_OUT_STORAGE_STATE });

test.describe('first-time setup', () => {
  let admin: IFlaggedAdmin;

  test.beforeEach(async () => {
    admin = await createFlaggedAdmin();
  });

  test.afterEach(async () => {
    await deleteUser(admin.id);
  });

  test('holds the admin on the setup page until it has its own password, then opens the app', async ({
    signInPage,
    firstTimeSetupPage,
    headerMenu,
    page,
    request,
    allowHttpError,
    allowConsoleError,
  }) => {
    allowHttpError({ url: /\/api\/v1\/user\/profile$/, status: 400 });
    allowConsoleError(/pages\/loggedin\/FirstTimeSetup/);

    await signInPage.goto();
    await signInPage.enterCredentials(admin);

    await expect(page).toHaveURL(/\/setup$/);
    await expect(firstTimeSetupPage.heading).toBeVisible();
    await expect(firstTimeSetupPage.emailInput).toHaveValue(admin.email);

    await page.goto(webRoute('/admin/users'));
    await expect(page).toHaveURL(/\/setup$/);

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const refused = await request.get(`${BASE_URL}/api/v1/admin/user/role/list`, {
      headers: { Authorization: `Bearer ${token ?? ''}` },
    });

    expect(refused.status()).toBe(403);

    await firstTimeSetupPage.finish(admin.password);
    await expect(page.getByText('Choose a new password, not the one you signed in with.')).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);

    const newEmail = uniqueEmail('setup');
    const newPassword = 'S3tup$Done';

    await firstTimeSetupPage.emailInput.fill(newEmail);
    await firstTimeSetupPage.finish(newPassword);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Account set up', { exact: true })).toBeVisible();

    await page.goto(webRoute('/admin/users'));
    await expect(page).toHaveURL(/\/admin\/users$/);

    await headerMenu.select('Sign out');
    await expect(page).toHaveURL(/\/sign-in/);

    await signInPage.signIn({ email: newEmail, password: newPassword });
  });
});
