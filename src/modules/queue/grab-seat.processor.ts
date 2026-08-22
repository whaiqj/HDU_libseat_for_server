import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { GrabSeatWorker } from '../grab-seat/grab-seat-worker.service';
import { GrabTaskService } from '../grab-task/grab-task.service';
import type { IAuthKeeperService } from '../session/auth-keeper.service';
import type { INotificationService } from '../notification/notification.service';

/**
 * 抢座任务队列处理器
 * 接收 BullMQ 延迟队列唤醒的任务，调用 GrabSeatWorker 执行抢座
 * concurrency=8：多账号可并行执行，互不阻塞
 */
@Processor('grab-seat', { concurrency: 8 })
export class GrabSeatProcessor extends WorkerHost {
  constructor(
    private readonly grabSeatWorker: GrabSeatWorker,
    private readonly grabTaskService: GrabTaskService,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
    @Inject('INotificationService')
    private readonly notification: INotificationService,
  ) {
    super();
  }

  /**
   * 处理抢座任务
   * 按 job.name 分支：
   * - session-precheck：触发前 5 分钟预检，提前刷新登录态
   * - grab-seat：正式抢座
   */
  async process(job: Job<{ taskId: string }>): Promise<void> {
    const { taskId } = job.data;

    // 队列唤醒的第一时刻：BullMQ 投递后、findById 之前，用于精确测量唤醒延迟
    const wakeupMs = Date.now();

    const task = await this.grabTaskService.findById(taskId);
    if (!task) {
      return;
    }

    // 触发前 5 分钟的会话预检：确保抢座瞬间账号登录态有效
    if (job.name === 'session-precheck') {
      try {
        await this.authKeeper.refreshSession(task.accountId);
      } catch (e) {
        await this.notification.notify({
          userId: task.accountId,
          taskId: task.id,
          type: 'session_precheck_failed',
          data: { errorReason: (e as Error).message },
        });
      }
      return;
    }

    await this.grabSeatWorker.executeGrab(task, wakeupMs);
  }
}
