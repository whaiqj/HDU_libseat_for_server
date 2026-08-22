import {
  Injectable,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account, AccountStatus } from './entities/account.entity';
import { GrabTask, TaskStatus } from '../grab-task/entities/grab-task.entity';
import { encryptSecret, decryptSecret } from '../../common/utils/crypto.util';
import { casLogin } from '../../cas/cas-login';
import type { CasLoginResult } from '../../cas/cas-login';
import type { IAuthKeeperService, SessionCredential } from '../session/auth-keeper.service';

/** 创建账号 DTO */
export interface CreateAccountDto {
  username: string;
  password: string;
}

/** 账号列表项（密码字段永不外泄） */
export interface AccountItem {
  id: string;
  username: string;
  status: AccountStatus;
  lastLoginAt: Date | null;
  sessionMeta: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  private readonly serviceUrl: string;

  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(GrabTask)
    private readonly grabTaskRepo: Repository<GrabTask>,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
  ) {
    this.serviceUrl =
      process.env.CAS_SERVICE ??
      'https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591';
  }

  /**
   * 添加账号：先调 CAS 登录即时验证，成功才入库
   */
  async create(dto: CreateAccountDto): Promise<AccountItem> {
    // 1. 即时 CAS 验证
    let loginResult: CasLoginResult;
    try {
      loginResult = await casLogin({
        username: dto.username,
        password: dto.password,
        serviceUrl: this.serviceUrl,
      });
    } catch (error) {
      throw new BadRequestException(
        `CAS 登录验证失败: ${(error as Error).message}`,
      );
    }

    // 2. 加密密码入库
    const passwordEncrypted = encryptSecret(dto.password);
    const account = this.accountRepo.create({
      username: dto.username,
      passwordEncrypted,
      status: AccountStatus.ACTIVE,
      lastLoginAt: new Date(),
      sessionMeta: { isLogin: true, lastCheckAt: new Date().toISOString() },
    });

    const saved = await this.accountRepo.save(account);
    // 3. 登录验证已通过，顺手把会话写入注册表（账号即时可用，不依赖 precheck）
    this.authKeeper.setSession(
      saved.id,
      this.toCredential(loginResult.cookies),
    );
    this.logger.log(`账号 ${dto.username} 创建成功`);

    return this.toItem(saved);
  }

  /**
   * 列出所有账号（密码字段不返回）
   */
  async list(): Promise<AccountItem[]> {
    const accounts = await this.accountRepo.find({
      order: { createdAt: 'ASC' },
    });
    return accounts.map((a) => this.toItem(a));
  }

  /**
   * 删除账号：校验无 pending/running 任务
   */
  async remove(id: string): Promise<void> {
    const account = await this.accountRepo.findOne({ where: { id } });
    if (!account) {
      throw new BadRequestException('账号不存在');
    }

    // 校验无 pending/running 任务
    const activeCount = await this.grabTaskRepo.count({
      where: [
        { accountId: account.id, status: TaskStatus.PENDING },
        { accountId: account.id, status: TaskStatus.RUNNING },
      ],
    });
    if (activeCount > 0) {
      throw new BadRequestException(
        '该账号有进行中的抢座任务，请先取消后再删除',
      );
    }

    await this.accountRepo.remove(account);
    // 删除后通知 authKeeper 丢弃其内存会话
    this.authKeeper.dropSession(account.id);
    this.logger.log(`账号 ${account.username} 已删除`);
  }

  /**
   * 强制重新登录
   */
  async refresh(id: string): Promise<AccountItem> {
    const account = await this.accountRepo.findOne({ where: { id } });
    if (!account) {
      throw new BadRequestException('账号不存在');
    }

    try {
      const password = decryptSecret(account.passwordEncrypted);

      const loginResult = await casLogin({
        username: account.username,
        password,
        serviceUrl: this.serviceUrl,
      });

      account.status = AccountStatus.ACTIVE;
      account.lastLoginAt = new Date();
      account.sessionMeta = {
        isLogin: true,
        lastCheckAt: new Date().toISOString(),
      };

      await this.accountRepo.save(account);
      // 登录成功后同步写入会话注册表（按钮语义：刷新即生效，不依赖 precheck）
      this.authKeeper.setSession(account.id, this.toCredential(loginResult.cookies));
      this.logger.log(`账号 ${account.username} 刷新登录成功`);

      return this.toItem(account);
    } catch (error) {
      account.status = AccountStatus.LOGIN_FAILED;
      account.sessionMeta = {
        isLogin: false,
        lastCheckAt: new Date().toISOString(),
        error: (error as Error).message,
      };
      await this.accountRepo.save(account);

      throw new BadRequestException(
        `刷新登录失败: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 根据 username 查找账号（供会话层使用）
   */
  async findByUsername(username: string): Promise<Account | null> {
    return this.accountRepo.findOne({ where: { username } });
  }

  /**
   * 根据 id 查找账号
   */
  async findById(id: string): Promise<Account | null> {
    return this.accountRepo.findOne({ where: { id } });
  }

  /**
   * 更新账号状态（供会话层心跳回写）
   */
  async updateStatus(
    id: string,
    status: AccountStatus,
    sessionMeta?: Record<string, any>,
  ): Promise<void> {
    const updateData: Partial<Account> = { status };
    if (sessionMeta !== undefined) {
      updateData.sessionMeta = sessionMeta;
    }
    if (status === AccountStatus.ACTIVE) {
      updateData.lastLoginAt = new Date();
    }
    await this.accountRepo.update(id, updateData);
  }

  /** 将 CAS 登录返回的 cookies 转为会话凭证 */
  private toCredential(cookies: Record<string, string>): SessionCredential {
    const cookieString = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return { type: 'cookie', value: cookieString };
  }

  /** 转为对外暴露的 AccountItem（剔除密码） */
  private toItem(account: Account): AccountItem {
    return {
      id: account.id,
      username: account.username,
      status: account.status,
      lastLoginAt: account.lastLoginAt,
      sessionMeta: account.sessionMeta,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }
}