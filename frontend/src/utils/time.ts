export function toBeijingTimestamp(
  y: number, m: number, d: number, h: number, min = 0, s = 0
): number {
  // 北京时间 = UTC+8，所以 UTC 时刻 = 北京时间 - 8h
  return Math.floor(Date.UTC(y, m - 1, d, h - 8, min, s) / 1000);
}
