import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { IAuthKeeperService, SessionCredential } from './auth-keeper.service';
import { Account, AccountStatus } from '../account/entities/account.entity';
import { casLogin } from '../../cas/cas-login';
import { LIBRARY_API } from '../../common/constants/api-endpoints';
import { STUDY_ROOM_SPACE_CATEGORY, CAS_SERVICE_URL } from '../../common/constants/study-room';
import { buildFormBody, FORM_CONTENT_TYPE } from '../../common/utils/form-urlencoded.util';
import { encryptSecret, decryptSecret } from '../../common/utils/crypto.util';

/** 心跳 tick 间隔：60 秒（内部按账号各自 5 分钟错峰检查） */
const HEARTBEAT_TICK_MS = 60 * 1000;
/** 每账号心跳检查间隔：5 分钟 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** 账号登录/心跳错峰间隔：约 1 秒 */
const STAGGER_MS = 1000;

/** 单个账号的内存会话 */
interface AccountSession {
  /** 该账号当前 cookie */
  credential: SessionCredential;
  /** 该账号的登录并发锁（锁粒度 = 单账号） */
  loginPromise: Promise<void> | null;
  /** 下次心跳检查时间戳（ms） */
  nextCheckAt: number;
}

/**
 * 真实 AuthKeeperService 实现（会话注册表）
 * 通过 CAS 统一认证登录，为每个账号各自维护独立登录态
 *
 * 会话隔离：sessions Map 按 accountId 键控，A 账号重登不会阻塞 B 账号抢座
 * 心跳检测：单个 @Interval(60s) tick，内部按账号 5 分钟错峰检查 searchSeats 的 is_login 字段
 * 并发控制：每个账号一把独立登录锁（loginPromise）
 */
@Injectable()
export class RealAuthKeeperService implements IAuthKeeperService, OnModuleInit {
  private readonly logger = new Logger(RealAuthKeeperService.name);

  private readonly sessions = new Map<string, AccountSession>();

  private readonly serviceUrl: string;
  private readonly libraryBaseUrl: string;

