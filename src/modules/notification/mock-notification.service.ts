import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { INotificationService, NotificationPayload } from './notification.service';
import { Notification } from './entities/notification.entity';

/**
 * MockNotificationService
 * 开发/测试阶段：打日志 + 写 notifications 表记录
 * 前端通过轮询 notifications 表即可看到任务结果
 */
@Injectable()
export class MockNotificationService implements INotificationService {
  private readonly logger = new Logger(MockNotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
  ) {}

  async notify(payload: NotificationPayload): Promise<void> {
    this.logger.log(
      `[通知] userId=${payload.userId} taskId=${payload.taskId} type=${payload.type}`,
    );
    this.logger.log(`[通知详情] ${JSON.stringify(payload.data)}`);

    // 写 notifications 表记录
    const record = this.notificationRepo.create({
      userId: payload.userId,
      taskId: payload.taskId,
      type: payload.type,
      data: payload.data,
    });
    await this.notificationRepo.save(record);
  }
}