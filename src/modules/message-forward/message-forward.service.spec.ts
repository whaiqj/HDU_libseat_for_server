import { MessageForwardService, isInGrabWindow } from './message-forward.service';
import { SessionExpiredError } from '../hdu-library/hdu-library-client.service';
import type { AppointmentMessageItem } from '../hdu-library/dto/appoint-messages.dto';

const ACCOUNT_ID = 'acc-1';

function makeMessage(overrides: Partial<AppointmentMessageItem> = {}): AppointmentMessageItem {
  return {
    time: '2026-09-01 10:00',
    title: '签到提醒',
    desc: '请及时签到',
    url: 'https://hdu.huitu.zhishulib.com/xxx?bookingId=12345',
    bookingId: '12345',
    ...overrides,
  };
}

/** 构造 MessageForwardService（全部依赖 mock） */
function createService(overrides: {
  messages?: AppointmentMessageItem[];
  clientError?: Error;
  existingRecord?: unknown;
  notifyError?: Error;
  refreshError?: Error;
} = {}) {
  const accountRepo = {
    find: jest.fn().mockResolvedValue([{ id: ACCOUNT_ID, status: 'active' }]),
  };
  const forwardedMessageRepo = {
    findOne: jest.fn().mockResolvedValue(overrides.existingRecord ?? null),
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const libraryClient = {
    getAppointMessages: jest.fn(
      overrides.clientError
        ? () => Promise.reject(overrides.clientError)
        : () => Promise.resolve(overrides.messages ?? []),
    ),
  };
  const notification = {
    notify: overrides.notifyError
      ? jest.fn(() => Promise.reject(overrides.notifyError))
      : jest.fn().mockResolvedValue(undefined),
  };
  const authKeeper = {
    refreshSession: overrides.refreshError
      ? jest.fn(() => Promise.reject(overrides.refreshError))
      : jest.fn().mockResolvedValue(undefined),
  };
  const schedulerRegistry = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    getIntervals: jest.fn().mockReturnValue([]),
  };

  const service = new MessageForwardService(
    accountRepo as any,
    forwardedMessageRepo as any,
    libraryClient as any,
    notification as any,
    authKeeper as any,
    schedulerRegistry as any,
  );

  return { service, accountRepo, forwardedMessageRepo, libraryClient, notification, authKeeper, schedulerRegistry };
}

describe('isInGrabWindow（抢座临界窗口期判定，北京时间 19:55–20:05 含边界）', () => {
  // 北京时间 = UTC+8
  const at = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 8, 1, h - 8, m, s));

  it('19:54:59 窗口外', () => expect(isInGrabWindow(at(19, 54, 59))).toBe(false));
  it('19:55:00 窗口内（起点含边界）', () => expect(isInGrabWindow(at(19, 55, 0))).toBe(true));
  it('20:00:00 窗口内', () => expect(isInGrabWindow(at(20, 0, 0))).toBe(true));
  it('20:05:00 窗口内（终点含边界）', () => expect(isInGrabWindow(at(20, 5, 0))).toBe(true));
  it('20:06:00 窗口外', () => expect(isInGrabWindow(at(20, 6, 0))).toBe(false));
  it('跨时区安全：UTC 时间 11:57 = 北京时间 19:57 窗口内', () =>
    expect(isInGrabWindow(new Date(Date.UTC(2026, 8, 1, 11, 57, 0)))).toBe(true));
});

