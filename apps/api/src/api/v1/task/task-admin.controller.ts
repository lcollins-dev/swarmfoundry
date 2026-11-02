import { Controller, Get, Param, Query, SetMetadata } from '@nestjs/common';

import { IdParamDto, TaskDto, TaskListQueryDto, TaskListResponseDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../user/guards/auth.guard';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { TaskAdminService } from './task-admin.service';

@Controller('api/v1/admin/task')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class TaskAdminController {
  constructor(private readonly taskAdminService: TaskAdminService) {}

  @Get('list')
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getTaskList(@Query(new ZodPipe(TaskListQueryDto)) query: TaskListQueryDto): Promise<TaskListResponseDto> {
    return this.taskAdminService.getTaskList(query);
  }

  @Get(':taskId')
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getTask(@Param('taskId', new ZodPipe(IdParamDto)) taskId: number): Promise<TaskDto> {
    return this.taskAdminService.getTask(taskId);
  }
}
