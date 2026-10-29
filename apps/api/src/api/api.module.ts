import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuthGuard } from './v1/user/guards/auth.guard';

import { ConfigService } from '../config/config.service';

import { AvailabilityApiModule } from './v1/availability/availability-api.module';
import { BatchJobApiModule } from './v1/batch-job/batch-job-api.module';
import { NotificationApiModule } from './v1/notification/notification-api.module';
import { SysConfigApiModule } from './v1/sys-config/sys-config-api.module';
import { TaskApiModule } from './v1/task/task-api.module';
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
    SysConfigApiModule,
    BatchJobApiModule,
    NotificationApiModule,
    TaskApiModule,
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
