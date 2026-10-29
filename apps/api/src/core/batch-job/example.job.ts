import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { BatchJobId } from '@libs/dto';

import { BatchJobRunner, BatchJobService } from './batch-job.service';
import { ConfigService } from '@/config/config.service';

@Injectable()
export class ExampleJob implements BatchJobRunner, OnModuleInit {
  private readonly logger = new Logger(ExampleJob.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly batchJobService: BatchJobService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.batchJobService.registerBatchJob(BatchJobId.EXAMPLE, this.configService.batchJobExampleCron, this);
  }

  run(): Promise<void> {
    this.logger.log('run(): Example batch job ran');

    return Promise.resolve();
  }
}
