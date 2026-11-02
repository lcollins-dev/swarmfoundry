import { Module } from '@nestjs/common';

import { UserAdminService } from './user-admin.service';

import { PasswordLinkController } from './password-link.controller';
import { UserAdminController } from './user-admin.controller';
import { UserController } from './user.controller';

import { ApiKeyModule } from '@/core/api-key/api-key.module';
import { UserModule } from '@/core/user/user.module';

@Module({
  imports: [ApiKeyModule, UserModule],
  providers: [UserAdminService],
  controllers: [PasswordLinkController, UserController, UserAdminController],

  // AuthGuard is bound in ApiModule, which resolves its services through this.
  exports: [ApiKeyModule, UserModule],
})
export class UserApiModule {}
