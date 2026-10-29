import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { User } from '@/core/user/entities/user.entity';

import { NotificationApiService } from '@/api/v1/notification/notification-api.service';

import { NotificationController } from '@/api/v1/notification/notification.controller';

const buildUser = (id: number): User => {
  const user = new User({ name: 'Tester', email: 'tester@example.com', passwordHash: 'hash' });
  user.id = id;

  return user;
};

describe('NotificationController', () => {
  let controller: NotificationController;
  let getNotificationListMock: ReturnType<typeof vi.fn>;
  let clearNotificationMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getNotificationListMock = vi.fn().mockResolvedValue({ notificationList: [] });
    clearNotificationMock = vi.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [
        {
          provide: NotificationApiService,
          useValue: { getNotificationList: getNotificationListMock, clearNotification: clearNotificationMock },
        },
      ],
    }).compile();

    controller = moduleRef.get(NotificationController);
  });

  describe('getNotificationList', () => {
    it('asks for the list belonging to the authenticated user', async () => {
      const response = await controller.getNotificationList(buildUser(7));

      expect(getNotificationListMock).toHaveBeenCalledWith(7);
      expect(response).toEqual({ notificationList: [] });
    });
  });

  describe('clearNotification', () => {
    it('scopes the clear to the authenticated user', async () => {
      await controller.clearNotification(10, buildUser(7));

      expect(clearNotificationMock).toHaveBeenCalledWith(10, 7);
    });
  });
});
