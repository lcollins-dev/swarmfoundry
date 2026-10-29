import { Controller, Get, Param, Patch } from '@nestjs/common';

import { NotificationListDto, IdParamDto } from '@libs/dto';

import { GetUser } from '../user/decorators/user.decorator';
import { ZodPipe } from '@/common/pipes/zod.pipe';

import { User } from '@/core/user/entities/user.entity';

import { NotificationApiService } from './notification-api.service';

@Controller('api/v1/notification')
export class NotificationController {
  constructor(private readonly notificationApiService: NotificationApiService) {}

  @Get('list')
  getNotificationList(@GetUser() user: User): Promise<NotificationListDto> {
    return this.notificationApiService.getNotificationList(user.id);
  }

  @Patch(':notificationId/clear')
  clearNotification(
    @Param('notificationId', new ZodPipe(IdParamDto)) notificationId: number,
    @GetUser() user: User
  ): Promise<void> {
    return this.notificationApiService.clearNotification(notificationId, user.id);
  }
}
