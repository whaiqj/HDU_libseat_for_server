/**
 * 签到消息接口验证 — 最终确认版
 *
 * 抓包确认的真实接口：
 *   GET /Station/Station/lists/type/appointMessages?LAB_JSON=1
 *
 * 运行方式：
 *   npx tsx scripts/verify-appoint-messages.ts
 *
 * 需要在 .env 中配置 CAS_USERNAME / CAS_PASSWORD
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 加载 .env ----
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

// 抓包确认的真实路径
const APPOINT_MESSAGES_PATH = '/Station/Station/lists/type/appointMessages';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- 类型定义 ----
interface AppointmentMessage {
  time: string;
  title: string;
  desc: string;
  url: string;
  [key: string]: any;
}

// ---- 工具函数 ----
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extractBookingId(url: string): string | null {
  const match = url.match(/bookingId=([^&]+)/);
  return match ? match[1] : null;
}

function classifyTitle(title: string): string {
  if (title === '签到提醒') return '普通提醒';
  if (title === '签到提醒（二次提醒）') return '二次提醒（加急）';
  if (title === '超时未签到') return '超时未签到（违约）';
  return '其他 / 未识别';
}

// ---- 主流程 ----
async function main() {
  const username = process.env.CAS_USERNAME;
  const password = process.env.CAS_PASSWORD;
  const serviceUrl = process.env.CAS_SERVICE ?? CAS_SERVICE_URL;

  if (!username || !password) {
    console.error('❌ 缺少 CAS_USERNAME 或 CAS_PASSWORD 环境变量');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('📋 签到消息接口验证');
  console.log('='.repeat(60));
  console.log(`账号: ${username}`);
  console.log(`接口: GET ${LIBRARY_BASE}${APPOINT_MESSAGES_PATH}?LAB_JSON=1`);
  console.log('');

  // 1. CAS 登录
  console.log('🔐 步骤 1/3：CAS 登录...');
  const loginResult = await casLogin({ username, password, serviceUrl });
  const cookieHeader = Object.entries(loginResult.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  console.log(`✅ 登录成功，Cookie: ${Object.keys(loginResult.cookies).join(', ')}`);
  console.log('');

  // 2. 请求 appointMessages
  const fullUrl = `${LIBRARY_BASE}${APPOINT_MESSAGES_PATH}?LAB_JSON=1`;
  console.log('📡 步骤 2/3：请求接口...');
  console.log(`   GET ${fullUrl}`);

  let raw: any;
  try {
    const res = await fetchWithTimeout(
      fullUrl,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Cookie: cookieHeader,
          Accept: 'application/json, text/plain, */*',
          Referer: `${LIBRARY_BASE}/Seat/Index/index`,
        },
      },
      15_000,
    );

    console.log(`   HTTP 状态: ${res.status}`);
    console.log(`   Content-Type: ${res.headers.get('content-type') ?? '无'}`);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      console.log(`⚠️  重定向到: ${loc}`);
      console.log('   可能会话已失效，请检查登录状态');
      process.exit(1);
    }

    const text = await res.text();
    console.log(`   响应大小: ${text.length} 字节`);
    console.log('');

    try {
      raw = JSON.parse(text);
    } catch (e) {
      console.log('❌ 响应不是 JSON');
      console.log('── 响应体前 1000 字符 ──');
      console.log(text.slice(0, 1000));
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`❌ 请求失败: ${e.message}`);
    process.exit(1);
  }

  // 3. 解析验证
  console.log('🔍 步骤 3/3：解析验证...');
  console.log('');

  // 顶层结构
  console.log('── 顶层字段 ──');
  console.log(Object.keys(raw).join(', '));
  console.log('');

  const content = raw?.content;
  if (!content) {
    console.log('❌ 响应中没有 content 字段');
    console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
    process.exit(1);
  }

  console.log('── content 字段 ──');
  const contentKeys = Object.keys(content);
  console.log(contentKeys.join(', '));
  console.log('');

  // 找消息列表
  const items: AppointmentMessage[] =
    content?.defaultItems ??
    content?.items ??
    content?.list ??
    content?.data ??
    [];

  if (!Array.isArray(items) || items.length === 0) {
    console.log('⚠️  消息列表为空（defaultItems / items / list / data 都没有数组）');
    console.log('');
    console.log('── content 完整结构 ──');
    console.log(JSON.stringify(content, null, 2).slice(0, 3000));
    console.log('');
    console.log('💡 当前账号可能没有预约消息，属于正常情况');
    console.log('   有活跃预约后再跑一次即可拿到真实样本');
    process.exit(0);
  }

  console.log(`✅ 找到 ${items.length} 条消息`);
  console.log('');

  // 逐条打印
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const bookingId = extractBookingId(item.url);
    const category = classifyTitle(item.title);

    console.log(`── 消息 #${i + 1} ──`);
    console.log(`  标题:       ${item.title}`);
    console.log(`  分类:       ${category}`);
    console.log(`  时间:       ${item.time}`);
    console.log(`  描述:       ${item.desc}`);
    console.log(`  URL:        ${item.url}`);
    console.log(`  bookingId:  ${bookingId ?? '❌ 未解析到'}`);

    const extraKeys = Object.keys(item).filter(
      (k) => !['title', 'time', 'desc', 'url'].includes(k),
    );
    if (extraKeys.length > 0) {
      console.log(`  额外字段:   ${extraKeys.join(', ')}`);
      for (const k of extraKeys) {
        const v = typeof item[k] === 'object' ? JSON.stringify(item[k]) : item[k];
        console.log(`    ${k}: ${String(v).slice(0, 100)}`);
      }
    }
    console.log('');
  }

  // 去重键验证
  console.log('── 去重键验证 (bookingId + title) ──');
  const dedup = new Set<string>();
  let dupCount = 0;
  for (const item of items) {
    const bookingId = extractBookingId(item.url) ?? 'unknown';
    const key = `${bookingId}::${item.title}`;
    if (dedup.has(key)) dupCount++;
    dedup.add(key);
  }
  console.log(`  去重后: ${dedup.size} / ${items.length}（重复 ${dupCount} 条）`);
  console.log('');

  // 三类消息覆盖
  console.log('── 三类签到消息覆盖 ──');
  const hasNormal = items.some((i) => i.title === '签到提醒');
  const hasUrgent = items.some((i) => i.title === '签到提醒（二次提醒）');
  const hasOverdue = items.some((i) => i.title === '超时未签到');
  console.log(`  签到提醒（普通）:       ${hasNormal ? '✅' : '❌'}`);
  console.log(`  签到提醒（二次提醒）:   ${hasUrgent ? '✅' : '❌'}`);
  console.log(`  超时未签到:             ${hasOverdue ? '✅' : '❌'}`);
  console.log('');

  // 翻页信息
  if (content.enableLoadMore !== undefined) {
    console.log(`── 翻页: enableLoadMore = ${content.enableLoadMore} ──`);
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('✅ 验证完成');
  console.log('='.repeat(60));
}

main().catch((e) => {
  console.error('未预期错误:', e);
  process.exit(1);
});
