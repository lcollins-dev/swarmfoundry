import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SysConfig } from './entities/sys-config.entity';

import { SysConfigService } from './sys-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([SysConfig])],
  providers: [SysConfigService],
  exports: [SysConfigService],
})
export class SysConfigModule {}
