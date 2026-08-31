import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MockNotificationService } from './mock-notification.service';
import { WxPusherNotificationService } from './wxpusher-notification.service';
import { Notification } from './entities/notification.entity';
import { AccountModule } from '../account/account.module';
import { INotificationService } from './notification.service';

/**
 * 通知模块：按 NOTIFY_MODE 环境变量切换实现
 * - mock：打日志 + 写 notifications 表（默认）
 * - wxpusher：WxPusher Topic 广播推送到微信
 * 注入 token 始终为 INotificationService，调用方无需感知差异。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    HttpModule.register({ timeout: 8_000 }),
    AccountModule,
  ],
  providers: [
    MockNotificationService,
    WxPusherNotificationService,
    {
      provide: 'INotificationService',
      inject: [
        ConfigService,
        MockNotificationService,
        WxPusherNotificationService,
      ],
      useFactory: (
        config: ConfigService,
        mock: MockNotificationService,
        wxpusher: WxPusherNotificationService,
      ): INotificationService =>
        config.get<string>('notifyMode') === 'wxpusher' ? wxpusher : mock,
    },
  ],
  exports: ['INotificationService'],
})
export class NotificationModule {}
