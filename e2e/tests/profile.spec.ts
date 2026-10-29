import { createTestUser } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { fieldError } from '../utils/fields';
import { LOGGED_OUT_STORAGE_STATE } from '../utils/paths';

// Its own user: the profile edit renames whoever is signed in, and the shared admin is
// the account every other authenticated spec relies on.
test.use({ storageState: LOGGED_OUT_STORAGE_STATE });

test.describe('edit profile', () => {
  test('renames the signed-in user and keeps the new name after a reload', async ({
    signInPage,
    editProfilePage,
    headerMenu,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);
    await editProfilePage.goto();

    await expect(editProfilePage.nameInput).toHaveValue(user.name);
    await expect(editProfilePage.emailInput).toHaveValue(user.email);
    await expect(editProfilePage.saveButton).toBeDisabled();

    await editProfilePage.nameInput.fill('Renamed In E2E');
    await editProfilePage.saveButton.click();

    await expect(page.getByText('Your changes have been saved.')).toBeVisible();

    await page.reload();

    await expect(editProfilePage.nameInput).toHaveValue('Renamed In E2E');
    await expect(headerMenu.userMenu).toContainText('Renamed In E2E');
  });

  test('stays signed in after the user changes their own password', async ({
    signInPage,
    editProfilePage,
    dashboardPage,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);
    await editProfilePage.goto();

    await editProfilePage.changePassword('Chang3d$Pass');

    await expect(page.getByText('Password changed')).toBeVisible();

    // The password change replaces the session, so this only holds if the app swapped tokens.
    await dashboardPage.goto();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(dashboardPage.heading).toBeVisible();
  });

  test('reports mismatched passwords without calling the api', async ({
    signInPage,
    editProfilePage,
    page,
    request,
  }) => {
    const user = await createTestUser(request);

    await signInPage.signIn(user);
    await editProfilePage.goto();

    await editProfilePage.newPasswordInput.fill('An0ther$Pass');
    await editProfilePage.confirmPasswordInput.fill('An0ther$Pas');
    await editProfilePage.changePasswordButton.click();

    await expect(fieldError(page, 'confirm-password')).toHaveText("The passwords don't match.");
    await expect(page.getByTestId('dialog')).toHaveCount(0);
  });
});