describe('MessageForwardService（核心：轮询 + 去重 + 推送 + Session 保守控制）', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.MESSAGE_FORWARD_ENABLED;
    delete process.env.MESSAGE_FORWARD_INTERVAL_MS;
  });

  describe('防重入锁', () => {
    it('上一轮未结束时跳过本轮，不查库不拉消息', async () => {
      const ctx = createService({ messages: [makeMessage()] });
      (ctx.service as any).polling = true;

      await (ctx.service as any).pollAllAccounts();

      expect(ctx.accountRepo.find).not.toHaveBeenCalled();
      expect(ctx.libraryClient.getAppointMessages).not.toHaveBeenCalled();
      // 锁未被误释放
      expect((ctx.service as any).polling).toBe(true);
    });

    it('正常轮询结束后释放锁，可进入下一轮', async () => {
      const ctx = createService({ messages: [] });
      await (ctx.service as any).pollAllAccounts();
      expect((ctx.service as any).polling).toBe(false);
    });
  });

  describe('账号级基线同步（首轮只入库不推送）', () => {
    it('首轮全部消息只入库、不推送通知', async () => {
      const ctx = createService({
        messages: [makeMessage(), makeMessage({ title: '超时未签到', bookingId: '999' })],
      });

      await (ctx.service as any).pollAllAccounts();

      expect(ctx.notification.notify).not.toHaveBeenCalled();
      expect(ctx.forwardedMessageRepo.save).toHaveBeenCalledTimes(2);
      expect((ctx.service as any).baselinedAccounts.has(ACCOUNT_ID)).toBe(true);
    });

    it('基线入库异常（唯一键冲突等）不影响基线完成', async () => {
      const ctx = createService({ messages: [makeMessage()] });
      ctx.forwardedMessageRepo.save.mockRejectedValueOnce(new Error('ER_DUP_ENTRY'));

      await expect((ctx.service as any).pollAllAccounts()).resolves.not.toThrow();

      expect((ctx.service as any).baselinedAccounts.has(ACCOUNT_ID)).toBe(true);
      expect(ctx.notification.notify).not.toHaveBeenCalled();
    });

    it('第二轮起正常推送新消息（服务重启无历史消息轰炸 = 基线先行）', async () => {
      const ctx = createService({ messages: [makeMessage()] });
      await (ctx.service as any).pollAllAccounts(); // 基线轮

      await (ctx.service as any).pollAllAccounts(); // 第二轮

      expect(ctx.notification.notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('去重转发（推送成功才入库、失败不入库下轮重试）', () => {
    beforeEach(() => {
      // 跳过基线：直接标记账号已基线
    });

    function baselined(ctx: ReturnType<typeof createService>) {
      (ctx.service as any).baselinedAccounts.add(ACCOUNT_ID);
    }

    it('新消息：先推送、成功后入库去重记录', async () => {
      const ctx = createService({ messages: [makeMessage()] });
      baselined(ctx);

      await (ctx.service as any).processAccount(ACCOUNT_ID);

      expect(ctx.notification.notify).toHaveBeenCalledTimes(1);
      expect(ctx.forwardedMessageRepo.save).toHaveBeenCalledTimes(1);
      expect(ctx.forwardedMessageRepo.create).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        bookingId: '12345',
        messageTitle: '签到提醒',
      });
    });

    it('已推送过的消息（去重记录存在）不再推送', async () => {
      const ctx = createService({
        messages: [makeMessage()],
        existingRecord: { id: 'record-1' },
      });
      baselined(ctx);

      await (ctx.service as any).processAccount(ACCOUNT_ID);

      expect(ctx.notification.notify).not.toHaveBeenCalled();
      expect(ctx.forwardedMessageRepo.save).not.toHaveBeenCalled();
    });

    it('推送失败：不入库去重记录（下轮自动重试）', async () => {
      const ctx = createService({
        messages: [makeMessage()],
        notifyError: new Error('db write failed'),
      });
      baselined(ctx);

      await expect((ctx.service as any).processAccount(ACCOUNT_ID)).resolves.not.toThrow();

      expect(ctx.notification.notify).toHaveBeenCalledTimes(1);
      expect(ctx.forwardedMessageRepo.save).not.toHaveBeenCalled();
    });

    it('推送失败的消息下轮重试成功后正常入库', async () => {
      const ctx = createService({ messages: [makeMessage()] });
      baselined(ctx);

      // 第一轮：推送失败，不入库
      ctx.notification.notify.mockRejectedValueOnce(new Error('push failed'));
      await (ctx.service as any).processAccount(ACCOUNT_ID);
      expect(ctx.forwardedMessageRepo.save).not.toHaveBeenCalled();

      // 第二轮：findOne 仍无记录 → 重推 → 成功入库
      await (ctx.service as any).processAccount(ACCOUNT_ID);
      expect(ctx.notification.notify).toHaveBeenCalledTimes(2);
      expect(ctx.forwardedMessageRepo.save).toHaveBeenCalledTimes(1);
    });

    it('不同预约 / 不同标题消息互不误去重（唯一键三元组查询）', async () => {
      const ctx = createService({
        messages: [
          makeMessage(),                                    // bookingId=12345, 签到提醒
          makeMessage({ bookingId: '67890', url: 'x?bookingId=67890' }), // 同标题不同预约
          makeMessage({ title: '超时未签到' }),             // 同预约不同标题
        ],
      });
      baselined(ctx);

      await (ctx.service as any).processAccount(ACCOUNT_ID);

      expect(ctx.notification.notify).toHaveBeenCalledTimes(3);
      const queries = ctx.forwardedMessageRepo.findOne.mock.calls.map(
        (c) => c[0].where,
      );
      expect(queries).toEqual([
        { accountId: ACCOUNT_ID, bookingId: '12345', messageTitle: '签到提醒' },
        { accountId: ACCOUNT_ID, bookingId: '67890', messageTitle: '签到提醒' },
        { accountId: ACCOUNT_ID, bookingId: '12345', messageTitle: '超时未签到' },
      ]);
    });

    it('无 bookingId 消息使用占位符 none 参与去重', async () => {
      const ctx = createService({
        messages: [makeMessage({ bookingId: null, url: 'https://x/y' })],
      });
      baselined(ctx);

      await (ctx.service as any).processAccount(ACCOUNT_ID);

      expect(ctx.forwardedMessageRepo.findOne).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID, bookingId: 'none', messageTitle: '签到提醒' },
      });
      expect(ctx.forwardedMessageRepo.create).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        bookingId: 'none',
        messageTitle: '签到提醒',
      });
    });

    it('推送 payload 携带分类分级信息，type=appoint_message，无 taskId', async () => {
      const ctx = createService({ messages: [makeMessage({ title: '超时未签到' })] });
      baselined(ctx);

      await (ctx.service as any).processAccount(ACCOUNT_ID);

      const payload = ctx.notification.notify.mock.calls[0][0];
      expect(payload.type).toBe('appoint_message');
      expect(payload.userId).toBe(ACCOUNT_ID);
      expect(payload.taskId).toBeUndefined();
      expect(payload.data).toMatchObject({
        messageTitle: '超时未签到',
        messageDesc: '请及时签到',
        messageTime: '2026-09-01 10:00',
        bookingId: '12345',
        messageLevel: 'alert',
      });
    });
  });

  describe('Session 保守失效判定 + 抢座窗口避让（核心防护）', () => {
    /** 以指定北京时间运行测试体 */
    async function atBeijingTime(h: number, m: number, fn: () => Promise<void>) {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(Date.UTC(2026, 8, 1, h - 8, m, 0)));
      await fn();
    }

    it('明确登录失效（is_login=false 抛 SessionExpiredError）且窗口外 → 触发 refreshSession（复用 RealAuthKeeper 节流）', async () => {
      const ctx = createService({
        clientError: new SessionExpiredError('is_login=false'),
      });

      await atBeijingTime(15, 0, async () => {
        await (ctx.service as any).processAccount(ACCOUNT_ID);
      });

      expect(ctx.authKeeper.refreshSession).toHaveBeenCalledTimes(1);
      expect(ctx.authKeeper.refreshSession).toHaveBeenCalledWith(ACCOUNT_ID);
      // 会话失效轮不推送
      expect(ctx.notification.notify).not.toHaveBeenCalled();
    });

    it('抢座窗口期内（19:55–20:05）检测到失效 → 不刷新，仅顺延', async () => {
      const ctx = createService({
        clientError: new SessionExpiredError('is_login=false'),
      });

      await atBeijingTime(19, 57, async () => {
        await (ctx.service as any).processAccount(ACCOUNT_ID);
      });

      expect(ctx.authKeeper.refreshSession).not.toHaveBeenCalled();
    });

    it('窗口起点 19:55 同样避让', async () => {
      const ctx = createService({
        clientError: new SessionExpiredError('302 -> sso'),
      });

      await atBeijingTime(19, 55, async () => {
        await (ctx.service as any).processAccount(ACCOUNT_ID);
      });

      expect(ctx.authKeeper.refreshSession).not.toHaveBeenCalled();
    });

    it('窗口终点 20:05 同样避让，20:06 起恢复刷新', async () => {
      const inWindow = createService({
        clientError: new SessionExpiredError('is_login=false'),
      });
      await atBeijingTime(20, 5, async () => {
        await (inWindow.service as any).processAccount(ACCOUNT_ID);
      });
      expect(inWindow.authKeeper.refreshSession).not.toHaveBeenCalled();

      const outWindow = createService({
        clientError: new SessionExpiredError('is_login=false'),
      });
      await atBeijingTime(20, 6, async () => {
        await (outWindow.service as any).processAccount(ACCOUNT_ID);
      });
      expect(outWindow.authKeeper.refreshSession).toHaveBeenCalledTimes(1);
    });

    it('refreshSession 失败也不冒泡（异常隔离，等待下一轮）', async () => {
      const ctx = createService({
        clientError: new SessionExpiredError('is_login=false'),
        refreshError: new Error('CAS login failed'),
      });

      await atBeijingTime(15, 0, async () => {
        await expect((ctx.service as any).processAccount(ACCOUNT_ID)).resolves.not.toThrow();
      });

      expect(ctx.authKeeper.refreshSession).toHaveBeenCalledTimes(1);
    });

    it('非 SessionExpiredError 的客户端异常 → 不触发刷新，异常隔离', async () => {
      const ctx = createService({
        clientError: new Error('network timeout'),
      });

      await expect((ctx.service as any).processAccount(ACCOUNT_ID)).resolves.not.toThrow();
      expect(ctx.authKeeper.refreshSession).not.toHaveBeenCalled();
      expect(ctx.notification.notify).not.toHaveBeenCalled();
    });
  });

  describe('异常隔离（不影响其他账号 / 主进程）', () => {
    it('单账号拉取异常不影响其他账号正常轮询', async () => {
      const accountRepo = {
        find: jest.fn().mockResolvedValue([
          { id: 'acc-bad', status: 'active' },
          { id: 'acc-good', status: 'active' },
        ]),
      };
      const forwardedMessageRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((x) => x),
        save: jest.fn().mockResolvedValue({}),
      };
      const libraryClient = {
        getAppointMessages: jest
          .fn()
          .mockRejectedValueOnce(new Error('acc-bad boom'))
          .mockResolvedValueOnce([makeMessage()]),
      };
      const notification = { notify: jest.fn().mockResolvedValue(undefined) };
      const authKeeper = { refreshSession: jest.fn() };
      const schedulerRegistry = { addInterval: jest.fn(), deleteInterval: jest.fn() };

      const service = new MessageForwardService(
        accountRepo as any,
        forwardedMessageRepo as any,
        libraryClient as any,
        notification as any,
        authKeeper as any,
        schedulerRegistry as any,
      );
      // 两个账号均已基线，直接进入转发路径
      (service as any).baselinedAccounts.add('acc-bad');
      (service as any).baselinedAccounts.add('acc-good');

      await expect((service as any).pollAllAccounts()).resolves.not.toThrow();

      expect(libraryClient.getAppointMessages).toHaveBeenCalledTimes(2);
      expect(notification.notify).toHaveBeenCalledTimes(1); // acc-good 的消息正常推送
    });

    it('账号列表查询失败（全局异常）不冒泡、不影响主进程', async () => {
      const ctx = createService({ messages: [] });
      ctx.accountRepo.find.mockRejectedValueOnce(new Error('db down'));

      await expect((ctx.service as any).pollAllAccounts()).resolves.not.toThrow();
      expect((ctx.service as any).polling).toBe(false);
    });

    it('仅轮询 ACTIVE 状态账号', async () => {
      const ctx = createService({ messages: [] });
      await (ctx.service as any).pollAllAccounts();
      expect(ctx.accountRepo.find).toHaveBeenCalledWith({ where: { status: 'active' } });
    });
  });

  describe('轮询注册与开关（环境变量）', () => {
    it('默认启用：onModuleInit 注册轮询定时器', () => {
      jest.useFakeTimers();
      try {
        const ctx = createService({});
        (ctx.service as any).onModuleInit();

        expect(ctx.schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
        expect(ctx.schedulerRegistry.addInterval.mock.calls[0][0]).toBe('message-forward-poll');
        expect(typeof ctx.schedulerRegistry.addInterval.mock.calls[0][1]).toBe('object');
      } finally {
        jest.useRealTimers();
      }
    });

    it('MESSAGE_FORWARD_ENABLED=false：不注册轮询（动态启停）', () => {
      process.env.MESSAGE_FORWARD_ENABLED = 'false';
      const ctx = createService({});
      (ctx.service as any).onModuleInit();

      expect(ctx.schedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('MESSAGE_FORWARD_INTERVAL_MS 覆盖默认轮询间隔', () => {
      process.env.MESSAGE_FORWARD_INTERVAL_MS = '60000';
      const ctx = createService({});
      expect((ctx.service as any).intervalMs).toBe(60_000);
      expect((ctx.service as any).enabled).toBe(true);
    });

    it('默认间隔 2 分钟', () => {
      const ctx = createService({});
      expect((ctx.service as any).intervalMs).toBe(120_000);
    });
  });
});
