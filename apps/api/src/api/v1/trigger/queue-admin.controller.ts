import { Controller, Get, SetMetadata } from '@nestjs/common';

import { QueueResponseDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../user/guards/auth.guard';

import { TriggerAdminService } from './trigger-admin.service';

@Controller('api/v1/admin/queue')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class QueueAdminController {
  constructor(private readonly triggerAdminService: TriggerAdminService) {}

  @Get()
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getQueue(): Promise<QueueResponseDto> {
    return this.triggerAdminService.getQueue();
  }
}
