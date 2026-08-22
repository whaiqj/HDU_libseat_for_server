import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GrabTask } from './entities/grab-task.entity';
import { GrabTaskService } from './grab-task.service';
import { GrabTaskController } from './grab-task.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [TypeOrmModule.forFeature([GrabTask]), SchedulerModule],
  controllers: [GrabTaskController],
  providers: [GrabTaskService],
  exports: [GrabTaskService],
})
export class GrabTaskModule {}