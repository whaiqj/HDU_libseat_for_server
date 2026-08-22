import { Module } from '@nestjs/common';
import { GrabSeatWorker } from './grab-seat-worker.service';
import { SeatSelectionStrategy } from './strategies/seat-selection.strategy';
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
  providers: [GrabSeatWorker, SeatSelectionStrategy],
  exports: [GrabSeatWorker],
})
export class GrabSeatModule {}