import { getRegistrationEnabled, setRegistrationEnabled } from '../clients/admin.client';
import { expect, test } from '../fixtures/test';

test.describe('admin system config', () => {
  test('shows the registration switch', async ({ adminSysConfigPage }) => {
    await adminSysConfigPage.goto();

    await expect(adminSysConfigPage.heading).toBeVisible();
    await expect(adminSysConfigPage.registrationSwitch).toBeVisible();
  });

  // Registration gates the public sign-up route. The flag is captured and put back around
  // the one test that drives it, whether or not the assertions in between ran; specs run
  // fully parallel, so tests that only read it stay outside these hooks.
  test.describe('driving the registration flag', () => {
    let initialRegistrationEnabled: boolean;

    test.beforeEach(async ({ request }) => {
      initialRegistrationEnabled = await getRegistrationEnabled(request);
    });

    test.afterEach(async ({ request }) => {
      await setRegistrationEnabled(request, initialRegistrationEnabled);
    });

    test('opens and closes public registration', async ({ adminSysConfigPage, page, request }) => {
      await setRegistrationEnabled(request, false);

      await adminSysConfigPage.goto();
      await expect(adminSysConfigPage.registrationSwitch).toHaveAttribute('aria-checked', 'false');

      await adminSysConfigPage.registrationSwitch.click();

      await expect(page.getByText('Registration opened')).toBeVisible();
      await expect(adminSysConfigPage.registrationSwitch).toHaveAttribute('aria-checked', 'true');

      await page.reload();

      await expect(adminSysConfigPage.registrationSwitch).toHaveAttribute('aria-checked', 'true');

      await adminSysConfigPage.registrationSwitch.click();

      await expect(page.getByText('Registration closed')).toBeVisible();
      await expect(adminSysConfigPage.registrationSwitch).toHaveAttribute('aria-checked', 'false');

      await page.reload();

      await expect(adminSysConfigPage.registrationSwitch).toHaveAttribute('aria-checked', 'false');
    });
  });
});
