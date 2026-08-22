/**
 * 会话凭证
 * 供 HduLibraryClient 取用（Cookie/Token）
 */
export interface SessionCredential {
  type: 'cookie' | 'token';
  value: string;
  expiresAt?: number;
}

/**
 * 登录态保活服务接口
 * 维护各账号独立登录态，确保抢座瞬间账号处于有效登录状态
 */
export interface IAuthKeeperService {
  /** 心跳检测：判断指定账号登录态是否有效 */
  isSessionValid(accountId: string): Promise<boolean>;

  /** 重新登录指定账号 */
  refreshSession(accountId: string): Promise<void>;

  /** 获取指定账号凭证 */
  getCredentials(accountId: string): SessionCredential;

  /** 账号被删除时丢弃其内存会话 */
  dropSession(accountId: string): void;

  /** 登录成功后写入/覆盖指定账号的内存会话（供 AccountService 即时验证后调用） */
  setSession(accountId: string, credential: SessionCredential): void;
}
