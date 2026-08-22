import { Injectable } from '@nestjs/common';
import { SearchSeatsResult } from '../../hdu-library/dto/search-seats-result.dto';

/**
 * 选座优先级策略
 * 优先级排序：用户偏好座位 > 系统推荐座位 > 任意可用座位
 */
@Injectable()
export class SeatSelectionStrategy {
  /**
   * 从搜索结果中筛选并排序候选座位
   * @param result searchSeats 返回结果
   * @param preferences 用户偏好的座位号列表（可能为空）
   * @returns 排序后的候选座位 ID 列表
   */
  selectCandidates(
    result: SearchSeatsResult,
    preferences: string[],
    strictMode: boolean = false,
  ): string[] {
    // 可用座位 = state 为 0 的座位
    const availableSeats = result.seats.filter((s) => s.state === 0);

    const availableIds = availableSeats.map((s) => s.id);
    const availableTitles = new Set(availableSeats.map((s) => s.title));

    // 第一优先级：用户偏好座位（按偏好列表顺序）
    const preferred: string[] = preferences
      .filter((p) => availableTitles.has(p))
      .map((title) => {
        const seat = availableSeats.find((s) => s.title === title);
        return seat ? seat.id : '';
      })
      .filter((id) => id !== '');

    // 严格模式：仅返回偏好座位，不降级到推荐或任意座位
    if (strictMode) {
      return preferred;
    }

    // 第二优先级：系统推荐座位（排除已选中的偏好座位）
    const recommended: string[] = result.recommendedSeats
      .filter((id) => availableIds.includes(id))
      .filter((id) => !preferred.includes(id));

    // 第三优先级：任意可用座位（排除已选中的）
    const selected = new Set([...preferred, ...recommended]);
    const anyAvailable: string[] = availableIds.filter(
      (id) => !selected.has(id),
    );

    return [...preferred, ...recommended, ...anyAvailable];
  }
}