import { Controller, Get, Param, Query } from '@nestjs/common';

import { IdParamDto, RunDto, TranscriptQueryDto, TranscriptResponseDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { TaskAdminService } from './task-admin.service';

@Controller('api/v1/admin/run')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class RunAdminController {
  constructor(private readonly taskAdminService: TaskAdminService) {}

  @Get(':runId')
  getRun(@Param('runId', new ZodPipe(IdParamDto)) runId: number): Promise<RunDto> {
    return this.taskAdminService.getRun(runId);
  }

  @Get(':runId/transcript')
  getTranscript(
    @Param('runId', new ZodPipe(IdParamDto)) runId: number,
    @Query(new ZodPipe(TranscriptQueryDto)) query: TranscriptQueryDto
  ): Promise<TranscriptResponseDto> {
    return this.taskAdminService.getTranscript(runId, query);
  }
}
