export interface RoomConfig {
  /** 房间显示名称 */
  name: string;
  /** 对应第三方 info.id（如 二楼东=1557），锁定房间后偏好座位号才能唯一解析为 seatId */
  roomId: string;
}

// 目前只有二楼东经过实测验证，其余楼层 roomId 已抓包确认，注释占位待启用
export const ROOMS: RoomConfig[] = [
  { name: "二楼东", roomId: "1557" },
  // { name: "二楼西", roomId: "1524" },
  // { name: "四楼", roomId: "1558" },
];
