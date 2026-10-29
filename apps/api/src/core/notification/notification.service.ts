import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Handlebars from 'handlebars';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { NotificationTypeId } from '@libs/dto';

import { Notification } from './entities/notification.entity';

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>
  ) {}

  /** Newest first, each carrying its type. */
  findUncleared(userId: number): Promise<Notification[]> {
    return this.notificationRepository.find({
      where: { userId, cleared: false },
      relations: { notificationType: true },
      order: { createdDate: 'DESC' },
    });
  }

  async clear(notificationId: number, userId: number): Promise<void> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId, cleared: false },
    });

    if (!notification) {
      throw new BadRequestException("This notification doesn't exist or has already been cleared.");
    }

    await this.notificationRepository.update({ id: notification.id }, { cleared: true });
  }

  /**
   * Add a notification
   * @param notificationTypeId Notification type
   * @param descHandlebars Handlebars template for description, all user content should be substituted in using descValues
   * @param userId User to store notification for
   * @param descValues Values passed to handlebars template
   */
  @Transactional()
  async add(
    notificationTypeId: NotificationTypeId,
    descHandlebars: string,
    userId: number,
    descValues?: { [key: string]: string }
  ): Promise<void> {
    const desc = Handlebars.compile(descHandlebars)(descValues);

    const notification = new Notification({ notificationTypeId, userId, desc });

    await this.notificationRepository.insert(notification);
  }
}
