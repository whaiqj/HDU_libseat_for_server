/**
 * 放号时间窗口工具
 * 提供时区安全的时间戳计算，支撑抢座调度的时间精度需求
 */

/**
 * 方案1：本地时区为东八区时，直接计算当日 20:00 时间戳（秒）
 * 适用于服务器部署在东八区的场景
 */
export function getTonight8PM(): number {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    20,
    0,
    0,
  );
  return Math.floor(target.getTime() / 1000);
}

/**
 * 方案2：跨时区兼容版，基于 UTC 强制换算北京时间
 * 无论服务器部署在哪个时区，都能正确计算北京时间指定时刻的时间戳
 *
 * @param y 年份（如 2026）
 * @param m 月份（1-12）
 * @param d 日期（1-31）
 * @param h 小时（0-23，北京时间）
 * @param min 分钟（0-59）
 * @param s 秒（0-59）
 * @returns Unix 时间戳（秒）
 */
export function toBeijingTimestamp(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  s: number,
): number {
  // 北京时间 = UTC+8，所以 UTC 时间 = 北京时间 - 8 小时
  const utcMs = Date.UTC(y, m - 1, d, h - 8, min, s);
  return Math.floor(utcMs / 1000);
}

/**
 * 判断给定时间戳是否在有效窗口内
 * 用于抢座重试循环中判断是否超出时间窗口上限
 *
 * @param timestamp 当前时间戳（毫秒）
 * @param windowMs 窗口时长（毫秒）
 * @returns true 表示仍在窗口内
 */
export function isWithinWindow(
  timestamp: number,
  windowMs: number,
): boolean {
  return Date.now() - timestamp < windowMs;
}