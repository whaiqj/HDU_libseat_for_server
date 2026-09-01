import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../account/entities/account.entity';
import { ForwardedMessage } from './entities/forwarded-message.entity';
import { MessageForwardService } from './message-forward.service';
import { HduLibraryModule } from '../hdu-library/hdu-library.module';
import { NotificationModule } from '../notification/notification.module';
import { SessionModule } from '../session/session.module';

/**
 * 图书馆座位消息转发模块（独立模块，对抢座业务零侵入）
 * - 不依赖任何抢座模块、不调用抢座接口、不占用 BullMQ 队列资源
 * - ScheduleModule 已由 SessionModule 统一 forRoot 注册（global），此处不重复注册
 * - 定时轮询由 MessageForwardService 在 onModuleInit 动态注册
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ForwardedMessage, Account]),
    HduLibraryModule,
    NotificationModule,
    SessionModule,
  ],
  providers: [MessageForwardService],
})
export class MessageForwardModule {}
