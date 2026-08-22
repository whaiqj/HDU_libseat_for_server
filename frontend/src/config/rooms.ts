export interface RoomConfig {
  name: string;
  /** 对应第三方 space_category.category_id（如二楼东=591） */
  categoryId: string;
  /** 对应第三方 space_category.content_id（如二楼东=3） */
  contentId: string;
}

// TODO(agent): 目前只有二楼东经过实测验证，其他楼层 ID 未知，先占位
export const ROOMS: RoomConfig[] = [
  { name: "二楼东", categoryId: "591", contentId: "3" },
  // { name: "三楼西", categoryId: "???", contentId: "???" },
];
