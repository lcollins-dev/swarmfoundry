import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchJobId, BatchJobRunResult } from '@libs/dto';

import { BatchJobAdminService } from '@/api/v1/batch-job/batch-job-admin.service';

import { BatchJobAdminController } from '@/api/v1/batch-job/batch-job-admin.controller';

describe('BatchJobAdminController', () => {
  let controller: BatchJobAdminController;
  let getBatchJobMock: ReturnType<typeof vi.fn>;
  let getBatchJobListMock: ReturnType<typeof vi.fn>;
  let updateBatchJobStateMock: ReturnType<typeof vi.fn>;
  let getBatchJobRunListMock: ReturnType<typeof vi.fn>;
  let runBatchJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getBatchJobMock = vi.fn();
    getBatchJobListMock = vi.fn();
    updateBatchJobStateMock = vi.fn();
    getBatchJobRunListMock = vi.fn();
    runBatchJobMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [BatchJobAdminController],
      providers: [
        {
          provide: BatchJobAdminService,
          useValue: {
            getBatchJob: getBatchJobMock,
            getBatchJobList: getBatchJobListMock,
            updateBatchJobState: updateBatchJobStateMock,
            getBatchJobRunList: getBatchJobRunListMock,
            runBatchJob: runBatchJobMock,
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(BatchJobAdminController);
  });

  it('returns the batch job list from the service', async () => {
    getBatchJobListMock.mockResolvedValue({ batchJobList: [] });

    const response = await controller.getBatchJobList();

    expect(response).toEqual({ batchJobList: [] });
  });

  it('passes the parsed id through when fetching a single batch job', async () => {
    getBatchJobMock.mockResolvedValue({ id: BatchJobId.EXAMPLE });

    await controller.getBatchJob(BatchJobId.EXAMPLE);

    expect(getBatchJobMock).toHaveBeenCalledWith(BatchJobId.EXAMPLE);
  });

  it('unwraps the enabled flag from the body when updating state', async () => {
    updateBatchJobStateMock.mockResolvedValue(undefined);

    await controller.updateBatchJobState(BatchJobId.EXAMPLE, { enabled: false });

    expect(updateBatchJobStateMock).toHaveBeenCalledWith(BatchJobId.EXAMPLE, false);
  });

  it('passes the job id and page through when listing runs', async () => {
    getBatchJobRunListMock.mockResolvedValue({ batchJobRunList: [], pages: 0 });

    const response = await controller.getBatchJobRunList(BatchJobId.EXAMPLE, 2);

    expect(getBatchJobRunListMock).toHaveBeenCalledWith(BatchJobId.EXAMPLE, 2);
    expect(response).toEqual({ batchJobRunList: [], pages: 0 });
  });

  it('answers the run it started', async () => {
    const run = { id: 7, result: BatchJobRunResult.RUNNING };
    runBatchJobMock.mockResolvedValue(run);

    await expect(controller.runBatchJob(BatchJobId.EXAMPLE)).resolves.toBe(run);

    expect(runBatchJobMock).toHaveBeenCalledWith(BatchJobId.EXAMPLE);
  });
});
