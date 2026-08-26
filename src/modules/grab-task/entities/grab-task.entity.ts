import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 任务状态 */
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  /** 用户手动终止（pending 阶段取消或 running 阶段中途停止） */
  CANCELLED = 'cancelled',
}

/**
 * 抢座任务表
 * 用户提前配置抢座需求，系统以任务为单位执行调度
 */
@Entity('grab_tasks')
export class GrabTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属账号 ID（关联 accounts.id） */
  @Column({ type: 'varchar', length: 64 })
  accountId: string;

  /** 空间分类 ID（对应第三方 space_category.category_id，如二楼东=591） */
  @Column({ type: 'varchar', length: 64 })
  categoryId: string;

  /** 空间内容 ID（对应第三方 space_category.content_id，如二楼东=3） */
  @Column({ type: 'varchar', length: 64 })
  contentId: string;

  /**
   * 指定房间 ID（可选）。多房间分类下同一座位号在不同房间是不同 seatId，
   * 锁定房间后偏好座位号才能唯一解析；为空时由预解析自动挑选
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  roomId: string | null;

  /** 指定房间名称（可选，冗余存储便于前端展示与日志可读） */
  @Column({ type: 'varchar', length: 128, nullable: true })
  roomName: string | null;

  /** 预约使用的开始时间（Unix 时间戳，传给 searchSeats/bookSeats） */
  @Column({ type: 'bigint' })
  beginTime: number;

  /** 预约时长（秒） */
  @Column({ type: 'int' })
  duration: number;

  /** 优先座位号列表，可为空 */
  @Column({ type: 'simple-json', nullable: true })
  seatPreference: string[];

  /** 严格座位模式：仅使用 seatPreference 中的座位，不降级到推荐或任意座位 */
  @Column({ type: 'boolean', default: false })
  strictMode: boolean;

  /** 抢座触发时间（放号时间点对应的时间戳） */
  @Column({ type: 'bigint' })
  triggerAt: number;

  /** 任务状态 */
  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.PENDING })
  status: TaskStatus;

  /** 已尝试次数 */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** 最终结果（成功座位号 / 失败原因），JSON 格式 */
  @Column({ type: 'simple-json', nullable: true })
  result: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}