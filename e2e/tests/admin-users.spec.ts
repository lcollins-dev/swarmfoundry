import { createTestUser, uniqueEmail } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { confirmDialog } from '../utils/dialog';
import { fieldError } from '../utils/fields';
import { TEST_PASSWORD } from '../utils/users';

test.describe('admin users', () => {
  test('narrows the list to a searched user', async ({ adminUsersPage, request }) => {
    const user = await createTestUser(request);
    const other = await createTestUser(request);

    await adminUsersPage.goto();
    await expect(adminUsersPage.heading).toBeVisible();

    await adminUsersPage.search(user.email);

    await expect(adminUsersPage.rowByEmail(user.email)).toBeVisible();
    await expect(adminUsersPage.rowByEmail(other.email)).toHaveCount(0);
  });

  test('opens a user from the list', async ({ adminUsersPage, adminUserPage, page, request }) => {
    const user = await createTestUser(request);

    await adminUsersPage.goto();
    await adminUsersPage.search(user.email);
    await adminUsersPage.rowByEmail(user.email).click();

    await expect(page).toHaveURL(new RegExp(`/admin/users/${user.id}$`));
    await expect(adminUserPage.emailInput).toHaveValue(user.email);
  });

  test('creates a user and lands on the new record', async ({
    adminUsersPage,
    adminUserCreatePage,
    adminUserPage,
    page,
  }) => {
    const email = uniqueEmail('created');

    await adminUsersPage.goto();
    await adminUsersPage.newUserButton.click();

    await expect(page).toHaveURL(/\/admin\/users\/create$/);

    await adminUserCreatePage.fill({ name: 'Created In E2E', email, password: TEST_PASSWORD });
    await adminUserCreatePage.createButton.click();

    await expect(page).toHaveURL(/\/admin\/users\/\d+$/);
    await expect(adminUserPage.nameInput).toHaveValue('Created In E2E');
    await expect(adminUserPage.emailInput).toHaveValue(email);
  });

  test('shows a refused password under its field', async ({
    adminUserCreatePage,
    page,
    allowHttpError,
    allowConsoleError,
  }) => {
    allowHttpError({ url: /\/api\/v1\/admin\/user$/, status: 400 });

    // The page logs the refused request through its own logger.
    allowConsoleError(/pages\/loggedin\/admin\/users\/Create/);

    await adminUserCreatePage.goto();
    await adminUserCreatePage.fill({
      name: 'Weak Password',
      email: uniqueEmail('weak'),
      password: 'weak',
    });
    await adminUserCreatePage.createButton.click();

    await expect(fieldError(page, 'new-password')).toContainText('Use at least 6 characters, with a capital letter');
    await expect(page).toHaveURL(/\/admin\/users\/create$/);
  });

  test('renames a user from the detail page', async ({ adminUserPage, page, request }) => {
    const user = await createTestUser(request);

    await adminUserPage.goto(user.id);
    await adminUserPage.nameInput.fill('Renamed By Admin');
    await adminUserPage.saveButton.click();

    await expect(page.getByText('Profile updated')).toBeVisible();

    await page.reload();

    await expect(adminUserPage.nameInput).toHaveValue('Renamed By Admin');
  });

  test('disables a user and shows it in the list filters', async ({ adminUserPage, adminUsersPage, page, request }) => {
    const user = await createTestUser(request);

    await adminUserPage.goto(user.id);
    await expect(adminUserPage.stateTag).toHaveText('Enabled');

    await adminUserPage.stateButton('Disable account').click();
    await confirmDialog(page);

    await expect(page.getByText('Account disabled')).toBeVisible();
    await expect(adminUserPage.stateTag).toHaveText('Disabled');

    await adminUsersPage.goto();
    await adminUsersPage.search(user.email);
    await adminUsersPage.filter('Enabled').click();

    await expect(adminUsersPage.rowByEmail(user.email)).toHaveCount(0);

    await adminUsersPage.filter('Disabled').click();

    await expect(adminUsersPage.rowByEmail(user.email)).toBeVisible();
  });

  test('signs a user out of every session', async ({ adminUserPage, page, request }) => {
    const user = await createTestUser(request);

    await adminUserPage.goto(user.id);
    await adminUserPage.signOutButton.click();
    await confirmDialog(page);

    await expect(page.getByText('Signed out everywhere')).toBeVisible();
  });
});
