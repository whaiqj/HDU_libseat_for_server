import { of, throwError } from 'rxjs';
import { WxPusherNotificationService } from './wxpusher-notification.service';
import type { NotificationPayload } from './notification.service';

function appointMessagePayload(
  overrides: Partial<NotificationPayload['data']> = {},
): NotificationPayload {
  return {
    userId: 'acc-1',
    type: 'appoint_message',
    data: {
      messageTitle: '签到提醒',
      messageDesc: '请及时签到',
      messageTime: '2026-09-01 10:00',
      bookingId: '12345',
      messageLevel: 'normal',
      messageEmoji: '🔔',
      ...overrides,
    },
  };
}

/** 构造 WxPusher 服务（mock 依赖 + 配置环境变量） */
function createService(postResult: any = of({ data: { code: 1000 } })) {
  process.env.WXPUSHER_APP_TOKEN = 'test-token';
  process.env.WXPUSHER_TOPIC_ID = '123';

  const httpService = { post: jest.fn().mockReturnValue(postResult) } as any;
  const accountService = {
    findById: jest.fn().mockResolvedValue({ username: '22010123' }),
  } as any;

  return {
    service: new WxPusherNotificationService(httpService, accountService),
    httpService,
    accountService,
  };
}

describe('WxPusherNotificationService（appoint_message 渲染分支 + 空 taskId 兼容）', () => {
  afterEach(() => {
    delete process.env.WXPUSHER_APP_TOKEN;
    delete process.env.WXPUSHER_TOPIC_ID;
  });

  it('appoint_message：渲染分级模板并调用 WxPusher 发送', async () => {
    const ctx = createService();

    await ctx.service.notify(appointMessagePayload());

    expect(ctx.httpService.post).toHaveBeenCalledTimes(1);
    const [url, body] = ctx.httpService.post.mock.calls[0];
    expect(url).toBe('https://wxpusher.zjiecode.com/api/send/message');
    expect(body.appToken).toBe('test-token');
    expect(body.contentType).toBe(3);
    expect(body.content).toContain('## 🔔 图书馆消息');
    expect(body.content).toContain('**标题**：🔔 签到提醒');
    expect(body.content).toContain('**账号**：22010123');
  });

  it('appoint_message 无 taskId：正常推送不报错', async () => {
    const ctx = createService();
    await expect(ctx.service.notify(appointMessagePayload())).resolves.not.toThrow();
    expect(ctx.httpService.post).toHaveBeenCalledTimes(1);
  });

  it('alert 级别消息渲染重要警告标题头', async () => {
    const ctx = createService();
    await ctx.service.notify(
      appointMessagePayload({ messageTitle: '超时未签到', messageLevel: 'alert', messageEmoji: '⚠️' }),
    );
    const body = ctx.httpService.post.mock.calls[0][1];
    expect(body.content).toContain('## ⚠️ 图书馆消息（重要警告）');
  });

  it('缺少 messageTitle：跳过推送，不调用 WxPusher', async () => {
    const ctx = createService();
    await ctx.service.notify(
      appointMessagePayload({ messageTitle: undefined }),
    );
    expect(ctx.httpService.post).not.toHaveBeenCalled();
  });

  it('未配置 appToken / topicId：跳过推送且不抛错', async () => {
    process.env.WXPUSHER_APP_TOKEN = '';
    process.env.WXPUSHER_TOPIC_ID = '';
    const httpService = { post: jest.fn() } as any;
    const accountService = { findById: jest.fn() } as any;
    const service = new WxPusherNotificationService(httpService, accountService);

    await expect(service.notify(appointMessagePayload())).resolves.not.toThrow();
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('WxPusher 返回失败码：仅告警不抛错（兜底不影响调用方）', async () => {
    const ctx = createService(of({ data: { code: 2000, msg: 'bad token' } }));
    await expect(ctx.service.notify(appointMessagePayload())).resolves.not.toThrow();
  });

  it('WxPusher 请求异常：仅告警不抛错', async () => {
    const ctx = createService(throwError(() => new Error('network error')));
    await expect(ctx.service.notify(appointMessagePayload())).resolves.not.toThrow();
  });

  it('解析账号失败：回退为 accountId，推送继续', async () => {
    const ctx = createService();
    ctx.accountService.findById.mockRejectedValueOnce(new Error('db down'));

    await ctx.service.notify(appointMessagePayload());

    const body = ctx.httpService.post.mock.calls[0][1];
    expect(body.content).toContain('**账号**：acc-1');
  });

  it('既有抢座类型通知（如 grab_success）不受影响', async () => {
    const ctx = createService();
    await ctx.service.notify({
      userId: 'acc-1',
      taskId: 'task-1',
      type: 'grab_success',
      data: { seatTitle: '3-015' },
      meta: { room: '三楼自习室', date: '2026-09-01', timeStart: '20:00', timeEnd: '22:00' },
    });
    const body = ctx.httpService.post.mock.calls[0][1];
    expect(body.content).toContain('## ✅ 抢座成功');
  });
});
