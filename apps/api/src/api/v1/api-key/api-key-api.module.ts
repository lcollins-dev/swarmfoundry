import { Module } from '@nestjs/common';

import { ApiKeyAdminService } from './api-key-admin.service';

import { ApiKeyAdminController } from './api-key-admin.controller';

import { ApiKeyModule } from '@/core/api-key/api-key.module';
import { UserModule } from '@/core/user/user.module';

@Module({
  imports: [ApiKeyModule, UserModule],
  providers: [ApiKeyAdminService],
  controllers: [ApiKeyAdminController],
})
export class ApiKeyApiModule {}
