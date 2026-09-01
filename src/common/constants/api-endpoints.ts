/**
 * 图书馆第三方 API 端点集中管理
 * 路径已按阶段 7 抓包/实测确认（含 LAB_JSON=1 查询参数）
 */
export const LIBRARY_API = {
  /** 查询可用座位 */
  SEARCH_SEATS: '/Seat/Index/searchSeats?LAB_JSON=1',
  /** 提交预约 */
  BOOK_SEATS: '/Seat/Index/bookSeats?LAB_JSON=1',
  /** 预约消息列表（签到提醒 / 二次提醒 / 超时未签到等全量消息） */
  APPOINT_MESSAGES: '/Station/Station/lists/type/appointMessages?LAB_JSON=1',
} as const;
