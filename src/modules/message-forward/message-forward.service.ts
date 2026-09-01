import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Account, AccountStatus } from '../account/entities/account.entity';
import { ForwardedMessage } from './entities/forwarded-message.entity';
import {
  HduLibraryClientService,
  SessionExpiredError,
} from '../hdu-library/hdu-library-client.service';
import type { AppointmentMessageItem } from '../hdu-library/dto/appoint-messages.dto';
import { classifyMessageByTitle } from './message-classifier';
import type { IAuthKeeperService } from '../session/auth-keeper.service';
import type {
  INotificationService,
  NotificationPayload,
} from '../notification/notification.service';

/** 轮询间隔：默认 2 分钟（环境变量 MESSAGE_FORWARD_INTERVAL_MS 可覆盖） */
const DEFAULT_POLL_INTERVAL_MS = 120_000;

/** 抢座临界窗口期（北京时间）：19:55 – 20:05，含边界 */
const GRAB_WINDOW_START_MINUTE = 19 * 60 + 55;
const GRAB_WINDOW_END_MINUTE = 20 * 60 + 5;

/** 无 bookingId 消息的去重占位符（参与数据库联合唯一键） */
const BOOKING_ID_PLACEHOLDER = 'none';

/** 账号错峰随机延时范围（毫秒） */
const STAGGER_MIN_MS = 300;
const STAGGER_MAX_MS = 1_000;

/** 轮询定时器注册名 */
const POLL_INTERVAL_NAME = 'message-forward-poll';

/** 北京时间当日分钟数（跨时区安全：UTC+8 无夏令时） */
export function beijingMinuteOfDay(date: Date): number {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
}

/** 判断当前是否处于抢座临界窗口期（北京时间 19:55 – 20:05，含边界） */
export function isInGrabWindow(date: Date = new Date()): boolean {
  const minute = beijingMinuteOfDay(date);
  return minute >= GRAB_WINDOW_START_MINUTE && minute <= GRAB_WINDOW_END_MINUTE;
}

/**
 * 图书馆座位消息转发核心服务
 *
 * 职责：轮询 appointMessages 接口 → 账号级基线同步 → 去重 → 分级推送
 *
 * 核心防护规则（最高优先级）：
 * 1. 极致保守的 Session 失效判定：仅明确登录失效（is_login=false / SSO 登录页跳转）才刷新
 * 2. Session 刷新完全复用 RealAuthKeeper 节流机制（本模块不自建节流逻辑）
 * 3. 19:55–20:05 抢座窗口期禁止一切 refreshSession，失效问题顺延至窗口期结束后处理
 *
 * 隔离规则：单账号、单消息异常独立捕获，绝不冒泡影响全局服务与抢座任务
 */
