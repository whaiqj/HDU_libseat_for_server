/**
 * 预约消息接口 DTO
 * 接口：GET /Station/Station/lists/type/appointMessages?LAB_JSON=1
 * 响应结构：{ content: { defaultItems: [{ time, title, desc, url }] } }
 */

/** 消息分级（决定推送模板级别） */
export enum MessageLevel {
  /** 普通提醒 */
  NORMAL = 'normal',
  /** 加急提醒 */
  URGENT = 'urgent',
  /** 重要警告 */
  ALERT = 'alert',
}

/**
 * 预约消息类型
 * 仅包含已抓包验证的标题；未识别标题统一降级为 OTHER，不丢弃
 */
export enum AppointMessageType {
  /** 签到提醒（普通） */
  CHECKIN_REMINDER = 'checkin_reminder',
  /** 签到提醒（二次提醒） */
  CHECKIN_SECOND_REMINDER = 'checkin_second_reminder',
  /** 超时未签到（违约） */
  CHECKIN_OVERDUE = 'checkin_overdue',
  /** 其他 / 未识别（降级为普通提醒） */
  OTHER = 'other',
}

/** 单条预约消息（标准化后） */
export interface AppointmentMessageItem {
  /** 消息时间（原始字符串） */
  time: string;
  /** 消息标题 */
  title: string;
  /** 消息描述 */
  desc: string;
  /** 消息跳转链接 */
  url: string;
  /** 从 url 提取的预约 id；无法提取时为 null（入库时使用占位符） */
  bookingId: string | null;
}
