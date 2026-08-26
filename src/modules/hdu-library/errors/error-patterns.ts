import { ErrorCategory } from './error-category.enum';

/**
 * 错误分类关键词匹配模式
 * 图书馆系统只返回文本提示，不能指望有稳定的错误码
 * ⚠️ 关键词匹配目前是根据已抓到的报错样本推测，不是完整枚举
 * 正式接入前建议手动触发失败场景，收集真实错误文案再补全
 */
export const ERROR_PATTERNS: Record<ErrorCategory, RegExp[]> = {
  [ErrorCategory.BLACKLIST]: [/黑名单/, /暂时无法预约/],
  [ErrorCategory.SEAT_UNAVAILABLE]: [/座位已被预约/, /座位不可用/, /已被占用/],
  [ErrorCategory.SESSION_EXPIRED]: [/未登录/, /登录已过期/, /login/i],
  // 注意：WINDOW_NOT_OPEN 必须写在 BUSINESS_RULE 前面，Object.entries() 按插入顺序遍历
  [ErrorCategory.WINDOW_NOT_OPEN]: [/^超出可预约座位时间范围$/],
  [ErrorCategory.BUSINESS_RULE]: [/超出.*预约上限/, /不在开放时间/, /时长超限/],
  // 网络层/参数错误不靠文本匹配，靠 HTTP 状态码或异常类型判断
  [ErrorCategory.NETWORK]: [],
  // 请求过快被限流：单独分流，与 UNKNOWN 区分开，避免占用 UNKNOWN 的保守重试上限
  // 注意："请求太频繁了，请稍后再试" 是 8/22、8/23 放号实测文案，此前漏配导致
  // 限流被误判为 UNKNOWN、2 次就终止任务（8/23 三任务 3 发全灭的根因）。
  // 只匹配具体的"频繁"文案，不能只匹配"请稍后再试"——"系统繁忙，请稍后再试"是 UNKNOWN
  [ErrorCategory.RATE_LIMIT]: [/操作过于频繁/, /请求过于频繁/, /操作太频繁/, /请求太频繁/],
  [ErrorCategory.PARAM_INVALID]: [/您必须在预约人列表中/],
  [ErrorCategory.UNKNOWN]: [],
};