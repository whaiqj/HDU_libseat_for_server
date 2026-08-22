/**
 * 错误分类枚举
 * 按"能不能重试"分类，再按"怎么识别"落地成代码
 */
export enum ErrorCategory {
  /** 超时、连接失败、DNS 异常、5xx */
  NETWORK = 'network',
  /** 请求过快被限制、返回异常慢 */
  RATE_LIMIT = 'rate_limit',
  /** 未登录 / Token 过期（is_login: false） */
  SESSION_EXPIRED = 'session_expired',
  /** 黑名单、账号被限制、违规封禁 */
  BLACKLIST = 'blacklist',
  /** 座位已被占用、座位不存在、座位已锁定 */
  SEAT_UNAVAILABLE = 'seat_unavailable',
  /** 超出每日预约上限、时间段已关闭、预约时长超限 */
  BUSINESS_RULE = 'business_rule',
  /** 超出可预约座位时间范围（还没到放号时间点）—— 可重试且可缩短间隔 */
  WINDOW_NOT_OPEN = 'window_not_open',
  /** beginTime/category_id 格式或取值错误 */
  PARAM_INVALID = 'param_invalid',
  /** Response 结构异常、新的未见过的错误文案 */
  UNKNOWN = 'unknown',
}