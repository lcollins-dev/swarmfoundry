import { AdminBatchJobPage } from '../pages/AdminBatchJobPage';
import { AdminBatchJobsPage } from '../pages/AdminBatchJobsPage';
import { AdminSysConfigPage } from '../pages/AdminSysConfigPage';
import { AdminUserCreatePage } from '../pages/AdminUserCreatePage';
import { AdminUserPage } from '../pages/AdminUserPage';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import { DashboardPage } from '../pages/DashboardPage';
import { EditProfilePage } from '../pages/EditProfilePage';
import { FirstTimeSetupPage } from '../pages/FirstTimeSetupPage';
import { HeaderMenu } from '../pages/HeaderMenu';
import { NotificationsPanel } from '../pages/NotificationsPanel';
import { SignInPage } from '../pages/SignInPage';
import { test as base } from './error-guards';

interface IPageFixtures {
  signInPage: SignInPage;
  dashboardPage: DashboardPage;
  editProfilePage: EditProfilePage;
  firstTimeSetupPage: FirstTimeSetupPage;
  headerMenu: HeaderMenu;
  notificationsPanel: NotificationsPanel;
  adminUsersPage: AdminUsersPage;
  adminUserCreatePage: AdminUserCreatePage;
  adminUserPage: AdminUserPage;
  adminBatchJobsPage: AdminBatchJobsPage;
  adminBatchJobPage: AdminBatchJobPage;
  adminSysConfigPage: AdminSysConfigPage;
}

export const test = base.extend<IPageFixtures>({
  signInPage: async ({ page }, use) => {
    await use(new SignInPage(page));
  },
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
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
  adminUserCreatePage: async ({ page }, use) => {
    await use(new AdminUserCreatePage(page));
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
  adminSysConfigPage: async ({ page }, use) => {
    await use(new AdminSysConfigPage(page));
  },
});

export { expect } from '@playwright/test';
