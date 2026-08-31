/**
 * 自习室座位预约业务的全局常量
 * 抓包确认：所有自习室（二楼东/二楼西/四楼…）共用同一组 category_id/content_id，
 * 它们代表"自习室预约"这个业务类型，而非某个具体房间；
 * 具体房间由 searchSeats 返回目录里的 info.id（roomId，如 二楼东=1557）区分，
 * 座位由 POIs[].id（seatId）区分。
 */

/** 自习室预约业务的全局 space_category 标识 */
export const STUDY_ROOM_SPACE_CATEGORY = {
  category_id: '591',
  content_id: '3',
} as const;

/** CAS 回调地址（内含 category_id=591，对应自习室分类） */
export const CAS_SERVICE_URL =
  'https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591';
