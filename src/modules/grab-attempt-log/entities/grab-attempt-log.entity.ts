import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { GrabTask } from '../../grab-task/entities/grab-task.entity';

/** 尝试结果 */
export enum AttemptResult {
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * 抢座尝试日志表
 * 放号瞬间的请求链路无法现场调试，全量日志是复盘性能瓶颈、
 * 优化选座策略、排查风控问题的核心依据
 */
@Entity('grab_attempt_logs')
export class GrabAttemptLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 关联抢座任务 */
  @Column({ type: 'varchar', length: 64 })
  taskId: string;

  @ManyToOne(() => GrabTask)
  @JoinColumn({ name: 'taskId' })
  task: GrabTask;

  /** 关联账号 ID（方便按账号复盘，冗余自任务） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  accountId: string | null;

  /** 本次尝试的座位号 */
  @Column({ type: 'varchar', length: 64 })
  seatId: string;

  /** 尝试结果 */
  @Column({ type: 'enum', enum: AttemptResult })
  result: AttemptResult;

  /** 失败原因详情（成功时为空） */
  @Column({ type: 'varchar', length: 512, nullable: true })
  errorMsg: string | null;

  /** 尝试时间戳 */
  @CreateDateColumn()
  timestamp: Date;

  /** 本轮 searchSeats 请求开始时间戳（epoch 毫秒，耗时埋点） */
  @Column({ type: 'bigint', nullable: true })
  searchStartMs: number | null;

  /** 本轮 searchSeats 请求结束时间戳（epoch 毫秒，耗时埋点） */
  @Column({ type: 'bigint', nullable: true })
  searchEndMs: number | null;

  /** 本条记录对应 bookSeats 请求开始时间戳（epoch 毫秒，耗时埋点；无 bookSeats 的轮次行为空） */
  @Column({ type: 'bigint', nullable: true })
  bookStartMs: number | null;

  /** 本条记录对应 bookSeats 请求结束时间戳（epoch 毫秒，耗时埋点；无 bookSeats 的轮次行为空） */
  @Column({ type: 'bigint', nullable: true })
  bookEndMs: number | null;
}
