import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

import { NotificationDto, NotificationListDto } from '@libs/dto';

import { Notification } from '@/core/notification/entities/notification.entity';

import { NotificationService } from '@/core/notification/notification.service';

@Injectable()
export class NotificationApiService {
  private readonly logger = new Logger(NotificationApiService.name);

  constructor(private readonly notificationService: NotificationService) {}

  async getNotificationList(userId: number): Promise<NotificationListDto> {
    const notificationList = await this.notificationService.findUncleared(userId);

    return {
      notificationList: notificationList.map(notification => this.getINotification(notification)),
    };
  }

  clearNotification(notificationId: number, userId: number): Promise<void> {
    return this.notificationService.clear(notificationId, userId);
  }

  private getINotification(notification: Notification): NotificationDto {
    const { notificationType } = notification;

    if (!notificationType) {
      this.logger.error(
        { notificationId: notification.id, notificationTypeId: notification.notificationTypeId },
        'getINotification(): Notification has no notification type'
      );
      throw new InternalServerErrorException();
    }

    return {
      id: notification.id,
      notificationType: {
        id: notificationType.id,
        name: notificationType.name,
        severity: notificationType.severity,
        pageUrl: notificationType.pageUrl ?? undefined,
      },
      desc: notification.desc,
      createdDate: notification.createdDate,
    };
  }
}
