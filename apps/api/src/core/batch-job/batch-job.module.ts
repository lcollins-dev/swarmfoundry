import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BatchJobRun } from './entities/batch-job-run.entity';
import { BatchJob } from './entities/batch-job.entity';

import { BatchJobService } from './batch-job.service';

import { ExampleJob } from './example.job';

@Module({
  imports: [TypeOrmModule.forFeature([BatchJob, BatchJobRun]), ScheduleModule.forRoot()],
  providers: [BatchJobService, ExampleJob],
  exports: [BatchJobService],
})
export class BatchJobModule {}
