import { Module } from '@nestjs/common';
import { GrabSeatWorker } from './grab-seat-worker.service';
import { SeatSelectionStrategy } from './strategies/seat-selection.strategy';
import { SeatPreparseService } from './seat-preparse.service';
import { HduLibraryModule } from '../hdu-library/hdu-library.module';
import { GrabTaskModule } from '../grab-task/grab-task.module';
import { SessionModule } from '../session/session.module';
import { NotificationModule } from '../notification/notification.module';
import { GrabAttemptLogModule } from '../grab-attempt-log/grab-attempt-log.module';

@Module({
  imports: [
    HduLibraryModule,
    GrabTaskModule,
    SessionModule,
    NotificationModule,
    GrabAttemptLogModule,
  ],
  providers: [GrabSeatWorker, SeatSelectionStrategy, SeatPreparseService],
  exports: [GrabSeatWorker, SeatPreparseService],
})
export class GrabSeatModule {}