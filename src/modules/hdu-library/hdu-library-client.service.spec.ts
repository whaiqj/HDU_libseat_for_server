import { of, throwError } from 'rxjs';
import { HduLibraryClientService, SessionExpiredError } from './hdu-library-client.service';

/** 构造带 response 信息的 axios 风格错误 */
function axiosError(
  message: string,
  status?: number,
  headers?: Record<string, string>,
): Error {
  const err = new Error(message);
  (err as any).response = { status, headers };
  return err;
}

/** 构造客户端实例（注入 mock 依赖） */
function createClient(
  getMock: jest.Mock,
  cookie = 'sid=abc',
): { client: HduLibraryClientService; get: jest.Mock } {
  const httpService = { get: getMock } as any;
  const authKeeper = {
    getCredentials: jest.fn().mockReturnValue({ type: 'cookie', value: cookie }),
  } as any;
  return { client: new HduLibraryClientService(httpService, authKeeper), get: getMock };
}

describe('HduLibraryClientService.getAppointMessages（保守 Session 判定）', () => {
  const ACCOUNT = 'acc-1';

  function okResponse(data: any) {
    return of({ data });
  }

  it('正常响应：解析 content.defaultItems 并提取 bookingId', async () => {
    const { client } = createClient(
      jest.fn().mockReturnValue(
        okResponse({
          is_login: true,
          content: {
            defaultItems: [
              {
                time: '2026-09-01 10:00',
                title: '签到提醒',
                desc: '请及时签到',
                url: 'https://hdu.huitu.zhishulib.com/xxx?bookingId=12345&other=1',
              },
            ],
          },
        }),
      ),
    );

    const messages = await client.getAppointMessages(ACCOUNT);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      time: '2026-09-01 10:00',
      title: '签到提醒',
      desc: '请及时签到',
      bookingId: '12345',
    });
  });

  it('消息列表字段兼容 items / list / data', async () => {
    const { client } = createClient(
      jest.fn().mockReturnValue(
        okResponse({ content: { items: [{ title: 'A', url: '' }] } }),
      ),
    );
    expect(await client.getAppointMessages(ACCOUNT)).toHaveLength(1);

    const { client: c2 } = createClient(
      jest.fn().mockReturnValue(
        okResponse({ content: { list: [{ title: 'B', url: '' }] } }),
      ),
    );
    expect(await c2.getAppointMessages(ACCOUNT)).toHaveLength(1);
  });

  it('url 无 bookingId 时返回 bookingId=null', async () => {
    const { client } = createClient(
      jest.fn().mockReturnValue(
        okResponse({
          content: { defaultItems: [{ title: '公告', url: 'https://x/y' }] },
        }),
      ),
    );
    const messages = await client.getAppointMessages(ACCOUNT);
    expect(messages[0].bookingId).toBeNull();
  });

  it('content 缺失 / 列表非数组：返回空数组，不抛错', async () => {
    const { client } = createClient(
      jest.fn().mockReturnValue(okResponse({ foo: 'bar' })),
    );
    expect(await client.getAppointMessages(ACCOUNT)).toEqual([]);

    const { client: c2 } = createClient(
      jest.fn().mockReturnValue(okResponse({ content: { defaultItems: null } })),
    );
    expect(await c2.getAppointMessages(ACCOUNT)).toEqual([]);
  });

  describe('明确登录失效场景（唯一允许抛 SessionExpiredError）', () => {
    it('接口明确返回 is_login=false → 抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(okResponse({ is_login: false })),
      );
      await expect(client.getAppointMessages(ACCOUNT)).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
    });

    it('3xx 重定向且 Location 含 sso.hdu.edu.cn → 抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(
          throwError(() =>
            axiosError('Redirect', 302, {
              location: 'https://sso.hdu.edu.cn/cas/login?service=xxx',
            }),
          ),
        ),
      );
      await expect(client.getAppointMessages(ACCOUNT)).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
    });

    it('3xx 重定向且 Location 含 login → 抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(
          throwError(() =>
            axiosError('Redirect', 302, {
              location: 'https://hdu.huitu.zhishulib.com/User/Index/login',
            }),
          ),
        ),
      );
      await expect(client.getAppointMessages(ACCOUNT)).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
    });
  });

  describe('模糊异常场景（一律保守处理：仅告警 + 返回空数组，绝不判定失效）', () => {
    it('网络超时异常（无 response）→ 返回空数组，不抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(throwError(() => new Error('timeout of 8000ms exceeded'))),
      );
      await expect(client.getAppointMessages(ACCOUNT)).resolves.toEqual([]);
    });

    it('服务端 5xx 错误 → 返回空数组，不抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(throwError(() => axiosError('Server Error', 500))),
      );
      await expect(client.getAppointMessages(ACCOUNT)).resolves.toEqual([]);
    });

    it('普通 302 重定向（Location 非登录页）→ 返回空数组，不抛 SessionExpiredError', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(
          throwError(() =>
            axiosError('Redirect', 302, {
              location: 'https://hdu.huitu.zhishulib.com/Seat/Index/index',
            }),
          ),
        ),
      );
      await expect(client.getAppointMessages(ACCOUNT)).resolves.toEqual([]);
    });

    it('接口返回业务异常（ui_type=com.Message）→ 返回空数组', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(
          okResponse({ ui_type: 'com.Message', MESSAGE: '参数错误' }),
        ),
      );
      await expect(client.getAppointMessages(ACCOUNT)).resolves.toEqual([]);
    });

    it('数据为空（content 为空对象）→ 返回空数组', async () => {
      const { client } = createClient(
        jest.fn().mockReturnValue(okResponse({ content: {} })),
      );
      await expect(client.getAppointMessages(ACCOUNT)).resolves.toEqual([]);
    });
  });

  it('请求携带账号 Cookie 与端点路径正确', async () => {
    const get = jest.fn().mockReturnValue(okResponse({ content: { defaultItems: [] } }));
    const { client } = createClient(get);

    await client.getAppointMessages(ACCOUNT);

    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/Station/Station/lists/type/appointMessages'),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: 'sid=abc' }),
      }),
    );
  });
});
