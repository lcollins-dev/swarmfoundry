import { Module } from '@nestjs/common';

import { TaskAdminService } from './task-admin.service';

import { RunAdminController } from './run-admin.controller';
import { TaskAdminController } from './task-admin.controller';

import { TaskModule } from '@/core/task/task.module';

@Module({
  imports: [TaskModule],
  providers: [TaskAdminService],
  controllers: [TaskAdminController, RunAdminController],
})
export class TaskApiModule {}
