// 默认空串 = 同源相对路径（容器内走 nginx 反代，本地 dev 走 vite proxy）
// 远程部署时可设 VITE_API_BASE_URL 指定完整后端地址
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

/** 后端 GET /accounts 返回的账号项（密码字段永不返回） */
export interface Account {
  id: string;
  username: string;
  status: "active" | "login_failed";
  lastLoginAt: string | null;
  sessionMeta: {
    isLogin?: boolean;
    lastCheckAt?: string;
    error?: string;
    [key: string]: unknown;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAccounts(): Promise<Account[]> {
  const res = await fetch(`${BASE_URL}/accounts`);
  if (!res.ok) throw new Error(`查询账号失败: ${res.status}`);
  return res.json();
}

export async function addAccount(
  username: string,
  password: string,
): Promise<Account> {
  const res = await fetch(`${BASE_URL}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `添加账号失败: ${res.status}`);
  }
  return res.json();
}

export async function refreshAccount(id: string): Promise<Account> {
  const res = await fetch(`${BASE_URL}/accounts/${id}/refresh`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `刷新登录失败: ${res.status}`);
  }
  return res.json();
}

export async function removeAccount(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/accounts/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `删除账号失败: ${res.status}`);
  }
}
