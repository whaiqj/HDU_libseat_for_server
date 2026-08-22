import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GrabAttemptLog,
  AttemptResult,
} from './entities/grab-attempt-log.entity';

/** 创建尝试日志的参数 */
export interface CreateAttemptLogParams {
  taskId: string;
  accountId?: string | null;
  seatId: string;
  result: AttemptResult;
  errorMsg?: string | null;
  /** 本轮 searchSeats 请求开始时间戳（epoch 毫秒，耗时埋点） */
  searchStartMs?: number | null;
  /** 本轮 searchSeats 请求结束时间戳（epoch 毫秒，耗时埋点） */
  searchEndMs?: number | null;
  /** 本条记录对应 bookSeats 请求开始时间戳（epoch 毫秒，耗时埋点） */
  bookStartMs?: number | null;
  /** 本条记录对应 bookSeats 请求结束时间戳（epoch 毫秒，耗时埋点） */
  bookEndMs?: number | null;
}

@Injectable()
export class GrabAttemptLogService {
  constructor(
    @InjectRepository(GrabAttemptLog)
    private readonly repo: Repository<GrabAttemptLog>,
  ) {}

  /**
   * 记录一次抢座尝试
   */
  async log(params: CreateAttemptLogParams): Promise<GrabAttemptLog> {
    const record = this.repo.create({
      taskId: params.taskId,
      accountId: params.accountId ?? null,
      seatId: params.seatId,
      result: params.result,
      errorMsg: params.errorMsg ?? null,
      searchStartMs: params.searchStartMs ?? null,
      searchEndMs: params.searchEndMs ?? null,
      bookStartMs: params.bookStartMs ?? null,
      bookEndMs: params.bookEndMs ?? null,
    });
    return this.repo.save(record);
  }

  /**
   * 查询某任务的所有尝试记录
   */
  async findByTaskId(taskId: string): Promise<GrabAttemptLog[]> {
    return this.repo.find({
      where: { taskId },
      order: { timestamp: 'ASC' },
    });
  }
}
