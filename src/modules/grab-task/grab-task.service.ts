import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { GrabTask, TaskStatus } from './entities/grab-task.entity';
import { CreateGrabTaskDto } from './dto/create-grab-task.dto';
import { TaskSchedulerService } from '../scheduler/task-scheduler.service';

@Injectable()
export class GrabTaskService {
  /** 已请求取消的任务 ID 集合（进程内内存标记，供 worker 重试循环快速轮询） */
  private readonly cancellationRequests = new Set<string>();

  constructor(
    @InjectRepository(GrabTask)
    private readonly grabTaskRepository: Repository<GrabTask>,
    private readonly taskScheduler: TaskSchedulerService,
  ) {}

  /**
   * 创建抢座任务并推入延迟队列
   * 同账号如果已有 pending 状态的任务，先取消旧的（新任务覆盖旧任务）
   */
  async create(dto: CreateGrabTaskDto): Promise<{ task: GrabTask; warnings: string[] }> {
    // 后端兜底校验：触发时间不能早于当前时间
    const nowTs = Math.floor(Date.now() / 1000);
    if (dto.triggerAt <= nowTs) {
      throw new Error('触发时间必须晚于当前时间');
    }

    // 同账号存在 RUNNING 任务时拒绝：防止取消旧任务期间旧 worker 还在跑、又建新任务，
    // 导致同账号两个循环并发抢（会互相打架）
    const runningCount = await this.grabTaskRepository.count({
      where: { accountId: dto.accountId, status: TaskStatus.RUNNING },
    });
    if (runningCount > 0) {
      throw new BadRequestException('该账号已有进行中的抢座任务');
    }

    // 同账号已存在的 pending 任务：取消旧的，用新任务覆盖
    const existingPending = await this.grabTaskRepository.find({
      where: { accountId: dto.accountId, status: TaskStatus.PENDING },
    });
    for (const oldTask of existingPending) {
      await this.taskScheduler.cancelTask(oldTask.id);
      await this.updateStatus(oldTask.id, TaskStatus.FAILED, { reason: '被新任务覆盖' });
    }

    // 跨账号偏好重合软校验（不阻断，仅返回 warnings）
    const warnings = await this.computeCrossAccountWarnings(dto);

    const task = this.grabTaskRepository.create({
      accountId: dto.accountId,
      categoryId: dto.categoryId,
      contentId: dto.contentId,
      roomId: dto.roomId ?? null,
      roomName: dto.roomName ?? null,
      beginTime: dto.beginTime,
      duration: dto.duration,
      seatPreference: dto.seatPreference ?? [],
      strictMode: dto.strictMode ?? false,
      triggerAt: dto.triggerAt,
      status: TaskStatus.PENDING,
      attempts: 0,
      result: null,
    });

    const saved = await this.grabTaskRepository.save(task);

    // 计算延迟时间，推入 BullMQ 延迟队列
    await this.taskScheduler.scheduleTask(saved);

    return { task: saved, warnings };
  }

  /**
   * 根据 ID 查询任务
   */
  async findById(id: string): Promise<GrabTask | null> {
    return this.grabTaskRepository.findOne({ where: { id } });
  }

