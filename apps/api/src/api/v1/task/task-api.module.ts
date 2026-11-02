import { Module } from '@nestjs/common';

import { TaskAdminService } from './task-admin.service';
import { TranscriptStreamAdminService } from './transcript-stream-admin.service';

import { RunAdminController } from './run-admin.controller';
import { TaskAdminController } from './task-admin.controller';

import { TaskModule } from '@/core/task/task.module';

import { TaskMcpTools } from './task-mcp.tools';
import { TranscriptMcpTools } from './transcript-mcp.tools';

@Module({
  imports: [TaskModule],
  providers: [TaskAdminService, TranscriptStreamAdminService, TaskMcpTools, TranscriptMcpTools],
  controllers: [TaskAdminController, RunAdminController],
})
export class TaskApiModule {}
