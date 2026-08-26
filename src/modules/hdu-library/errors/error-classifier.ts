import { ErrorCategory } from './error-category.enum';
import { ERROR_PATTERNS } from './error-patterns';

/**
 * 判断是否为网络超时或连接异常
 */
function isTimeoutOrNetworkError(exception: Error): boolean {
  const message = exception.message?.toLowerCase() ?? '';
  return (
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('aborted')
  );
}

/**
 * 分类第三方返回的错误
 * 先按"能不能重试"分类，再按"怎么识别"落地成代码
 *
 * @param response 第三方接口返回的原始响应体
 * @param exception 网络请求异常（如有）
 * @returns 错误分类
 */
export function classifyError(
  response: any,
  exception?: Error,
): ErrorCategory {
  // 网络异常优先判断
  if (exception) {
    if (isTimeoutOrNetworkError(exception)) {
      return ErrorCategory.NETWORK;
    }
  }

  // 登录态失效：is_login=false（可能在顶层或 DATA 内，视接口而定）
  if (response?.is_login === false || response?.DATA?.is_login === false) {
    return ErrorCategory.SESSION_EXPIRED;
  }

  // 文本匹配：兼容旧字段 msg 与真实字段 MESSAGE（具体文案优先于通用错误码）
  const msg: string = response?.msg ?? response?.MESSAGE ?? '';

  for (const [category, patterns] of Object.entries(ERROR_PATTERNS)) {
    if (patterns.some((p) => p.test(msg))) {
      return category as ErrorCategory;
    }
  }

  // 参数错误兜底：CODE 明确为 ParamError 等，且文案未命中更具体的分类
  const code: string = response?.CODE ?? '';
  if (code && /paramerror/i.test(code)) {
    return ErrorCategory.PARAM_INVALID;
  }

  // 兜底：绝不能崩溃
  return ErrorCategory.UNKNOWN;
}

/**
 * 可重试的错误分类集合
 * UNKNOWN 也纳入可重试：由重试循环降级为保守低频节奏（见 RETRY_CONFIG.unknownDegradeThreshold），
 * 不作为终止条件 —— 未知文案误杀任务的代价高于低频多试
 */
export const RETRYABLE: Set<ErrorCategory> = new Set([
  ErrorCategory.NETWORK,
  ErrorCategory.RATE_LIMIT,
  ErrorCategory.SEAT_UNAVAILABLE,
  ErrorCategory.SESSION_EXPIRED,
  ErrorCategory.WINDOW_NOT_OPEN,
  ErrorCategory.UNKNOWN, // 有限次数的保守重试
]);

/**
 * 判断给定错误分类是否可重试
 */
export function isRetryable(category: ErrorCategory): boolean {
  return RETRYABLE.has(category);
}
