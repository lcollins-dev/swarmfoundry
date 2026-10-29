import { Body, Controller, Get, Patch } from '@nestjs/common';

import { GetSysConfigResponseDto, UpdateSysConfigRequestDto, UserRoleId } from '@libs/dto';

import { AllowedRoles } from '../user/decorators/allowed-roles.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { SysConfigService } from '@/core/sys-config/sys-config.service';

@Controller('api/v1/admin/sys-config')
@AllowedRoles(UserRoleId.SYSTEM_ADMIN)
export class SysConfigAdminController {
  constructor(private readonly sysConfigService: SysConfigService) {}

  @Get()
  async getSysConfig(): Promise<GetSysConfigResponseDto> {
    const sysConfig = await this.sysConfigService.getSysConfig();

    return {
      registrationEnabled: sysConfig.registrationEnabled,
    };
  }

  @Patch()
  updateSysConfig(
    @Body(new ZodPipe(UpdateSysConfigRequestDto)) updateSysConfigRequest: UpdateSysConfigRequestDto
  ): Promise<void> {
    return this.sysConfigService.updateSysConfig(updateSysConfigRequest);
  }
}
