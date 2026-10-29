import { Module } from '@nestjs/common';

import { FailureReportService } from './failure-report.service';
import { RunJudgeService } from './run-judge.service';
import { TaskCheckService } from './task-check.service';
import { TaskQueueService } from './task-queue.service';
import { TaskRecoveryService } from './task-recovery.service';
import { TriggerEngineService } from './trigger-engine.service';
import { TriggerMatchService } from './trigger-match.service';
import { TriggerScheduleService } from './trigger-schedule.service';

import { ActionsModule } from '@/core/actions/actions.module';
import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';
import { IssueSourceModule } from '@/core/issue-source/issue-source.module';
import { TaskModule } from '@/core/task/task.module';

@Module({
  imports: [ActionsModule, FoundryConfigModule, IssueSourceModule, TaskModule],
  providers: [
    TriggerEngineService,
    TriggerMatchService,
    TaskCheckService,
    RunJudgeService,
    FailureReportService,
    TaskQueueService,
    TaskRecoveryService,
    TriggerScheduleService,
  ],
  exports: [TaskQueueService],
})
export class TriggerEngineModule {}
