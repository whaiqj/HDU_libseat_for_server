/**
 * 杭电 CAS 统一认证登录客户端(Node/TS,无需第三方依赖)
 *
 * 逆向最终结论(静态反混淆 + 动态断点 + CryptoJS Hook 三重确认):
 *   0. 密钥:服务器每次会话生成 16 字节,内嵌于 HTML <div id="login-croypto">,
 *      前端缓存到 localStorage.croyptoKey(同一把 key);url_mseAge 已实测排除。
 *      aesEncrypt 参数顺序为 (keyBase64, 明文)。
 *   1. GET  https://sso.hdu.edu.cn/login?service={service}
 *      -> 拿到 Set-Cookie: SESSION=...
 *      -> HTML 内嵌 <div id="login-croypto">{16字节base64密钥}</div>
 *                    <div id="login-page-flowkey">{UUID_JWT,即execution}</div>
 *   2. POST https://sso.hdu.edu.cn/login  (form-urlencoded, 带 SESSION cookie)
 *      username / type=UsernamePassword / _eventId=submit / geolocation='' /
 *      execution=flowkey原样 / croypto=密钥明文 /
 *      password=AES-128-ECB-PKCS7(密钥, 明文密码) base64 /
 *      captcha_payload=AES-128-ECB-PKCS7(密钥, JSON.stringify(captcha对象)) base64
 *      -> 302 Location 含 ticket=ST-xxx
 *   3. GET  {service}?ticket=ST-xxx  -> 302 链,落业务 Cookie(uid/auth 等)
 *
 * 运行(Node >= 23,直接跑 TS):
 *   CAS_USERNAME=xxx CAS_PASSWORD=xxx CAS_SERVICE=https://... node src/cas/cas-login.ts
 */
import crypto from 'node:crypto';

// ============ 配置 ============
const SSO_BASE = 'https://sso.hdu.edu.cn';
/** 业务系统回调地址:浏览器打开图书馆系统跳到 SSO 时,地址栏 service= 参数的值(已抓包确认) */
const SERVICE_URL =
  process.env.CAS_SERVICE ??
  'https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591';
const USERNAME = process.env.CAS_USERNAME ?? '';
const PASSWORD = process.env.CAS_PASSWORD ?? '';

/** 无验证码场景 captcha_payload 的明文(待终验确认,默认 '{}' 与抓包密文长度吻合) */
const CAPTCHA_PAYLOAD_PLAIN = '{}';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 单次 HTTP 请求超时（毫秒），CAS 服务器正常响应通常在 1~3 秒内 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** 整次登录流程总超时（毫秒），包含所有跳转与请求 */
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;

// ============ AES-128-ECB-PKCS7(与 CryptoJS aesEncrypt 等价) ============
export function aesEncryptEcb(keyBase64: string, plaintext: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 16) {
    throw new Error(`AES key 长度应为 16 字节,实际 ${key.length}`);
  }
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

export function aesDecryptEcb(keyBase64: string, ciphertextBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ============ 超时工具 ============
/**
 * 带超时的 fetch 封装
 * @param url 请求地址
 * @param init fetch 参数
 * @param timeoutMs 超时时间（毫秒）
 * @param label 用于错误信息的标签
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e.name === 'AbortError') {
      throw new Error(`[${label}] 请求超时 (${timeoutMs}ms): url=${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============ 极简 Cookie Jar ============
class CookieJar {
  private jar = new Map<string, string>();

  absorb(res: Response) {
    // undici/Node>=18.14 提供 getSetCookie()
    const list = (res.headers as any).getSetCookie?.() ?? [];
    for (const line of list) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  get header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ============ 登录链 ============
export interface CasLoginResult {
  /** 业务系统最终 Cookie(如 uid/auth) */
  cookies: Record<string, string>;
  /** CAS ticket(留档) */
  ticket: string | null;
  /** 结束时的 URL */
  finalUrl: string;
}

function extractHidden(html: string, id: string): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>([^<]*)</[a-z]+>`));
  if (!m) throw new Error(`HTML 中未找到 #${id}`);
  return m[1].trim();
}

async function followRedirects(
  startUrl: string,
  jar: CookieJar,
  timeoutMs: number,
  maxHops = 10,
): Promise<{ url: string; status: number; body: string }> {
  let url = startUrl;
  for (let i = 0; i < maxHops; i++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          redirect: 'manual',
          headers: { 'User-Agent': UA, Cookie: jar.header, Referer: url },
        },
        timeoutMs,
        `followRedirects hop ${i + 1}`,
      );
    } catch (e: any) {
      const cause = e.cause;
      const causeMsg = cause ? ` (${cause.message ?? cause.code ?? cause})` : '';
      throw new Error(`followRedirects 请求失败: url=${url}, error=${e.message}${causeMsg}`);
    }
    jar.absorb(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return { url, status: res.status, body: await res.text() };
  }
  throw new Error('重定向次数超限');
}

export interface CasLoginOptions {
  username: string;
  password: string;
  serviceUrl: string;
  /** 单次请求超时（毫秒），默认 10s */
  requestTimeoutMs?: number;
  /** 整次登录总超时（毫秒），默认 30s */
  totalTimeoutMs?: number;
}

