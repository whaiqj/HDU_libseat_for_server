import { Injectable } from '@nestjs/common';
import { IAuthKeeperService, SessionCredential } from './auth-keeper.service';

/**
 * AuthKeeperService Mock 实现
 * 按账号键控 mock 凭证，恒返回有效登录态——测试链路不用真实密码
 */
@Injectable()
export class MockAuthKeeperService implements IAuthKeeperService {
  private readonly mockSessions = new Map<string, SessionCredential>();

  /** 确保某账号存在 mock 凭证（恒有效） */
  private ensureMock(accountId: string): SessionCredential {
    let credential = this.mockSessions.get(accountId);
    if (!credential) {
      credential = {
        type: 'cookie',
        value: `mock-session-cookie-${accountId}`,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      };
      this.mockSessions.set(accountId, credential);
    }
    return credential;
  }

  async isSessionValid(accountId: string): Promise<boolean> {
    return true;
  }

  async refreshSession(accountId: string): Promise<void> {
    this.ensureMock(accountId);
  }

  getCredentials(accountId: string): SessionCredential {
    return this.ensureMock(accountId);
  }

  dropSession(accountId: string): void {
    this.mockSessions.delete(accountId);
  }

  setSession(accountId: string, credential: SessionCredential): void {
    this.mockSessions.set(accountId, credential);
  }
}
