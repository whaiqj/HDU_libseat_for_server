import {
  AppointMessageType,
  MessageLevel,
} from '../hdu-library/dto/appoint-messages.dto';

/** 消息分类结果 */
export interface ClassifiedMessage {
  type: AppointMessageType;
  level: MessageLevel;
  emoji: string;
}

/**
 * 标题 → 类型 / 级别 / 表情 集中映射表
 * 仅包含已抓包验证的标题；未命中映射的标题降级为普通其他提醒，保证零漏消息
 */
const TITLE_CLASSIFICATION_MAP: Record<string, ClassifiedMessage> = {
  '签到提醒': {
    type: AppointMessageType.CHECKIN_REMINDER,
    level: MessageLevel.NORMAL,
    emoji: '🔔',
  },
  '签到提醒（二次提醒）': {
    type: AppointMessageType.CHECKIN_SECOND_REMINDER,
    level: MessageLevel.URGENT,
    emoji: '⏰',
  },
  '超时未签到': {
    type: AppointMessageType.CHECKIN_OVERDUE,
    level: MessageLevel.ALERT,
    emoji: '⚠️',
  },
};

/** 未识别标题的降级分类：普通其他提醒，不丢弃 */
const UNKNOWN_CLASSIFICATION: ClassifiedMessage = {
  type: AppointMessageType.OTHER,
  level: MessageLevel.NORMAL,
  emoji: '📨',
};

/** 按标题分类消息；未知标题统一降级为普通其他提醒 */
export function classifyMessageByTitle(title: string): ClassifiedMessage {
  return TITLE_CLASSIFICATION_MAP[title] ?? UNKNOWN_CLASSIFICATION;
}
