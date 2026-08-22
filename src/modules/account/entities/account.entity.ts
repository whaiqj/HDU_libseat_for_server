import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 账号状态 */
export enum AccountStatus {
  /** 登录态正常（或最近一次验证通过） */
  ACTIVE = 'active',
  /** 最近一次登录失败（密码错/网络问题） */
  LOGIN_FAILED = 'login_failed',
}

/**
 * 图书馆账号表
 * 每个账号各自维持独立 CAS 登录态（cookie）
 */
@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 学号 */
  @Column({ type: 'varchar', length: 64, unique: true })
  username: string;

  /** AES-256-GCM 密文（密码永不外泄） */
  @Column({ type: 'text' })
  passwordEncrypted: string;

  /** 账号状态 */
  @Column({ type: 'enum', enum: AccountStatus, default: AccountStatus.ACTIVE })
  status: AccountStatus;

  /** 最近一次登录时间 */
  @Column({ type: 'datetime', nullable: true })
  lastLoginAt: Date | null;

  /** 最近心跳结果（isLogin、检查时间等），供前端展示 */
  @Column({ type: 'simple-json', nullable: true })
  sessionMeta: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}