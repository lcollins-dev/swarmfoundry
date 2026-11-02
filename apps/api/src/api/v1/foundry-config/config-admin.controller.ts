import { Controller, Get, Query, SetMetadata } from '@nestjs/common';

import { ConfigQueryDto, ConfigResponseDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ALLOW_API_KEY_METADATA_KEY } from '../user/guards/auth.guard';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { ConfigAdminService } from './config-admin.service';

@Controller('api/v1/admin/config')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class ConfigAdminController {
  constructor(private readonly configAdminService: ConfigAdminService) {}

  @Get()
  @SetMetadata(ALLOW_API_KEY_METADATA_KEY, true)
  getConfig(@Query(new ZodPipe(ConfigQueryDto)) query: ConfigQueryDto): Promise<ConfigResponseDto> {
    return this.configAdminService.getConfig(query);
  }
}
