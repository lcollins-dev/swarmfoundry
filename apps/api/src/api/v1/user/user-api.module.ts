import { Module } from '@nestjs/common';

import { UserAdminService } from './user-admin.service';

import { UserAdminController } from './user-admin.controller';
import { UserController } from './user.controller';

import { SysConfigModule } from '@/core/sys-config/sys-config.module';
import { UserModule } from '@/core/user/user.module';

@Module({
  imports: [UserModule, SysConfigModule],
  providers: [UserAdminService],
  controllers: [UserController, UserAdminController],

  // AuthGuard is bound in ApiModule, which resolves its UserService through this.
  exports: [UserModule],
})
export class UserApiModule {}
