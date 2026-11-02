import { Module } from '@nestjs/common';

import { ConfigAdminService } from './config-admin.service';

import { ConfigAdminController } from './config-admin.controller';

import { FoundryConfigModule } from '@/core/foundry-config/foundry-config.module';
import { TaskModule } from '@/core/task/task.module';

@Module({
  imports: [FoundryConfigModule, TaskModule],
  providers: [ConfigAdminService],
  controllers: [ConfigAdminController],
})
export class FoundryConfigApiModule {}
