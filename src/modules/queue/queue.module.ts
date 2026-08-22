import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GrabSeatProcessor } from './grab-seat.processor';
import { GrabSeatModule } from '../grab-seat/grab-seat.module';
import { GrabTaskModule } from '../grab-task/grab-task.module';
import { SessionModule } from '../session/session.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    BullModule.registerQueueAsync({
      name: 'grab-seat',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host'),
          port: configService.get<number>('redis.port'),
          password: configService.get<string>('redis.password'),
        },
        prefix: configService.get<string>('bullmq.prefix'),
      }),
    }),
    GrabSeatModule,
    GrabTaskModule,
    SessionModule,
    NotificationModule,
  ],
  providers: [GrabSeatProcessor],
  exports: [BullModule],
})
export class QueueModule {}