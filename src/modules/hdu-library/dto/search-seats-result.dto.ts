/** 解析后的座位信息 */
export interface SeatInfo {
  /** 系统内部座位 ID */
  id: string;
  /** 座位号 */
  title: string;
  /** 座位状态：0 空闲可约，1 暂离，2 关闭/停用，3 已占用，4 需确认 */
  state: number;
  /** 坐标 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 是否有插座（来源 have_socket 字段） */
  hasSocket: boolean;
}

/** 房间信息 */
export interface RoomInfo {
  id: string;
  name: string;
  /** 地图图片 URL */
  plan: string;
  width: number;
  height: number;
}

/**
 * searchSeats 接口返回结果（内部 DTO）
 * 由第三方 data.info / data.POIs 结构拍平转换而来
 */
export class SearchSeatsResult {
  room: RoomInfo;
  seats: SeatInfo[];
  /** 推荐座位 ID 列表 */
  recommendedSeats: string[];
  /** 双人推荐组合 */
  bestPairSeats?: string[][];
  /**
   * 当前登录用户的图书馆内部 id（来自 content 里 userInfo.id）
   * 用于 bookSeats 的 seatBookers[0]，不能与 cookie 里的 uid 混用
   */
  userInfoId: string;
  /** 保留原始 ui_type，便于排查第三方返回异常/改版 */
  rawUiType: string;
}
