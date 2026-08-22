/**
 * bookSeats 返回的错误码分类
 * 第三方接口没有标准错误码，只有 is_login + result + 文案，需要自己做一层分类
 */
export enum BookErrorCode {
  /** 座位已被占用 → 可重试（换座位） */
  SEAT_TAKEN = 'SEAT_TAKEN',
  /** 用户被拉黑 → 不可重试 */
  BLACKLISTED = 'BLACKLISTED',
  /** 登录态失效 → 不可重试，需触发 SessionManager 重新登录 */
  NOT_LOGIN = 'NOT_LOGIN',
  /** 请求超时/网络异常 → 可重试 */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** 操作过于频繁被限流 → 可重试（等冷却后再试） */
  RATE_LIMIT = 'RATE_LIMIT',
  /** 超出可预约座位时间范围（还没到放号时间点）→ 可重试且可缩短间隔 */
  WINDOW_NOT_OPEN = 'WINDOW_NOT_OPEN',
  /** 未知错误 → 保守起见不重试，记日志人工看 */
  UNKNOWN = 'UNKNOWN',
}