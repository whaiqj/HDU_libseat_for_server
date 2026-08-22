import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TaskSchedulerService } from './task-scheduler.service';

/**
 * SchedulerModule 只负责调度逻辑
 * 队列注册统一在 QueueModule，这里通过 BullModule 注入同一个队列
 * 必须使用相同的 Redis 连接配置，否则 scheduler 和 worker 会连到不同的队列实例
 */
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
  ],
  providers: [TaskSchedulerService],
  exports: [TaskSchedulerService, BullModule],
})
export class SchedulerModule {}