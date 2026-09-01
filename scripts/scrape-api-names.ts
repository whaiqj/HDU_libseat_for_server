/**
 * 从图书馆页面的 JS 中扒出真实的消息接口名
 *
 * 思路：下载座位主页 HTML -> 提取所有 JS 文件 URL -> 下载并搜索 appoint/message/msg 相关关键词
 *
 * 运行方式：npx tsx scripts/scrape-api-names.ts
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

const LIBRARY_BASE = process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class CookieJar {
  private jar = new Map<string, string>();
  absorb(res: Response): void {
    const setCookies = (res.headers as any).getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  get header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  setFromObject(obj: Record<string, string>): void {
    for (const [k, v] of Object.entries(obj)) this.jar.set(k, v);
  }
}

async function fetchText(url: string, jar: CookieJar, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Cookie: jar.header,
      Referer: referer ?? LIBRARY_BASE,
    },
    redirect: 'follow',
  });
  return res.text();
}

// 在文本中搜索所有可能的接口路径（形如 /Seat/Index/xxx 或 /Xxx/Index/xxx）
function findApiPaths(js: string, keywords: string[]): string[] {
  const found = new Set<string>();
  // 匹配 /Module/Controller/action 形式的路径
  const pathRegex = /\/[A-Z][a-zA-Z]+\/(Index\/)?[a-zA-Z]+/g;
  let m;
  while ((m = pathRegex.exec(js)) !== null) {
    const path = m[0];
    // 过滤掉常见的非 API 路径
    if (path.includes('.css') || path.includes('.png') || path.includes('.jpg') || path.includes('.gif')) continue;
    for (const kw of keywords) {
      if (path.toLowerCase().includes(kw.toLowerCase())) {
        found.add(path);
        break;
      }
    }
  }
  // 也搜带引号的字符串
  const strRegex = /['"]([^'"]*(?:appoint|message|msg|notice|notify)[^'"]*)['"]/gi;
  while ((m = strRegex.exec(js)) !== null) {
    const str = m[1];
    if (str.length < 100) found.add(str);
  }
  return [...found].sort();
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
  console.log('🔍 从页面 JS 中扒消息接口名');
  console.log('='.repeat(60));
  console.log('');

  const jar = new CookieJar();

  // 1. CAS 登录
  console.log('🔐 步骤 1：CAS 登录...');
  const loginResult = await casLogin({ username, password, serviceUrl });
  jar.setFromObject(loginResult.cookies);
  console.log('✅ 登录成功');
  console.log('');

  // 2. searchSeats 预热
  console.log('🔥 步骤 2：searchSeats 预热...');
  const warmupRes = await fetch(
    `${LIBRARY_BASE}/Seat/Index/searchSeats?LAB_JSON=1`,
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Cookie: jar.header,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${LIBRARY_BASE}/Seat/Index/index`,
      },
      body: new URLSearchParams({
        beginTime: Math.floor(Date.now() / 1000).toString(),
        duration: '3600',
        num: '1',
        'space_category[category_id]': '591',
        'space_category[content_id]': '3',
      }).toString(),
    },
  );
  jar.absorb(warmupRes);
  console.log('✅ 预热完成');
  console.log('');

  // 3. 下载座位主页 HTML
  console.log('📄 步骤 3：下载座位主页 HTML...');
  const seatPageHtml = await fetchText(
    `${LIBRARY_BASE}/Seat/Index/index`,
    jar,
    `${LIBRARY_BASE}/Space/Category/list?category_id=591`,
  );
  console.log(`   页面大小: ${seatPageHtml.length}B`);

  // 提取所有 script src
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  const jsUrls: string[] = [];
  let sm;
  while ((sm = scriptRegex.exec(seatPageHtml)) !== null) {
    let src = sm[1];
    if (src.startsWith('//')) src = 'https:' + src;
    else if (src.startsWith('/')) src = LIBRARY_BASE + src;
    else if (!src.startsWith('http')) src = `${LIBRARY_BASE}/Seat/Index/${src}`;
    jsUrls.push(src);
  }
  console.log(`   找到 ${jsUrls.length} 个 JS 文件`);
  for (const u of jsUrls) console.log(`     ${u}`);
  console.log('');

  // 4. 下载每个 JS 文件，搜索消息相关关键词
  const keywords = ['appoint', 'message', 'msg', 'notice', 'notify', 'sign', 'check'];
  const allFound: { file: string; paths: string[] }[] = [];

  console.log('🔎 步骤 4：扫描 JS 文件中的接口路径...');
  console.log('');

  for (const jsUrl of jsUrls) {
    try {
      const js = await fetchText(jsUrl, jar, `${LIBRARY_BASE}/Seat/Index/index`);
      const paths = findApiPaths(js, keywords);
      if (paths.length > 0) {
        const fileName = jsUrl.split('/').pop() ?? jsUrl;
        console.log(`📁 ${fileName} (${(js.length / 1024).toFixed(1)}KB)`);
        for (const p of paths) {
          console.log(`   → ${p}`);
        }
        console.log('');
        allFound.push({ file: fileName, paths });
      } else {
        console.log(`⏭️  ${jsUrl.split('/').pop()} - 无匹配`);
      }
    } catch (e: any) {
      console.log(`❌ ${jsUrl.split('/').pop()} - 下载失败: ${e.message}`);
    }
  }

  // 5. 也直接搜页面 HTML 里的关键词
  console.log('');
  console.log('🔎 步骤 5：扫描页面 HTML 中的消息相关字符串...');
  const htmlStrings: string[] = [];
  const htmlStrRegex = /['"]([^'"]*(?:appointMessages|messageList|signIn|checkIn|qiandao)[^'"]*)['"]/gi;
  while ((sm = htmlStrRegex.exec(seatPageHtml)) !== null) {
    htmlStrings.push(sm[1]);
  }
  if (htmlStrings.length > 0) {
    for (const s of htmlStrings) console.log(`  → ${s}`);
  } else {
    console.log('  无匹配');
  }

  // 6. 汇总所有找到的候选路径，去重
  console.log('');
  console.log('='.repeat(60));
  console.log('📋 所有候选接口路径');
  console.log('='.repeat(60));
  const allPaths = new Set<string>();
  for (const item of allFound) {
    for (const p of item.paths) allPaths.add(p);
  }
  for (const p of [...allPaths].sort()) console.log(`  ${p}`);
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
