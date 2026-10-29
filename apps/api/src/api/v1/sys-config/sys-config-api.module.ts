import { Module } from '@nestjs/common';

import { SysConfigAdminController } from './sys-config-admin.controller';

import { SysConfigModule } from '@/core/sys-config/sys-config.module';

@Module({
  imports: [SysConfigModule],
  controllers: [SysConfigAdminController],
})
export class SysConfigApiModule {}
