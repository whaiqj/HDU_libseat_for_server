import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GrabTask } from '../grab-task/entities/grab-task.entity';

/**
 * 任务调度器
 * 负责在 triggerAt 时刻精准唤醒对应抢座任务
 * 使用 BullMQ 延迟队列实现毫秒级精度的一次性触发
 */
@Injectable()
export class TaskSchedulerService {
  constructor(
    @InjectQueue('grab-seat')
    private readonly grabSeatQueue: Queue,
  ) {}

  /**
   * 将任务推入 BullMQ 延迟队列
   * delay = triggerAt - 当前时间（毫秒）
   * 入队前先移除同 jobId 的旧任务，避免重复入队时报错
   */
  async scheduleTask(task: GrabTask): Promise<void> {
    const now = Date.now();
    const delay = Math.max(0, task.triggerAt * 1000 - now);
    const jobId = `grab-seat-${task.id}`;

    // 先移除同 ID 的旧 job（如果存在），保证新任务覆盖旧任务
    const existingJob = await this.grabSeatQueue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove();
    }

    await this.grabSeatQueue.add(
      'grab-seat',
      { taskId: task.id },
      {
        delay,
        jobId,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    // 触发前 5 分钟入一个 session-precheck 前置任务：提前刷新登录态，
    // 抢座瞬间账号处于有效登录状态，降低主任务首击因登录态失效而失败的概率
    const precheckJobId = `grab-seat-precheck-${task.id}`;
    const precheckDelay = Math.max(
      0,
      task.triggerAt * 1000 - 5 * 60 * 1000 - now,
    );
    const existingPrecheckJob = await this.grabSeatQueue.getJob(precheckJobId);
    if (existingPrecheckJob) {
      await existingPrecheckJob.remove();
    }
    await this.grabSeatQueue.add(
      'session-precheck',
      { taskId: task.id },
      {
        delay: precheckDelay,
        jobId: precheckJobId,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  /**
   * 从队列中移除任务
   */
  async cancelTask(taskId: string): Promise<void> {
    const jobId = `grab-seat-${taskId}`;
    const job = await this.grabSeatQueue.getJob(jobId);
    if (job) {
      await job.remove();
    }

    // 同时移除前置预检 job
    const precheckJobId = `grab-seat-precheck-${taskId}`;
    const precheckJob = await this.grabSeatQueue.getJob(precheckJobId);
    if (precheckJob) {
      await precheckJob.remove();
    }
  }
}