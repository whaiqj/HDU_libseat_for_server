/**
 * searchSeats 接口请求参数
 * 对应阶段 7 实测确认的 Request Payload（space_category 为嵌套对象）
 */

/** 空间分类（服务端要求 space_category[category_id] 形式，非平铺） */
export class SpaceCategory {
  /** 空间分类 ID（自习室固定 591） */
  category_id: string;

  /** 空间分类 content_id（自习室固定 3） */
  content_id: string;
}

export class SearchSeatsParams {
  /** Unix 时间戳 */
  beginTime: number;

  /** 预约时长（秒） */
  duration: number;

  /** 人数，抢座场景固定为 1 */
  num: number;

  /** 空间分类（嵌套对象） */
  space_category: SpaceCategory;
}
