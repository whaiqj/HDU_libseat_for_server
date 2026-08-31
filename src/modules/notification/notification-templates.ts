import { GrabTask } from '../grab-task/entities/grab-task.entity';
import type { NotificationMeta } from './notification.service';

/**
 * 通知模板渲染所需的统一数据。
 * 5 个模板函数只做纯字符串拼接，不做任何 IO / 网络 / 异常处理。
 */
export interface NotificationTemplateData {
  taskId: string;
  accountUsername: string;
  room: string;
  date: string;
  timeStart: string;
  timeEnd: string;
  seatId?: string;
  retryRound?: number;
  failReason?: string;
}

// 北京时间 = UTC+8，中国无夏令时，直接偏移 8 小时后用 UTC getter 读取
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(tsSec: number): string {
  const d = new Date(tsSec * 1000 + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatTime(tsSec: number): string {
  const d = new Date(tsSec * 1000 + BEIJING_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 从 GrabTask 派生通知模板所需的房间 / 日期 / 时间段上下文。
 * 房间以 task.roomName 为准；未锁定房间时回退到空间分类 ID。
 */
export function buildTaskMeta(
  task: Pick<GrabTask, 'beginTime' | 'duration' | 'roomName' | 'categoryId'>,
): NotificationMeta {
  const begin = Number(task.beginTime) || 0;
  const end = begin + (Number(task.duration) || 0);
  return {
    room: task.roomName ?? `分类 ${task.categoryId}`,
    date: formatDate(begin),
    timeStart: formatTime(begin),
    timeEnd: formatTime(end),
  };
}

/** 放号前 5 分钟提醒：含账号 / 房间 / 时间段 */
export function buildPreReminderMessage(d: NotificationTemplateData): string {
  return [
    '## ⏰ 放号前 5 分钟提醒',
    '',
    `- **账号**：${d.accountUsername}`,
    `- **房间**：${d.room}`,
    `- **时间**：${d.date} ${d.timeStart} - ${d.timeEnd}`,
    '',
    '> 系统即将开始自动抢座，请留意后续推送。',
  ].join('\n');
}

/** 任务开始执行：含账号 / 房间 / 时间段 */
export function buildTaskStartedMessage(d: NotificationTemplateData): string {
  return [
    '## 🚀 任务开始执行',
    '',
    `- **任务 ID**：${d.taskId}`,
    `- **账号**：${d.accountUsername}`,
    `- **房间**：${d.room}`,
    `- **时间**：${d.date} ${d.timeStart} - ${d.timeEnd}`,
  ].join('\n');
}

/** 座位被占（换座重试时）：含座位号 + 当前重试轮次 */
export function buildSeatTakenMessage(d: NotificationTemplateData): string {
  return [
    '## 🔁 座位被占，正在换座重试',
    '',
    `- **账号**：${d.accountUsername}`,
    `- **被占座位**：${d.seatId ?? '未知'}`,
    `- **重试轮次**：第 ${d.retryRound ?? '-'} 轮`,
  ].join('\n');
}

/** 抢座成功：含最终座位号 + 完整时间 / 账号 / 房间 */
export function buildSuccessMessage(d: NotificationTemplateData): string {
  return [
    '## ✅ 抢座成功',
    '',
    `- **账号**：${d.accountUsername}`,
    `- **房间**：${d.room}`,
    `- **时间**：${d.date} ${d.timeStart} - ${d.timeEnd}`,
    `- **座位**：${d.seatId ?? '未知'}`,
  ].join('\n');
}

/** 抢座失败：含失败原因 */
export function buildFailedMessage(d: NotificationTemplateData): string {
  return [
    '## ❌ 抢座失败',
    '',
    `- **账号**：${d.accountUsername}`,
    `- **房间**：${d.room}`,
    `- **时间**：${d.date} ${d.timeStart} - ${d.timeEnd}`,
    `- **失败原因**：${d.failReason ?? '未知原因'}`,
  ].join('\n');
}
