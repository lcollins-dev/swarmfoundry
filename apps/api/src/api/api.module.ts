import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuthGuard } from './v1/user/guards/auth.guard';

import { ConfigService } from '../config/config.service';

import { McpApiModule } from './mcp/mcp-api.module';
import { ApiKeyApiModule } from './v1/api-key/api-key-api.module';
import { AvailabilityApiModule } from './v1/availability/availability-api.module';
import { BatchJobApiModule } from './v1/batch-job/batch-job-api.module';
import { FoundryConfigApiModule } from './v1/foundry-config/foundry-config-api.module';
import { NotificationApiModule } from './v1/notification/notification-api.module';
import { TaskApiModule } from './v1/task/task-api.module';
import { TriggerApiModule } from './v1/trigger/trigger-api.module';
import { UserApiModule } from './v1/user/user-api.module';
import { VersionApiModule } from './v1/version/version-api.module';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: seconds(configService.rateLimitWindowSecs),
            limit: configService.rateLimitMaxRequests,
          },
        ],
      }),
      inject: [ConfigService],
    }),
    AvailabilityApiModule,
    VersionApiModule,
    UserApiModule,
    ApiKeyApiModule,
    BatchJobApiModule,
    NotificationApiModule,
    TaskApiModule,
    TriggerApiModule,
    FoundryConfigApiModule,
    McpApiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class ApiModule {}
