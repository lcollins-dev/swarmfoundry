import { createTestUser } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { fieldError } from '../utils/fields';
import { LOGGED_OUT_STORAGE_STATE } from '../utils/paths';
import { webRoute } from '../utils/urls';
import { TEST_USER } from '../utils/users';

test.use({ storageState: LOGGED_OUT_STORAGE_STATE });

test.describe('sign in', () => {
  test('redirects a protected route to sign-in when unauthenticated', async ({ page }) => {
    await page.goto(webRoute('/dashboard'));

    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('signs in with email then password and lands off the sign-in page', async ({ signInPage, page, request }) => {
    // Its own user: signing in rotates that user's session, which would invalidate the
    // storage state the authenticated specs are using.
    const user = await createTestUser(request);

    await signInPage.goto();
    await signInPage.enterEmail(user.email);

    await expect(signInPage.identity).toHaveText(user.email);

    await signInPage.passwordInput.fill(user.password);
    await signInPage.submitButton.click();

    await expect(page).not.toHaveURL(/\/sign-in/);
  });

  test('returns the user to the protected page they opened before signing in', async ({
    signInPage,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await page.goto(webRoute('/edit-profile'));

    await expect(page).toHaveURL(/\/sign-in\?redirect=\/edit-profile$/);

    await signInPage.enterCredentials(user);

    await expect(page).toHaveURL(/\/edit-profile$/);
  });

  test('goes back to the email step to change the email', async ({ signInPage }) => {
    await signInPage.goto();
    await signInPage.enterEmail('someone@example.com');
    await signInPage.changeEmailButton.click();

    await expect(signInPage.emailInput).toHaveValue('someone@example.com');
    await expect(signInPage.passwordInput).toHaveCount(0);
  });

  test('asks for an email before moving to the password step', async ({ signInPage, page }) => {
    await signInPage.goto();
    await signInPage.continueButton.click();

    await expect(fieldError(page, 'email')).toHaveText('Enter your email address.');
    await expect(signInPage.passwordInput).toHaveCount(0);
  });

  test('asks for a valid email before moving to the password step', async ({ signInPage, page }) => {
    await signInPage.goto();
    await signInPage.emailInput.fill('not-an-email');
    await signInPage.continueButton.click();

    await expect(fieldError(page, 'email')).toHaveText('Enter a valid email address.');
    await expect(signInPage.passwordInput).toHaveCount(0);
  });

  test('keeps the user on sign-in when the password is wrong', async ({
    signInPage,
    page,
    allowHttpError,
    allowConsoleError,
  }) => {
    allowHttpError({ url: /\/api\/v1\/user\/login$/, status: 400 });

    // The page logs the rejected login through its own logger.
    allowConsoleError(/pages\/loggedout\/SignIn/);

    await signInPage.goto();
    await signInPage.enterCredentials({ email: TEST_USER.email, password: 'not-the-password' });

    await expect(page).toHaveURL(/\/sign-in/);
    await expect(signInPage.passwordInput).toBeVisible();
  });

  test("returns to the email step with the api's refusal of the email under its field", async ({
    signInPage,
    page,
    allowHttpError,
    allowConsoleError,
  }) => {
    allowHttpError({ url: /\/api\/v1\/user\/login$/, status: 400 });

    // The page logs the refused request through its own logger.
    allowConsoleError(/pages\/loggedout\/SignIn/);

    await signInPage.goto();
    // The browser's email check passes a host without a dot; the api's refuses it.
    await signInPage.enterCredentials({ email: 'someone@localhost', password: 'not-the-password' });

    await expect(fieldError(page, 'email')).toHaveText('Enter a valid email address.');
    await expect(signInPage.passwordInput).toHaveCount(0);
  });
});
