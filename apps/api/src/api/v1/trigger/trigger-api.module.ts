import { Module } from '@nestjs/common';

import { TriggerAdminService } from './trigger-admin.service';

import { QueueAdminController } from './queue-admin.controller';
import { SourceAdminController } from './source-admin.controller';
import { TriggerAdminController } from './trigger-admin.controller';

import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';
import { IssueSourceModule } from '@/core/issue-source/issue-source.module';
import { TaskModule } from '@/core/task/task.module';
import { TriggerEngineModule } from '@/core/trigger-engine/trigger-engine.module';

@Module({
  imports: [FoundryConfigModule, IssueSourceModule, TaskModule, TriggerEngineModule],
  providers: [TriggerAdminService],
  controllers: [TriggerAdminController, QueueAdminController, SourceAdminController],
})
export class TriggerApiModule {}
