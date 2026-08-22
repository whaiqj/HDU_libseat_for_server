import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MockNotificationService } from './mock-notification.service';
import { Notification } from './entities/notification.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  providers: [
    {
      provide: 'INotificationService',
      useClass: MockNotificationService,
    },
  ],
  exports: ['INotificationService'],
})
export class NotificationModule {}