  /**
   * 根据账号 ID 查询所有任务
   */
  async findByAccountId(accountId: string): Promise<GrabTask[]> {
    return this.grabTaskRepository.find({
      where: { accountId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 跨账号偏好重合软校验（不阻断）
   * 检查其他账号同触发日（同 triggerAt）的 pending/running 任务，
   * 若 seatPreference 存在重合座位，生成 warnings 供前端提示
   */
  private async computeCrossAccountWarnings(
    dto: CreateGrabTaskDto,
  ): Promise<string[]> {
    const prefs = dto.seatPreference ?? [];
    if (prefs.length === 0) {
      return [];
    }

    const others = await this.grabTaskRepository.find({
      where: [
        {
          accountId: Not(dto.accountId),
          status: TaskStatus.PENDING,
          triggerAt: dto.triggerAt,
        },
        {
          accountId: Not(dto.accountId),
          status: TaskStatus.RUNNING,
          triggerAt: dto.triggerAt,
        },
      ],
    });

    const warnings: string[] = [];
    for (const other of others) {
      const overlap = prefs.filter((s) => (other.seatPreference ?? []).includes(s));
      for (const seat of overlap) {
        const state = other.status === TaskStatus.RUNNING ? '进行中' : '待执行';
        warnings.push(
          `座位 ${seat} 与账号 ${other.accountId} ${state}的任务偏好重合，可能出现两账号争抢同一座位`,
        );
      }
    }
    return warnings;
  }

  /**
   * 更新任务状态
   */
  async updateStatus(
    id: string,
    status: TaskStatus,
    result?: Record<string, any>,
  ): Promise<void> {
    const updateData: Partial<GrabTask> = { status };
    if (result !== undefined) {
      updateData.result = result;
    }
    await this.grabTaskRepository.update(id, updateData);
  }

  /**
   * 增加尝试次数
   */
  async incrementAttempts(id: string): Promise<void> {
    await this.grabTaskRepository.increment({ id }, 'attempts', 1);
  }

  /**
   * 记录运行中已被他人占用的座位（实时提醒）
   * 追加写入 result.takenSeats，前端轮询任务状态即可实时看到
   */
  async recordSeatTaken(id: string, seatTitle: string): Promise<void> {
    const task = await this.grabTaskRepository.findOne({ where: { id } });
    if (!task) {
      return;
    }
    const result = task.result ?? {};
    const takenSeats: string[] = Array.isArray(result.takenSeats)
      ? (result.takenSeats as string[])
      : [];
    if (!takenSeats.includes(seatTitle)) {
      takenSeats.push(seatTitle);
    }
    await this.grabTaskRepository.update(id, {
      result: { ...result, takenSeats },
    });
  }

  /**
   * 记录预解析结果（session-precheck 在触发前 5 分钟写入）
   * 合并写入 result.preparse，前端轮询任务状态即可看到盲抢就绪情况：
   * { ok: true, roomName, seatTitles, unresolvedTitles, autoPickedRoom } 或 { ok: false, reason }
   */
  async recordPreparse(
    id: string,
    preparse: Record<string, any>,
  ): Promise<void> {
    const task = await this.grabTaskRepository.findOne({ where: { id } });
    if (!task) {
      return;
    }
    const result = task.result ?? {};
    await this.grabTaskRepository.update(id, {
      result: { ...result, preparse },
    });
  }

  /**
   * 终止任务（支持 pending 与 running 两个阶段）
   * - pending：从延迟队列移除 job，标记为 cancelled
   * - running：设置内存取消标记，worker 重试循环感知后立即退出
   * 已进入终态（success/failed/cancelled）的任务不可再取消
   */
  async cancel(id: string): Promise<void> {
    const task = await this.grabTaskRepository.findOne({ where: { id } });
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    if (task.status === TaskStatus.PENDING) {
      await this.taskScheduler.cancelTask(task.id);
      await this.updateStatus(id, TaskStatus.CANCELLED, {
        reason: '用户手动取消',
      });
      return;
    }

    if (task.status === TaskStatus.RUNNING) {
      await this.requestCancellation(id);
      return;
    }

    throw new BadRequestException('任务已结束，无法取消');
  }

  /**
   * 请求取消运行中的任务：
   * 1. 写入进程内标记，供 worker 循环轮询快速退出
   * 2. 同步更新数据库状态为 cancelled，前端轮询即可感知
   */
  private async requestCancellation(id: string): Promise<void> {
    this.cancellationRequests.add(id);
    await this.updateStatus(id, TaskStatus.CANCELLED, {
      reason: '用户手动取消',
    });
  }

  /**
   * 查询任务是否已被请求取消（供 worker 轮询）
   */
  isCancellationRequested(id: string): boolean {
    return this.cancellationRequests.has(id);
  }
}