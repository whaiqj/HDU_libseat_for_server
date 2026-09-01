import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

/** 通知类型 */
export type NotificationType =
  | 'grab_success'
  | 'grab_failed'
  | 'grab_started'
  | 'seat_taken'
  | 'pre_reminder'
  | 'session_precheck_failed'
  | 'preparse_warning'
  | 'appoint_message';

/**
 * 通知记录表
 * 抢座结果实时触达用户，前端通过轮询此表查询任务状态
 */
@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属用户 */
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  /** 关联抢座任务（消息转发类通知无任务上下文，允许为空） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  taskId: string | null;

  /** 通知类型 */
  @Column({ type: 'varchar', length: 32 })
  type: NotificationType;

  /** 通知数据（JSON） */
  @Column({ type: 'simple-json', nullable: true })
  data: {
    seatTitle?: string;
    categoryId?: string;
    errorReason?: string;
    messageTitle?: string;
    messageDesc?: string;
    messageTime?: string;
    bookingId?: string;
    messageLevel?: string;
    messageEmoji?: string;
  } | null;

  @CreateDateColumn()
  createdAt: Date;
}