export async function casLogin(opts: CasLoginOptions): Promise<CasLoginResult> {
  const {
    username,
    password,
    serviceUrl,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  } = opts;
  if (!serviceUrl) throw new Error('缺少 serviceUrl(图书馆系统的 CAS 回调地址)');

  // 整次登录总超时控制器
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), totalTimeoutMs);
  const totalTimeoutError = () => new Error(`CAS 登录总超时 (${totalTimeoutMs}ms)`);

  try {
    const jar = new CookieJar();
    const loginPageUrl = `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`;

    // 1. 拿登录页:SESSION cookie + croypto + flowkey
    //    注意:隐藏数据在 <p id="..."> 标签中,不是 <div>
    let pageRes: Response;
    try {
      pageRes = await fetchWithTimeout(
        loginPageUrl,
        {
          redirect: 'manual',
          headers: { 'User-Agent': UA },
          signal: totalController.signal,
        },
        requestTimeoutMs,
        '获取SSO登录页',
      );
    } catch (e: any) {
      if (e.name === 'AbortError' && totalController.signal.aborted) throw totalTimeoutError();
      const cause = e.cause;
      const causeMsg = cause ? ` (${cause.message ?? cause.code ?? cause})` : '';
      throw new Error(`获取 SSO 登录页失败: url=${loginPageUrl}, error=${e.message}${causeMsg}`);
    }
    jar.absorb(pageRes);
    let html = await pageRes.text();
    for (let i = 0; i < 3 && !html.includes('login-croypto'); i++) {
      if (totalController.signal.aborted) throw totalTimeoutError();
      const loc = pageRes.headers.get('location');
      if (!loc) break;
      const r = await fetchWithTimeout(
        new URL(loc, loginPageUrl).toString(),
        {
          redirect: 'manual',
          headers: { 'User-Agent': UA, Cookie: jar.header },
          signal: totalController.signal,
        },
        requestTimeoutMs,
        `登录页跳转 ${i + 1}`,
      );
      jar.absorb(r);
      html = await r.text();
    }
    const croypto = extractHidden(html, 'login-croypto');
    const flowkey = extractHidden(html, 'login-page-flowkey');
    console.log(`[cas] 拿到登录页:SESSION=${jar.header.includes('SESSION') ? 'ok' : 'MISSING'},` +
      ` croypto=${croypto}, flowkey 长度=${flowkey.length}`);

    // 2. 构造表单并 POST /login
    if (totalController.signal.aborted) throw totalTimeoutError();
    const form = new URLSearchParams({
      username,
      type: 'UsernamePassword',
      _eventId: 'submit',
      geolocation: '',
      execution: flowkey,
      croypto,
      password: aesEncryptEcb(croypto, password),
      captcha_payload: aesEncryptEcb(croypto, CAPTCHA_PAYLOAD_PLAIN),
    });

    let postRes: Response;
    try {
      postRes = await fetchWithTimeout(
        `${SSO_BASE}/login`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: jar.header,
            Origin: SSO_BASE,
            Referer: loginPageUrl,
          },
          body: form.toString(),
          signal: totalController.signal,
        },
        requestTimeoutMs,
        '提交SSO登录',
      );
    } catch (e: any) {
      if (e.name === 'AbortError' && totalController.signal.aborted) throw totalTimeoutError();
      const cause = e.cause;
      const causeMsg = cause ? ` (${cause.message ?? cause.code ?? cause})` : '';
      throw new Error(`提交 SSO 登录失败: url=${SSO_BASE}/login, error=${e.message}${causeMsg}`);
    }
    jar.absorb(postRes);

    const location = postRes.headers.get('location') ?? '';
    const ticket = location.match(/[?&]ticket=([^&]+)/)?.[1] ?? null;

    if (!ticket) {
      // 失败:一般 302 回登录页带 error 参数,或 200 返回错误页
      const body = await postRes.text();
      throw new Error(
        `未获取到 ticket(status=${postRes.status}, location=${location || '无'}, ` +
          `body 片段=${body.slice(0, 300).replace(/\s+/g, ' ')})`,
      );
    }
    console.log(`[cas] 登录成功,ticket=${ticket}`);

    // 3. 带 ticket 回业务系统,跟随 302 链收取业务 Cookie
    if (totalController.signal.aborted) throw totalTimeoutError();
    const callbackUrl = new URL(location, SSO_BASE).toString();
    const final = await followRedirects(callbackUrl, jar, requestTimeoutMs);
    console.log(`[cas] 业务系统落地:status=${final.status}, url=${final.url}`);

    return {
      cookies: Object.fromEntries(jar.header.split('; ').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)];
      })),
      ticket,
      finalUrl: final.url,
    };
  } finally {
    clearTimeout(totalTimer);
  }
}

// ============ CLI 直跑 ============
if (process.argv[1] && process.argv[1].endsWith('cas-login.ts')) {
  if (!USERNAME || !PASSWORD || !SERVICE_URL) {
    console.error(
      '用法: CAS_USERNAME=学号 CAS_PASSWORD=密码 CAS_SERVICE=图书馆回调地址 node src/cas/cas-login.ts',
    );
    process.exit(1);
  }
  casLogin({ username: USERNAME, password: PASSWORD, serviceUrl: SERVICE_URL })
    .then((r) => {
      console.log('[cas] 最终 Cookie:', r.cookies);
    })
    .catch((e) => {
      console.error('[cas] 登录失败:', e.message);
      process.exit(1);
    });
}
