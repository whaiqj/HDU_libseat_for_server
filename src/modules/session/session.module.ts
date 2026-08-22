import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../account/entities/account.entity';
import { RealAuthKeeperService } from './real-auth-keeper.service';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Account]),
  ],
  providers: [
    {
      provide: 'IAuthKeeperService',
      useClass: RealAuthKeeperService,
    },
  ],
  exports: ['IAuthKeeperService'],
})
export class SessionModule {}
