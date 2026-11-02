import { Controller, Get, SetMetadata } from '@nestjs/common';

import { SourceListResponseDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../user/guards/auth.guard';

import { TriggerAdminService } from './trigger-admin.service';

@Controller('api/v1/admin/source')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class SourceAdminController {
  constructor(private readonly triggerAdminService: TriggerAdminService) {}

  @Get('list')
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getSourceList(): SourceListResponseDto {
    return this.triggerAdminService.getSourceList();
  }
}
