import { Module } from '@nestjs/common';

import { ActionRegistryService } from './action-registry.service';
import { AgentActionService } from './agent-action.service';
import { IssueActionService } from './issue-action.service';
import { StepExecutorService } from './step-executor.service';

import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';
import { IssueSourceModule } from '@/core/issue-source/issue-source.module';
import { RunnerModule } from '@/core/runner/runner.module';
import { TaskModule } from '@/core/task/task.module';

@Module({
  imports: [FoundryConfigModule, IssueSourceModule, RunnerModule, TaskModule],
  providers: [AgentActionService, IssueActionService, ActionRegistryService, StepExecutorService],
  exports: [StepExecutorService],
})
export class ActionsModule {}
