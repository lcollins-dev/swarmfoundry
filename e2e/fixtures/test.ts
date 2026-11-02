import { AdminBatchJobPage } from '../pages/AdminBatchJobPage';
import { AdminBatchJobsPage } from '../pages/AdminBatchJobsPage';
import { AdminUserInvitePage } from '../pages/AdminUserInvitePage';
import { AdminUserPage } from '../pages/AdminUserPage';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import { EditProfilePage } from '../pages/EditProfilePage';
import { FirstTimeSetupPage } from '../pages/FirstTimeSetupPage';
import { HeaderMenu } from '../pages/HeaderMenu';
import { NotificationsPanel } from '../pages/NotificationsPanel';
import { OverviewPage } from '../pages/OverviewPage';
import { SetPasswordPage } from '../pages/SetPasswordPage';
import { SignInPage } from '../pages/SignInPage';
import { test as base } from './error-guards';

interface IPageFixtures {
  signInPage: SignInPage;
  setPasswordPage: SetPasswordPage;
  overviewPage: OverviewPage;
  editProfilePage: EditProfilePage;
  firstTimeSetupPage: FirstTimeSetupPage;
  headerMenu: HeaderMenu;
  notificationsPanel: NotificationsPanel;
  adminUsersPage: AdminUsersPage;
  adminUserInvitePage: AdminUserInvitePage;
  adminUserPage: AdminUserPage;
  adminBatchJobsPage: AdminBatchJobsPage;
  adminBatchJobPage: AdminBatchJobPage;
}

export const test = base.extend<IPageFixtures>({
  signInPage: async ({ page }, use) => {
    await use(new SignInPage(page));
  },
  setPasswordPage: async ({ page }, use) => {
    await use(new SetPasswordPage(page));
  },
  overviewPage: async ({ page }, use) => {
    await use(new OverviewPage(page));
  },
  editProfilePage: async ({ page }, use) => {
    await use(new EditProfilePage(page));
  },
  firstTimeSetupPage: async ({ page }, use) => {
    await use(new FirstTimeSetupPage(page));
  },
  headerMenu: async ({ page }, use) => {
    await use(new HeaderMenu(page));
  },
  notificationsPanel: async ({ page }, use) => {
    await use(new NotificationsPanel(page));
  },
  adminUsersPage: async ({ page }, use) => {
    await use(new AdminUsersPage(page));
  },
  adminUserInvitePage: async ({ page }, use) => {
    await use(new AdminUserInvitePage(page));
  },
  adminUserPage: async ({ page }, use) => {
    await use(new AdminUserPage(page));
  },
  adminBatchJobsPage: async ({ page }, use) => {
    await use(new AdminBatchJobsPage(page));
  },
  adminBatchJobPage: async ({ page }, use) => {
    await use(new AdminBatchJobPage(page));
  },
});

export { expect } from '@playwright/test';
