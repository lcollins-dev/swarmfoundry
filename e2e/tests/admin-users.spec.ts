import { createTestUser, inviteTestUser, uniqueEmail } from '../factories/user.factory';
import { expect, test } from '../fixtures/test';
import { confirmDialog } from '../utils/dialog';
import { fieldError } from '../utils/fields';

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

    await expect(page).toHaveURL(new RegExp(`/users/${user.id}$`));
    await expect(adminUserPage.emailInput).toHaveValue(user.email);
  });

  test('invites a user, shows their link once and marks them invited', async ({
    adminUsersPage,
    adminUserInvitePage,
    adminUserPage,
    page,
  }) => {
    const email = uniqueEmail('invited');

    await adminUsersPage.goto();
    await adminUsersPage.inviteUserButton.click();

    await expect(page).toHaveURL(/\/users\/invite$/);

    await adminUserInvitePage.invite({ name: 'Invited In E2E', email });

    await expect(adminUserInvitePage.linkValue).toHaveText(/\/set-password#[0-9a-f]{64}$/);

    await adminUserInvitePage.viewUserButton.click();

    await expect(page).toHaveURL(/\/users\/\d+$/);
    await expect(adminUserPage.emailInput).toHaveValue(email);
    await expect(adminUserPage.invitedTag).toBeVisible();

    await adminUsersPage.goto();
    await adminUsersPage.search(email);

    await expect(adminUsersPage.invitedTag(email)).toBeVisible();
  });

  test('shows a refused email under its field', async ({
    adminUserInvitePage,
    page,
    allowHttpError,
    allowConsoleError,
  }) => {
    allowHttpError({ url: /\/api\/v1\/admin\/user\/invite$/, status: 400 });

    // The page logs the refused request through its own logger.
    allowConsoleError(/pages\/loggedin\/users\/Invite/);

    await adminUserInvitePage.goto();
    await adminUserInvitePage.invite({ name: 'Bad Email', email: 'not-an-email' });

    await expect(fieldError(page, 'email')).toContainText('Enter a valid email address.');
    await expect(page).toHaveURL(/\/users\/invite$/);
  });

  test('makes a reset link for a user', async ({ adminUserPage, request }) => {
    const user = await createTestUser(request);

    await adminUserPage.goto(user.id);
    await adminUserPage.passwordLinkButton('Reset password').click();

    await expect(adminUserPage.passwordLinkValue).toHaveText(/\/set-password#[0-9a-f]{64}$/);
  });

  test('resends the invite of a user who has not chosen a password', async ({ adminUserPage, request }) => {
    const invited = await inviteTestUser(request);

    await adminUserPage.goto(invited.id);
    await adminUserPage.passwordLinkButton('Resend invite').click();

    await expect(adminUserPage.passwordLinkValue).toHaveText(/\/set-password#[0-9a-f]{64}$/);
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
