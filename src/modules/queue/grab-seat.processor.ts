import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { GrabSeatWorker } from '../grab-seat/grab-seat-worker.service';
import { SeatPreparseService } from '../grab-seat/seat-preparse.service';
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
  private readonly logger = new Logger(GrabSeatProcessor.name);

  constructor(
    private readonly grabSeatWorker: GrabSeatWorker,
    private readonly seatPreparse: SeatPreparseService,
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
   * - session-precheck：触发前 5 分钟预检（刷新登录态 + 严格模式盲抢预解析）
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
        return; // 会话都刷新不了，预解析必然失败，直接结束预检
      }

      // 严格模式盲抢预解析：锁定房间 + 偏好座位号→seatId + 缓存 userInfoId。
      // 失败不阻断：正式抢座时 worker 会回退 search-first 循环
      if (task.strictMode && task.seatPreference?.length) {
        try {
          const entry = await this.seatPreparse.preparse(task);
          if (entry && (entry.autoPickedRoom || entry.unresolvedTitles.length > 0)) {
            const parts: string[] = [];
            if (entry.autoPickedRoom) {
              parts.push(
                `座位号在多个房间存在，已自动锁定「${entry.roomName}」，请确认是否为目标房间`,
              );
            }
            if (entry.unresolvedTitles.length > 0) {
              parts.push(`座位号 ${entry.unresolvedTitles.join('、')} 在该房间不存在，将被忽略`);
            }
            await this.notification.notify({
              userId: task.accountId,
              taskId: task.id,
              type: 'preparse_warning',
              data: { errorReason: parts.join('；') },
            });
          }
        } catch (e) {
          // preparse 内部已兜底网络/业务异常返回 null，这里仅防御未预期异常
          this.logger.warn(
            `[盲抢预解析异常] taskId=${task.id} message=${(e as Error).message}`,
          );
        }
      }
      return;
    }

    await this.grabSeatWorker.executeGrab(task, wakeupMs);
  }
}
