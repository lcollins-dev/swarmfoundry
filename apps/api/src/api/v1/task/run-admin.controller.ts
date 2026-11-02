import { Controller, Get, MessageEvent, Param, Query, SetMetadata, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
  IdParamDto,
  RunDto,
  TranscriptQueryDto,
  TranscriptResponseDto,
  TranscriptStreamLastLineDto,
  TranscriptStreamQueryDto,
  UserRoleId,
} from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../user/guards/auth.guard';
import { lastEventId } from '@/common/decorators/last-event-id.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { TaskAdminService } from './task-admin.service';
import { TranscriptStreamAdminService } from './transcript-stream-admin.service';

import { withHeartbeat } from '@/common/utils/sse.util';

@Controller('api/v1/admin/run')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class RunAdminController {
  constructor(
    private readonly taskAdminService: TaskAdminService,
    private readonly transcriptStreamAdminService: TranscriptStreamAdminService
  ) {}

  @Get(':runId')
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getRun(@Param('runId', new ZodPipe(IdParamDto)) runId: number): Promise<RunDto> {
    return this.taskAdminService.getRun(runId);
  }

  @Get(':runId/transcript')
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getTranscript(
    @Param('runId', new ZodPipe(IdParamDto)) runId: number,
    @Query(new ZodPipe(TranscriptQueryDto)) query: TranscriptQueryDto
  ): Promise<TranscriptResponseDto> {
    return this.taskAdminService.getTranscript(runId, query);
  }

  /** `TranscriptStreamMessageDto` messages, each line's with its line number as the id. */
  @Sse(':runId/transcript/stream')
  async streamTranscript(
    @Param('runId', new ZodPipe(IdParamDto)) runId: number,
    @Query(new ZodPipe(TranscriptStreamQueryDto)) query: TranscriptStreamQueryDto,
    @lastEventId(new ZodPipe(TranscriptStreamLastLineDto)) lastLine: number | undefined
  ): Promise<Observable<MessageEvent>> {
    const afterLine = lastLine ?? 0;
    const lines = await this.transcriptStreamAdminService.followTranscript({ runId, afterLine, types: query.types });

    return withHeartbeat(lines, { endWithPayloads: true, lastEventId: String(afterLine) });
  }
}
