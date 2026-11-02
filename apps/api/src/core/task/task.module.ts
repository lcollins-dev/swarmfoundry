import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RunTranscriptLine } from './entities/run-transcript-line.entity';
import { Run } from './entities/run.entity';
import { Task } from './entities/task.entity';

import { TaskReadService } from './task-read.service';
import { TaskService } from './task.service';
import { TranscriptSearchService } from './transcript-search.service';

@Module({
  imports: [TypeOrmModule.forFeature([Task, Run, RunTranscriptLine])],
  providers: [TaskService, TaskReadService, TranscriptSearchService],
  exports: [TaskService, TaskReadService, TranscriptSearchService],
})
export class TaskModule {}
