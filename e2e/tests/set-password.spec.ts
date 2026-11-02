import { inviteTestUser } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { LOGGED_OUT_STORAGE_STATE } from '../utils/paths';

test.use({ storageState: LOGGED_OUT_STORAGE_STATE });

const CHOSEN_PASSWORD = 'Ch0sen$Pass';

test.describe('set password', () => {
  test('lets an invited user choose a password and signs them in', async ({ setPasswordPage, page, request }) => {
    const invited = await inviteTestUser(request);

    await setPasswordPage.goto(invited.token);

    await expect(setPasswordPage.form).toBeVisible();

    await setPasswordPage.choose(CHOSEN_PASSWORD, 'Set Password and Sign In');

    await expect(page).not.toHaveURL(/\/set-password/);
    await expect(page).not.toHaveURL(/\/sign-in/);
  });

  test('says a used link no longer works', async ({ setPasswordPage, request, page }) => {
    const invited = await inviteTestUser(request);

    const response = await request.post('/api/v1/password-link', {
      data: { token: invited.token, password: CHOSEN_PASSWORD },
    });
    expect(response.status()).toBe(200);

    await setPasswordPage.goto(invited.token);

    await expect(setPasswordPage.problem).toBeVisible();
    await expect(setPasswordPage.form).toHaveCount(0);
    await expect(page).toHaveURL(/\/set-password/);
  });
});