  /** 心跳检测用轻量参数（每次动态计算 beginTime，避免过期时间戳） */
  private getHeartbeatParams() {
    return {
      beginTime: Math.floor(Date.now() / 1000),
      duration: 3600,
      num: 1,
      space_category: {
        category_id: STUDY_ROOM_SPACE_CATEGORY.category_id,
        content_id: STUDY_ROOM_SPACE_CATEGORY.content_id,
      },
    };
  }

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
  ) {
    this.serviceUrl = process.env.CAS_SERVICE ?? CAS_SERVICE_URL;
    this.libraryBaseUrl =
      process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';
  }

  async onModuleInit(): Promise<void> {
    // 环境变量兼容：accounts 表为空且 CAS_USERNAME/CAS_PASSWORD 已配置时，自动种子一条账号记录
    await this.seedAccountFromEnvIfNeeded();

    // 加载全部 ACTIVE 账号，逐个串行登录，间隔约 1s 错峰
    const accounts = await this.accountRepo.find({
      where: { status: AccountStatus.ACTIVE },
    });
    for (const account of accounts) {
      try {
        const password = decryptSecret(account.passwordEncrypted);
        await this.ensureLoggedIn(account.id, account.username, password);
        this.logger.log(`初始化登录成功: ${account.username}`);
        this.writeBackStatus(account.id, AccountStatus.ACTIVE, {
          isLogin: true,
          lastCheckAt: new Date().toISOString(),
        });
      } catch (error) {
        this.logger.error(
          `初始化登录失败: ${account.username}: ${(error as Error).message}`,
        );
        this.writeBackStatus(account.id, AccountStatus.LOGIN_FAILED, {
          isLogin: false,
          lastCheckAt: new Date().toISOString(),
          error: (error as Error).message,
        });
      }
      await this.sleep(STAGGER_MS);
    }
  }

  /**
   * 定时心跳检测
   * 每 60s tick 一次，内部只检查到期的账号，账号间 sleep ~1s 错峰
   */
  @Interval(HEARTBEAT_TICK_MS)
  private async heartbeatCheck(): Promise<void> {
    const now = Date.now();
    for (const [accountId, session] of this.sessions) {
      if (session.nextCheckAt > now) {
        continue;
      }
      try {
        const isValid = await this.isSessionValid(accountId);
        if (!isValid) {
          this.logger.warn(`心跳检测到账号 ${accountId} 登录态失效，尝试重新登录`);
          try {
            await this.refreshSessionInternal(accountId, 'heartbeat_refresh');
            this.logger.log(`心跳重新登录成功: ${accountId}`);
          } catch (error) {
            this.logger.error(
              `心跳重新登录失败: ${accountId}: ${(error as Error).message}，等待下一次心跳`,
            );
          }
        } else {
          // 回写最近心跳结果（isLogin + 检查时间），供前端展示
          this.writeBackStatus(accountId, AccountStatus.ACTIVE, {
            isLogin: true,
            lastCheckAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        this.logger.error(`心跳检测异常: ${accountId}: ${(error as Error).message}`);
      }
      // 更新该账号下次检查时间，并错峰
      const s = this.sessions.get(accountId);
      if (s) s.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
      await this.sleep(STAGGER_MS);
    }
  }

  /** 心跳检测：调用 searchSeats 检查 is_login 字段 */
  async isSessionValid(accountId: string): Promise<boolean> {
    const session = this.sessions.get(accountId);
    if (!session || !session.credential.value) {
      this.logger.warn(`账号 ${accountId} 无有效凭证，视为会话失效`);
      return false;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.libraryBaseUrl}${LIBRARY_API.SEARCH_SEATS}`,
          buildFormBody(this.getHeartbeatParams()),
          {
            headers: {
              Cookie: session.credential.value,
              'Content-Type': FORM_CONTENT_TYPE,
            },
          },
        ),
      );

      const raw = response.data;
      if (raw?.is_login === false) {
        this.logger.warn(`心跳检测: 账号 ${accountId} is_login=false，会话已失效`);
        return false;
      }

      return true;
    } catch (error) {
      // 网络异常时保守判断：如果返回 302（重定向到 SSO），则会话失效
      if ((error as any).response?.status === 302) {
        this.logger.warn(`心跳检测: 账号 ${accountId} 收到 302 重定向，会话已失效`);
        return false;
      }
      // 其他网络错误：保守维持当前判断，不误判为失效
      this.logger.warn(
        `心跳检测异常: 账号 ${accountId}: ${(error as Error).message}，保守维持当前登录态`,
      );
      return true;
    }
  }

  /**
   * 重新登录指定账号（公开接口，供外部调用）
   * 读库取密码（解密）→ casLogin → 更新 Map；沿用每账号独立并发锁
   */
  async refreshSession(accountId: string): Promise<void> {
    return this.refreshSessionInternal(accountId, 'manual_refresh');
  }

  /**
   * 重新登录指定账号（内部实现，带触发来源）
   */
  private async refreshSessionInternal(
    accountId: string,
    trigger: 'heartbeat_refresh' | 'manual_refresh',
  ): Promise<void> {
    const account = await this.accountRepo.findOne({ where: { id: accountId } });
    if (!account) {
      throw new Error(`账号 ${accountId} 不存在`);
    }
    const password = decryptSecret(account.passwordEncrypted);

    try {
      await this.ensureLoggedInWithTrigger(accountId, account.username, password, trigger);
      this.writeBackStatus(accountId, AccountStatus.ACTIVE, {
        isLogin: true,
        lastCheckAt: new Date().toISOString(),
      });
    } catch (error) {
      this.writeBackStatus(accountId, AccountStatus.LOGIN_FAILED, {
        isLogin: false,
        lastCheckAt: new Date().toISOString(),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /** 获取指定账号凭证 */
  getCredentials(accountId: string): SessionCredential {
    const session = this.sessions.get(accountId);
    if (!session) {
      throw new Error(
        `账号 ${accountId} 不存在于会话注册表（数据一致性异常，请确认账号已登录）`,
      );
    }
    return session.credential;
  }

  /** 账号被删除时丢弃其内存会话 */
  dropSession(accountId: string): void {
    this.sessions.delete(accountId);
    this.logger.log(`已丢弃账号会话: ${accountId}`);
  }

  /** 登录成功后写入/覆盖指定账号的内存会话 */
  setSession(accountId: string, credential: SessionCredential): void {
    this.sessions.set(accountId, {
      credential,
      loginPromise: null,
      nextCheckAt: Date.now() + CHECK_INTERVAL_MS,
    });
    this.logger.log(`已写入账号会话: ${accountId}`);
  }

  /**
   * 环境变量兼容：accounts 表为空且 CAS_USERNAME/CAS_PASSWORD 已配置时，自动种子一条账号
   */
  private async seedAccountFromEnvIfNeeded(): Promise<void> {
    const casUsername = process.env.CAS_USERNAME;
    const casPassword = process.env.CAS_PASSWORD;
    if (!casUsername || !casPassword) {
      return;
    }
    const count = await this.accountRepo.count();
    if (count > 0) {
      return;
    }
    try {
      const passwordEncrypted = encryptSecret(casPassword);
      const seeded = this.accountRepo.create({
        username: casUsername,
        passwordEncrypted,
        status: AccountStatus.ACTIVE,
        lastLoginAt: null,
        sessionMeta: null,
      });
      await this.accountRepo.save(seeded);
      this.logger.log(
        `环境变量兼容：已从 CAS_USERNAME/CAS_PASSWORD 种子账号 ${casUsername}`,
      );
    } catch (error) {
      this.logger.error(`环境变量兼容种子账号失败: ${(error as Error).message}`);
    }
  }

  /**
   * 单账号登录并发锁
   * 确保同一账号不会同时触发多次登录，也不会让业务请求用到正在失效的旧凭证
   */
  private async ensureLoggedIn(
    accountId: string,
    username: string,
    password: string,
  ): Promise<void> {
    return this.ensureLoggedInWithTrigger(accountId, username, password, 'new_account');
  }

  /**
   * 单账号登录并发锁（带触发来源）
   */
  private async ensureLoggedInWithTrigger(
    accountId: string,
    username: string,
    password: string,
    trigger: 'heartbeat_refresh' | 'manual_refresh' | 'new_account',
  ): Promise<void> {
    let session = this.sessions.get(accountId);
    if (!session) {
      session = {
        credential: { type: 'cookie', value: '' },
        loginPromise: null,
        nextCheckAt: 0,
      };
      this.sessions.set(accountId, session);
    }
    if (session.loginPromise) {
      this.logger.log(`账号 ${username} 已有登录流程进行中，等待其完成`);
      return session.loginPromise;
    }
    session.loginPromise = this.login(accountId, username, password, trigger)
      .catch((error) => {
        // 登录失败：清空该账号凭证，向上抛出
        const s = this.sessions.get(accountId);
        if (s) s.credential = { type: 'cookie', value: '' };
        throw error;
      })
      .finally(() => {
        const s = this.sessions.get(accountId);
        if (s) s.loginPromise = null;
      });
    return session.loginPromise;
  }

  /**
   * 执行 CAS 登录流程，将 cookies 转为 SessionCredential 并写入对应账号会话
   */
  private async login(
    accountId: string,
    username: string,
    password: string,
    trigger: 'heartbeat_refresh' | 'manual_refresh' | 'new_account' = 'new_account',
  ): Promise<void> {
    this.logger.log(`[登录触发] accountId=${accountId} username=${username} trigger=${trigger}`);

    const result = await casLogin({
      username,
      password,
      serviceUrl: this.serviceUrl,
    });

    // 将 cookies Record 转为 cookie header 字符串
    const cookieString = Object.entries(result.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const session = this.sessions.get(accountId);
    if (session) {
      session.credential = { type: 'cookie', value: cookieString };
      session.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
    }

    this.logger.log(
      `登录成功: ${username}，获取到 ${Object.keys(result.cookies).length} 个 cookie，ticket=${result.ticket}`,
    );
  }

  /**
   * 登录/心跳结果回写 accounts 表（fire-and-forget，不阻塞主流程）
   */
  private writeBackStatus(
    accountId: string,
    status: AccountStatus,
    sessionMeta: Record<string, any>,
  ): void {
    const update: Partial<Account> = { status, sessionMeta };
    if (status === AccountStatus.ACTIVE) {
      update.lastLoginAt = new Date();
    }
    void this.accountRepo.update(accountId, update).catch((error) => {
      this.logger.warn(`账号状态回写失败: ${accountId}: ${(error as Error).message}`);
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
