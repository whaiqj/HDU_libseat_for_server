import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Unique,
} from 'typeorm';

/**
 * 已成功推送消息去重记录表
 * 联合唯一键：accountId + bookingId + messageTitle
 * 严格遵循「推送成功才入库、失败不入库、下轮重试」
 */
@Entity('forwarded_messages')
@Unique('uq_forwarded_message', ['accountId', 'bookingId', 'messageTitle'])
export class ForwardedMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属账号 */
  @Column({ type: 'varchar', length: 64 })
  accountId: string;

  /** 从消息 url 提取的预约 id；无 bookingId 的消息写入占位符 'none' 参与唯一键 */
  @Column({ type: 'varchar', length: 64 })
  bookingId: string;

  /** 消息标题 */
  @Column({ type: 'varchar', length: 128 })
  messageTitle: string;

  @CreateDateColumn()
  createdAt: Date;
}