@Injectable()
export class MessageForwardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageForwardService.name);

  /** 进程内防重入锁：防止轮询任务重叠 */
  private polling = false;

  /** 账号级基线同步标记：首次轮询到的账号只入库不推送，杜绝历史消息轰炸 */
  private readonly baselinedAccounts = new Set<string>();

  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(ForwardedMessage)
    private readonly forwardedMessageRepo: Repository<ForwardedMessage>,
    private readonly libraryClient: HduLibraryClientService,
    @Inject('INotificationService')
    private readonly notification: INotificationService,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled = process.env.MESSAGE_FORWARD_ENABLED !== 'false';
    this.intervalMs = Number.parseInt(
      process.env.MESSAGE_FORWARD_INTERVAL_MS ?? String(DEFAULT_POLL_INTERVAL_MS),
      10,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('消息转发功能未启用（MESSAGE_FORWARD_ENABLED=false），跳过轮询注册');
      return;
    }
    // 动态注册轮询定时（间隔来自环境变量，默认 2 分钟；ScheduleModule 由 SessionModule 统一注册）
    this.schedulerRegistry.addInterval(
      POLL_INTERVAL_NAME,
      setInterval(() => {
        void this.pollAllAccounts();
      }, this.intervalMs),
    );
    this.logger.log(`消息转发轮询已启动：间隔 ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.enabled) {
      try {
        this.schedulerRegistry.deleteInterval(POLL_INTERVAL_NAME);
      } catch {
        // 定时器不存在时忽略
      }
    }
  }

  /**
   * 单轮全账号轮询
   * 防重入 + 全链路异常隔离 + 账号错峰随机延时
   */
  private async pollAllAccounts(): Promise<void> {
    if (this.polling) {
      this.logger.warn('上一轮消息轮询尚未结束，跳过本轮（防重入）');
      return;
    }
    this.polling = true;
    try {
      const accounts = await this.accountRepo.find({
        where: { status: AccountStatus.ACTIVE },
      });
      for (const account of accounts) {
        // 单账号异常独立捕获，不影响其他账号
        try {
          await this.processAccount(account.id);
        } catch (error) {
          this.logger.warn(
            `账号消息处理异常（已隔离）: accountId=${account.id} message=${(error as Error).message}`,
          );
        }
        // 账号错峰随机延时，分散请求压力
        await this.sleep(this.randomStaggerMs());
      }
    } catch (error) {
      this.logger.warn(
        `消息轮询全局异常（已隔离，不影响主进程）: ${(error as Error).message}`,
      );
    } finally {
      this.polling = false;
    }
  }

  /**
   * 处理单个账号：拉取消息 → 基线同步或去重转发
   */
  private async processAccount(accountId: string): Promise<void> {
    const isBaselineRound = !this.baselinedAccounts.has(accountId);

    let messages: AppointmentMessageItem[];
    try {
      messages = await this.libraryClient.getAppointMessages(accountId);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        // 仅明确登录失效会走到这里（客户端已做保守过滤）
        await this.handleSessionExpired(accountId, error);
      } else {
        this.logger.warn(
          `拉取消息异常（已隔离）: accountId=${accountId} message=${(error as Error).message}`,
        );
      }
      return;
    }

    if (isBaselineRound) {
      await this.baselineSync(accountId, messages);
      return;
    }

    await this.forwardNewMessages(accountId, messages);
  }

  /**
   * 会话失效处理（核心防护）：
   * - 抢座临界窗口期（19:55–20:05）：仅告警，跳过刷新，顺延至窗口期结束后下一轮轮询
   * - 窗口期外：触发 refreshSession（完全复用 RealAuthKeeper 账号级节流机制）
   */
  private async handleSessionExpired(
    accountId: string,
    error: SessionExpiredError,
  ): Promise<void> {
    if (isInGrabWindow(new Date())) {
      this.logger.warn(
        `抢座临界窗口期（19:55–20:05）检测到会话失效，本轮跳过刷新、顺延至窗口期结束后处理: accountId=${accountId} reason=${error.message}`,
      );
      return;
    }

    this.logger.warn(
      `检测到账号登录态明确失效，触发会话刷新（复用 RealAuthKeeper 节流机制）: accountId=${accountId}`,
    );
    try {
      await this.authKeeper.refreshSession(accountId);
    } catch (refreshError) {
      this.logger.warn(
        `会话刷新失败（等待下一轮轮询再处理）: accountId=${accountId} message=${(refreshError as Error).message}`,
      );
    }
  }

  /**
   * 账号级基线同步：首次轮询到的账号，当前全部消息只入库去重表、不推送
   * 杜绝服务启动 / 新增账号时的历史消息轰炸
   */
  private async baselineSync(
    accountId: string,
    messages: AppointmentMessageItem[],
  ): Promise<void> {
    this.logger.log(
      `账号首轮基线同步（只入库不推送）: accountId=${accountId} 消息数=${messages.length}`,
    );
    for (const message of messages) {
      try {
        await this.saveForwardedMessage(accountId, message);
      } catch (error) {
        // 唯一键冲突（已入库过）或入库异常：仅告警，不影响基线完成
        this.logger.warn(
          `基线入库异常（已隔离）: accountId=${accountId} title=${message.title} message=${(error as Error).message}`,
        );
      }
    }
    this.baselinedAccounts.add(accountId);
  }

  /**
   * 去重转发新消息：
   * 严格遵循「推送成功才入库、失败不入库、下轮重试」
   * 单条消息异常独立捕获，不影响其他消息
   */
  private async forwardNewMessages(
    accountId: string,
    messages: AppointmentMessageItem[],
  ): Promise<void> {
    for (const message of messages) {
      try {
        const bookingId = message.bookingId ?? BOOKING_ID_PLACEHOLDER;

        // 去重：已推送过的消息跳过
        const exists = await this.forwardedMessageRepo.findOne({
          where: { accountId, bookingId, messageTitle: message.title },
        });
        if (exists) {
          continue;
        }

        // 先推送，推送成功才落地去重记录
        await this.notification.notify(this.buildPayload(accountId, message));
        await this.saveForwardedMessage(accountId, message);
      } catch (error) {
        this.logger.warn(
          `单条消息转发异常（已隔离，不入库、下轮重试）: accountId=${accountId} title=${message.title} message=${(error as Error).message}`,
        );
      }
    }
  }

  /** 组装推送 payload：消息分类分级信息一并放入 data */
  private buildPayload(
    accountId: string,
    message: AppointmentMessageItem,
  ): NotificationPayload {
    const classified = classifyMessageByTitle(message.title);
    return {
      userId: accountId,
      type: 'appoint_message',
      data: {
        messageTitle: message.title,
        messageDesc: message.desc,
        messageTime: message.time,
        bookingId: message.bookingId ?? BOOKING_ID_PLACEHOLDER,
        messageLevel: classified.level,
        messageEmoji: classified.emoji,
      },
    };
  }

  /** 推送成功后写入去重记录（accountId + bookingId + messageTitle 联合唯一） */
  private async saveForwardedMessage(
    accountId: string,
    message: AppointmentMessageItem,
  ): Promise<void> {
    const record = this.forwardedMessageRepo.create({
      accountId,
      bookingId: message.bookingId ?? BOOKING_ID_PLACEHOLDER,
      messageTitle: message.title,
    });
    await this.forwardedMessageRepo.save(record);
  }

  /** 账号错峰随机延时（毫秒） */
  private randomStaggerMs(): number {
    return (
      STAGGER_MIN_MS +
      Math.floor(Math.random() * (STAGGER_MAX_MS - STAGGER_MIN_MS))
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
