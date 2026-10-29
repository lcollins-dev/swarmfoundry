import { randomUUID } from 'node:crypto';

import { BatchJobId } from '@libs/dto';

import { getBatchJobEnabled, getNewestBatchJobRunId, setBatchJobEnabled } from '../clients/admin.client';
import { expect, test } from '../fixtures/test';
import { addFailedBatchJobRun, deleteBatchJobRun } from '../utils/db';

const EXAMPLE_BATCH_JOB_ID = BatchJobId.EXAMPLE;
const EXAMPLE_BATCH_JOB_NAME = 'Example';

test.describe('admin batch jobs', () => {
  test('lists the registered jobs and opens one', async ({ adminBatchJobsPage, adminBatchJobPage, page }) => {
    await adminBatchJobsPage.goto();

    await expect(adminBatchJobsPage.heading).toBeVisible();

    await adminBatchJobsPage.rowByName(EXAMPLE_BATCH_JOB_NAME).click();

    await expect(page).toHaveURL(new RegExp(`/admin/batch-jobs/${EXAMPLE_BATCH_JOB_ID}$`));
    await expect(adminBatchJobPage.state).toBeVisible();
  });

  // Both read the job's newest run, so they take turns.
  test.describe("the job's runs", () => {
    test.describe.configure({ mode: 'default' });

    test("shows a failed run's error on expand", async ({ adminBatchJobPage }) => {
      const error = `e2e failure ${randomUUID()}`;
      const batchJobRunId = await addFailedBatchJobRun(EXAMPLE_BATCH_JOB_ID, error);

      try {
        await adminBatchJobPage.goto(EXAMPLE_BATCH_JOB_ID);

        const run = adminBatchJobPage.runs.first();

        await expect(run).toContainText('Failed');
        await expect(adminBatchJobPage.runError(run)).toBeHidden();

        await run.getByRole('button', { name: 'Show the error' }).click();

        await expect(adminBatchJobPage.runError(run)).toHaveText(error);
      } finally {
        await deleteBatchJobRun(batchJobRunId);
      }
    });

    test('runs a job now and lists the run with its result without a reload', async ({
      adminBatchJobPage,
      request,
    }) => {
      const newestBefore = await getNewestBatchJobRunId(request, EXAMPLE_BATCH_JOB_ID);

      await adminBatchJobPage.goto(EXAMPLE_BATCH_JOB_ID);
      await expect(adminBatchJobPage.runs.first().or(adminBatchJobPage.noRuns)).toBeVisible();

      await adminBatchJobPage.runNow.click();
      await adminBatchJobPage.confirmRunNow.click();

      await expect.poll(() => getNewestBatchJobRunId(request, EXAMPLE_BATCH_JOB_ID)).not.toBe(newestBefore);
      await expect(adminBatchJobPage.runs.first()).toContainText('Succeeded', { timeout: 10_000 });
      await expect(adminBatchJobPage.noRuns).toBeHidden();
    });
  });

  // The seeded job is shared. Its state is captured and put back around the one test that
  // drives it, whether or not the assertions in between ran; specs run fully parallel, so
  // tests that only read it stay outside these hooks.
  test.describe('driving the job state', () => {
    let initialEnabled: boolean;

    test.beforeEach(async ({ request }) => {
      initialEnabled = await getBatchJobEnabled(request, EXAMPLE_BATCH_JOB_ID);
    });

    test.afterEach(async ({ request }) => {
      await setBatchJobEnabled(request, EXAMPLE_BATCH_JOB_ID, initialEnabled);
    });

    test('disables and re-enables a job', async ({ adminBatchJobPage, page, request }) => {
      await setBatchJobEnabled(request, EXAMPLE_BATCH_JOB_ID, true);

      await adminBatchJobPage.goto(EXAMPLE_BATCH_JOB_ID);
      await expect(adminBatchJobPage.state).toHaveText('Enabled');

      await adminBatchJobPage.toggle.click();

      await expect(page.getByText('Job disabled')).toBeVisible();
      await expect(adminBatchJobPage.state).toHaveText('Disabled');
      await expect(adminBatchJobPage.toggle).toHaveAttribute('aria-checked', 'false');

      await adminBatchJobPage.toggle.click();

      await expect(page.getByText('Job enabled')).toBeVisible();
      await expect(adminBatchJobPage.state).toHaveText('Enabled');
    });
  });
});
