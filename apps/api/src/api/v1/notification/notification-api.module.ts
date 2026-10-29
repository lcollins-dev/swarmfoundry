import { Module } from '@nestjs/common';

import { NotificationApiService } from './notification-api.service';

import { NotificationController } from './notification.controller';

import { NotificationModule } from '@/core/notification/notification.module';

@Module({
  imports: [NotificationModule],
  providers: [NotificationApiService],
  controllers: [NotificationController],
})
export class NotificationApiModule {}
