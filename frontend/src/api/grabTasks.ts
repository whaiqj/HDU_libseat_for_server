// 默认空串 = 同源相对路径（容器内走 nginx 反代，本地 dev 走 vite proxy）
// 远程部署时可设 VITE_API_BASE_URL 指定完整后端地址
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface CreateGrabTaskPayload {
  accountId: string;
  roomId: string;
  /** 自习室名称（展示用，通知推送中使用） */
  roomName: string;
  beginTime: number;
  duration: number;
  seatPreference: string[];
  strictMode: boolean;
  triggerAt: number;
}

export async function createGrabTask(payload: CreateGrabTaskPayload) {
  const res = await fetch(`${BASE_URL}/grab-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`创建任务失败: ${res.status}`);
  return res.json(); // { id, status, ... }
}

export interface GrabTaskStatus {
  id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  attempts: number;
  result: {
    seatId?: string;
    seatTitle?: string;
    reason?: string;
    /** 运行中已被他人占用的座位（实时提醒） */
    takenSeats?: string[];
  } | null;
}

export async function getGrabTask(id: string): Promise<GrabTaskStatus> {
  const res = await fetch(`${BASE_URL}/grab-tasks/${id}`);
  if (!res.ok) throw new Error(`查询任务失败: ${res.status}`);
  return res.json();
}

/**
 * 查询指定账号下的所有抢座任务
 */
export async function listGrabTasks(accountId: string): Promise<GrabTaskStatus[]> {
  const res = await fetch(`${BASE_URL}/grab-tasks?accountId=${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`查询任务列表失败: ${res.status}`);
  return res.json();
}

/**
 * 终止抢座任务（pending 阶段取消排队 / running 阶段中途停止）
 */
export async function cancelGrabTask(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/grab-tasks/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`终止任务失败: ${res.status}`);
}
