import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { HduLibraryModule } from './modules/hdu-library/hdu-library.module';
import { GrabTaskModule } from './modules/grab-task/grab-task.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { QueueModule } from './modules/queue/queue.module';
import { GrabSeatModule } from './modules/grab-seat/grab-seat.module';
import { SessionModule } from './modules/session/session.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AccountModule } from './modules/account/account.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.database'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    HduLibraryModule,
    GrabTaskModule,
    SchedulerModule,
    QueueModule,
    GrabSeatModule,
    SessionModule,
    NotificationModule,
    AccountModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}