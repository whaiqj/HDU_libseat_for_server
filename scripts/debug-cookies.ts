/**
 * Cookie 来源排查脚本
 *
 * 目的：找出 api_access_token 这个 cookie 是在哪个环节种下的。
 * 逐步骤访问 CAS 登录后的关键页面，每步打印新增的 cookie。
 *
 * 运行方式：npx tsx scripts/debug-cookies.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, 'utf-8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

import { casLogin } from '../src/cas/cas-login';
import { CAS_SERVICE_URL } from '../src/common/constants/study-room';

const LIBRARY_BASE =
  process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ===== 更完善的 CookieJar：支持按域名、记录 Set-Cookie 来源 =====
interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  fromStep: string;
}

class DebugCookieJar {
  cookies: CookieEntry[] = [];
  history: { step: string; setCookies: string[] }[] = [];

  absorb(res: Response, currentUrl: string, step: string): string[] {
    const setCookies = (res.headers as any).getSetCookie?.() ?? [];
    const domain = new URL(currentUrl).hostname;
    const newOnes: string[] = [];

    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';').map(s => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let path = '/';
      for (const attr of attrs) {
        if (attr.toLowerCase().startsWith('path=')) {
          path = attr.slice(5);
        }
      }

      // 记录
      const existingIdx = this.cookies.findIndex(c => c.name === name && c.domain === domain);
      if (existingIdx >= 0) {
        this.cookies[existingIdx] = { name, value, domain, path, fromStep: step };
      } else {
        this.cookies.push({ name, value, domain, path, fromStep: step });
        newOnes.push(name);
      }
    }

    if (setCookies.length > 0) {
      this.history.push({ step, setCookies });
    }
    return newOnes;
  }

  get header(): string {
    return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  get names(): string[] {
    return this.cookies.map(c => c.name);
  }

  has(name: string): boolean {
    return this.cookies.some(c => c.name === name);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e.name === 'AbortError') throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 跟随重定向链，每步都吸收 cookie
async function followChain(
  startUrl: string,
  jar: DebugCookieJar,
  stepName: string,
  method = 'GET',
  extraHeaders: Record<string, string> = {},
  body?: string,
): Promise<{ finalUrl: string; finalStatus: number; body: string }> {
  let url = startUrl;
  for (let i = 0; i < 10; i++) {
    const res = await fetchWithTimeout(url, {
      method,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: jar.header,
        Referer: url,
        ...extraHeaders,
      },
      body,
    }, 10_000);

    const hopName = i === 0 ? stepName : `${stepName} (hop ${i + 1})`;
    const newOnes = jar.absorb(res, url, hopName);
    if (newOnes.length > 0) {
      console.log(`  🍪 ${hopName} 新增 cookie: ${newOnes.join(', ')}`);
    }

    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return { finalUrl: url, finalStatus: res.status, body: await res.text() };
  }
  throw new Error('重定向次数超限');
}

async function main() {
  const username = process.env.CAS_USERNAME;
  const password = process.env.CAS_PASSWORD;
  const serviceUrl = process.env.CAS_SERVICE ?? CAS_SERVICE_URL;

  if (!username || !password) {
    console.error('❌ 缺少 CAS_USERNAME 或 CAS_PASSWORD');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('🍪 Cookie 来源追踪');
  console.log('='.repeat(60));
  console.log('');

  const jar = new DebugCookieJar();

  // ---- 步骤 1：CAS 登录（用 casLogin 走标准流程，但用我们的 jar 吸收）----
  console.log('步骤 1：CAS 登录...');
  const loginResult = await casLogin({ username, password, serviceUrl });
  // 把 casLogin 拿到的 cookie 灌进我们的 jar
  for (const [name, value] of Object.entries(loginResult.cookies)) {
    jar.cookies.push({
      name, value,
      domain: 'hdu.huitu.zhishulib.com',
      path: '/',
      fromStep: 'CAS 登录（casLogin）',
    });
  }
  console.log(`  登录后 cookie 列表: ${jar.names.join(', ')}`);
  console.log(`  api_access_token: ${jar.has('api_access_token') ? '✅ 有' : '❌ 无'}`);
  console.log('');

  // ---- 步骤 2：访问座位分类页（用户登录后第一页）----
  console.log('步骤 2：访问座位分类列表页 /Space/Category/list...');
  const page2 = await followChain(
    `${LIBRARY_BASE}/Space/Category/list?category_id=591`,
    jar,
    '座位分类列表页',
  );
  console.log(`  最终 URL: ${page2.finalUrl}`);
  console.log(`  状态: ${page2.finalStatus}`);
  console.log(`  当前 cookie: ${jar.names.join(', ')}`);
  console.log(`  api_access_token: ${jar.has('api_access_token') ? '✅ 有' : '❌ 无'}`);
  console.log('');

  // ---- 步骤 3：访问座位主页 /Seat/Index/index ----
  console.log('步骤 3：访问座位主页 /Seat/Index/index...');
  const page3 = await followChain(
    `${LIBRARY_BASE}/Seat/Index/index`,
    jar,
    '座位主页',
  );
  console.log(`  状态: ${page3.finalStatus}`);
  console.log(`  当前 cookie: ${jar.names.join(', ')}`);
  console.log(`  api_access_token: ${jar.has('api_access_token') ? '✅ 有' : '❌ 无'}`);
  // 检查页面 HTML 中是否有 JS 设置 api_access_token
  if (page3.body.includes('api_access_token')) {
    const idx = page3.body.indexOf('api_access_token');
    console.log(`  🔍 页面 HTML 中含 'api_access_token'！上下文:`);
    console.log(`     ${page3.body.slice(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, ' ')}`);
  }
  console.log('');

  // ---- 步骤 4：访问 searchSeats 接口（POST form）----
  console.log('步骤 4：调用 searchSeats 接口...');
  const searchBody = new URLSearchParams({
    beginTime: Math.floor(Date.now() / 1000).toString(),
    duration: '3600',
    num: '1',
    'space_category[category_id]': '591',
    'space_category[content_id]': '3',
  }).toString();

  const page4 = await followChain(
    `${LIBRARY_BASE}/Seat/Index/searchSeats?LAB_JSON=1`,
    jar,
    'searchSeats 接口',
    'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    searchBody,
  );
  console.log(`  状态: ${page4.finalStatus}`);
  console.log(`  当前 cookie: ${jar.names.join(', ')}`);
  console.log(`  api_access_token: ${jar.has('api_access_token') ? '✅ 有' : '❌ 无'}`);

  // 检查响应 JSON 中是否有 token 字段
  if (page4.body.includes('token') || page4.body.includes('access_token')) {
    try {
      const json = JSON.parse(page4.body);
      const walk = (o: any, path: string): string[] => {
        if (!o || typeof o !== 'object') return [];
        const hits: string[] = [];
        for (const k of Object.keys(o)) {
          const cur = path ? `${path}.${k}` : k;
          if (/token/i.test(k)) hits.push(`${cur}=${JSON.stringify(o[k]).slice(0, 80)}`);
          if (typeof o[k] === 'object') hits.push(...walk(o[k], cur));
        }
        return hits;
      };
      const tokenFields = walk(json, '');
      if (tokenFields.length > 0) {
        console.log(`  🔍 响应中含 token 字段:`);
        for (const t of tokenFields) console.log(`     ${t}`);
      }
    } catch { /* not json */ }
  }
  console.log('');

  // ---- 步骤 5：再试一次 appointMessages 接口（带上所有 cookie）----
  console.log('步骤 5：再次尝试 appointMessages 接口...');
  const tryUrls = [
    '/Seat/Index/appointMessages?LAB_JSON=1',
    '/Seat/Index/appointMessages',
  ];
  for (const path of tryUrls) {
    console.log(`  尝试 ${path} ...`);
    const res = await fetchWithTimeout(`${LIBRARY_BASE}${path}`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: jar.header,
        Accept: 'application/json, text/plain, */*',
        Referer: `${LIBRARY_BASE}/Seat/Index/index`,
      },
    }, 10_000);
    const text = await res.text();
    console.log(`    状态: ${res.status} | 长度: ${text.length}B`);
    console.log(`    内容片段: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    try {
      JSON.parse(text);
      console.log(`    ✅ 是 JSON！`);
      console.log(`    ${JSON.stringify(JSON.parse(text), null, 2).slice(0, 1500)}`);
    } catch { /* not json */ }
  }
  console.log('');

  // ---- 汇总 ----
  console.log('='.repeat(60));
  console.log('📋 最终 Cookie 清单');
  console.log('='.repeat(60));
  for (const c of jar.cookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 30)}${c.value.length > 30 ? '...' : ''}  [来自: ${c.fromStep}]`);
  }
  console.log('');
  console.log(`api_access_token: ${jar.has('api_access_token') ? '✅ 已找到' : '❌ 不存在于 Set-Cookie 中（可能是 JS 写入）'}`);
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
