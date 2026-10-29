import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationSeverity, NotificationTypeId } from '@libs/dto';

import { NotificationType } from '@/core/notification/entities/notification-type.entity';
import { Notification } from '@/core/notification/entities/notification.entity';

import { NotificationApiService } from '@/api/v1/notification/notification-api.service';
import { NotificationService } from '@/core/notification/notification.service';

const EXAMPLE_TYPE_ID = 100 as NotificationTypeId;

const buildNotificationType = (overrides: Partial<NotificationType> = {}): NotificationType => {
  const notificationType = new NotificationType({
    id: EXAMPLE_TYPE_ID,
    name: 'Example',
    severity: NotificationSeverity.INFO,
    pageUrl: null,
  });

  Object.assign(notificationType, overrides);

  return notificationType;
};

const buildNotification = (overrides: Partial<Notification> = {}): Notification => {
  const notification = new Notification({ notificationTypeId: EXAMPLE_TYPE_ID, userId: 1, desc: 'Something happened' });

  notification.id = 10;
  notification.notificationType = buildNotificationType();
  notification.createdDate = new Date('2026-05-15T12:00:00Z');

  Object.assign(notification, overrides);

  return notification;
};

describe('NotificationApiService', () => {
  let notificationApiService: NotificationApiService;
  let notificationService: {
    findUncleared: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    notificationService = {
      findUncleared: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [NotificationApiService, { provide: NotificationService, useValue: notificationService }],
    }).compile();

    notificationApiService = moduleRef.get(NotificationApiService);
  });

  describe('getNotificationList', () => {
    it('asks for the list belonging to the given user', async () => {
      const response = await notificationApiService.getNotificationList(7);

      expect(notificationService.findUncleared).toHaveBeenCalledWith(7);
      expect(response).toEqual({ notificationList: [] });
    });

    it('maps the notification and its type onto the response', async () => {
      notificationService.findUncleared.mockResolvedValue([
        buildNotification({
          notificationType: buildNotificationType({
            name: 'Import finished',
            severity: NotificationSeverity.SUCCESS,
            pageUrl: '/admin/users',
          }),
        }),
      ]);

      const response = await notificationApiService.getNotificationList(1);

      expect(response).toEqual({
        notificationList: [
          {
            id: 10,
            notificationType: {
              id: EXAMPLE_TYPE_ID,
              name: 'Import finished',
              severity: NotificationSeverity.SUCCESS,
              pageUrl: '/admin/users',
            },
            desc: 'Something happened',
            createdDate: new Date('2026-05-15T12:00:00Z'),
          },
        ],
      });
    });

    it('reports a null page url as undefined', async () => {
      notificationService.findUncleared.mockResolvedValue([buildNotification()]);

      const response = await notificationApiService.getNotificationList(1);

      expect(response.notificationList[0].notificationType.pageUrl).toBeUndefined();
    });

    it('refuses a row whose type did not come back rather than answering half a notification', async () => {
      notificationService.findUncleared.mockResolvedValue([buildNotification({ notificationType: undefined })]);

      await expect(notificationApiService.getNotificationList(1)).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('clearNotification', () => {
    it('scopes the clear to the given user', async () => {
      await notificationApiService.clearNotification(10, 7);

      expect(notificationService.clear).toHaveBeenCalledWith(10, 7);
    });
  });
});
