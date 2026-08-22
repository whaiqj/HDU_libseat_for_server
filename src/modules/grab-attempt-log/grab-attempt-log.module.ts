import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GrabAttemptLog } from './entities/grab-attempt-log.entity';
import { GrabAttemptLogService } from './grab-attempt-log.service';

@Module({
  imports: [TypeOrmModule.forFeature([GrabAttemptLog])],
  providers: [GrabAttemptLogService],
  exports: [GrabAttemptLogService],
})
export class GrabAttemptLogModule {}