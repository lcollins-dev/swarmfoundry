import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchJobId } from '@libs/dto';

import { ConfigService } from '@/config/config.service';
import { BatchJobService } from '@/core/batch-job/batch-job.service';

import { ExampleJob } from '@/core/batch-job/example.job';

describe('ExampleJob', () => {
  let exampleJob: ExampleJob;
  let registerBatchJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    registerBatchJobMock = vi.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExampleJob,
        { provide: ConfigService, useValue: { batchJobExampleCron: '5 4 * * *' } },
        { provide: BatchJobService, useValue: { registerBatchJob: registerBatchJobMock } },
      ],
    }).compile();

    exampleJob = moduleRef.get(ExampleJob);
  });

  it('registers itself on the schedule its setting names', async () => {
    await exampleJob.onModuleInit();

    expect(registerBatchJobMock).toHaveBeenCalledWith(BatchJobId.EXAMPLE, '5 4 * * *', exampleJob);
  });

  it('runs to completion', async () => {
    await expect(exampleJob.run()).resolves.toBeUndefined();
  });
});
