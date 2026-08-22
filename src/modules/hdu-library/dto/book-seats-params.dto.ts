/**
 * bookSeats 接口请求参数
 * 对应阶段 7 实测确认字段（is_recommend / api_time 为下划线风格）
 */
export class BookSeatsParams {
  /** Unix 时间戳 */
  beginTime: number;

  /** 预约时长（秒） */
  duration: number;

  /** 座位 ID 列表 */
  seats: string[];

  /** 是否使用系统推荐：0 = 不使用，1 = 使用（服务端要求数字） */
  is_recommend: number;

  /** 请求发起时刻的 Unix 时间戳（防重放 nonce，非 beginTime） */
  api_time: number;

  /** 预约人（图书馆内部 userInfo.id，非 cookie uid） */
  seatBookers: string[];
}
