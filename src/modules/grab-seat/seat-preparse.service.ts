import { Injectable, Logger } from '@nestjs/common';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';
import { RoomSeats } from '../hdu-library/dto/search-seats-result.dto';
import { GrabTask } from '../grab-task/entities/grab-task.entity';

/** 预解析出的单个偏好座位 */
export interface PreparsedSeat {
  /** 偏好座位号（用户输入的 title） */
  title: string;
  /** 锁定房间内该座位号对应的系统内部 seatId */
  seatId: string;
}

/**
 * 触发前预解析结果：盲抢所需的全部静态参数
 * - 偏好座位号 → seatId（必须先锁定房间，多房间分类下同座位号是不同 seatId）
 * - 预约人 userInfo.id（bookSeats 的 seatBookers[0]）
 */
export interface PreparseEntry {
  taskId: string;
  accountId: string;
  /** 预约人图书馆内部 id */
  userInfoId: string;
  /** 实际锁定的房间 */
  roomId: string;
  roomName: string;
  /** 按偏好顺序解析出的座位（仅含解析成功的） */
  seats: PreparsedSeat[];
  /** 未能解析成 seatId 的偏好座位号（房间内不存在） */
  unresolvedTitles: string[];
  /** 是否存在跨房间同名座位、由系统自动挑选的房间（提醒用户确认） */
  autoPickedRoom: boolean;
  resolvedAt: number;
}

/**
 * 预解析执行结果
 * - entry 非空：解析成功（含全部静态参数）
 * - entry 为空 + failReason：解析失败及原因（透出给前端展示）
 */
export interface PreparseOutcome {
  entry: PreparseEntry | null;
  failReason?: string;
}

/** 缓存有效期：预检在 T-5min 执行，触发距预检不超过 5 分钟，10 分钟 TTL 留足余量 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 偏好座位预解析服务
 * 在 session-precheck（触发前 5 分钟）执行一次 searchSeats：
 * 1. 从 allContent 房间目录锁定目标房间（任务指定 roomId 优先）
 * 2. 把偏好座位号解析成 seatId（seatId 跨天稳定，触发时刻可直接盲发 bookSeats）
 * 3. 缓存 userInfoId，抢座热路径不再依赖 searchSeats
 *
 * 解析失败（网络/会话问题）不阻断主流程：worker 回退到 search-first 循环
 */
@Injectable()
export class SeatPreparseService {
  private readonly logger = new Logger(SeatPreparseService.name);
  /** 进程内缓存：taskId → 预解析结果。后端重启即失效，worker 会做一次惰性补解析 */
  private readonly cache = new Map<string, PreparseEntry>();

  constructor(
    private readonly hduLibraryClient: HduLibraryClientService,
  ) {}

  /**
   * 执行预解析并写缓存
   * @returns 解析结果；searchSeats 失败或无可用房间时 entry 为 null 并携带 failReason（调用方回退 search-first）
   */
  async preparse(task: GrabTask): Promise<PreparseOutcome> {
    let searchResult;
    try {
      searchResult = await this.hduLibraryClient.searchSeats(
        {
          beginTime: Number(task.beginTime),
          duration: task.duration,
          num: 1,
          space_category: {
            category_id: task.categoryId,
            content_id: task.contentId,
          },
        },
        task.accountId,
        task.id,
      );
    } catch (e) {
      const failReason = `座位搜索失败: ${(e as Error).message}`;
      this.logger.warn(
        `[预解析失败] taskId=${task.id} message=${(e as Error).message}，正式抢座时回退 search-first`,
      );
      return { entry: null, failReason };
    }

    if (!searchResult.userInfoId) {
      this.logger.warn(`[预解析失败] taskId=${task.id} 未能提取 userInfoId`);
      return { entry: null, failReason: '未能提取预约人 userInfoId' };
    }

    const rooms =
      searchResult.allRooms && searchResult.allRooms.length > 0
        ? searchResult.allRooms
        : [
            {
              id: searchResult.room.id,
              name: searchResult.room.name,
              seats: searchResult.seats,
            } satisfies RoomSeats,
          ];

    const { roomId, roomName, seats, unresolvedTitles, autoPickedRoom } =
      this.resolvePreferenceSeats(rooms, searchResult.room.id, task);

    if (!roomId) {
      const failReason = task.roomId
        ? `指定房间（roomId=${task.roomId}）不在房间目录中`
        : rooms.length === 0
          ? '房间目录为空'
          : '偏好座位号在所有房间中均不存在';
      this.logger.warn(`[预解析失败] taskId=${task.id} ${failReason}`);
      return { entry: null, failReason };
    }

    const entry: PreparseEntry = {
      taskId: task.id,
      accountId: task.accountId,
      userInfoId: searchResult.userInfoId,
      roomId,
      roomName,
      seats,
      unresolvedTitles,
      autoPickedRoom,
      resolvedAt: Date.now(),
    };
    this.cache.set(task.id, entry);

    this.logger.log(
      `[预解析完成] taskId=${task.id} 房间=${roomName}(${roomId}) ` +
        `座位映射=${seats.map((s) => `${s.title}→${s.seatId}`).join(',')} ` +
        `未解析=${unresolvedTitles.join(',') || '-'} 自动挑房=${autoPickedRoom}`,
    );
    return { entry };
  }

  /** 读取未过期的缓存条目 */
  get(taskId: string): PreparseEntry | null {
    const entry = this.cache.get(taskId);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.resolvedAt > CACHE_TTL_MS) {
      this.cache.delete(taskId);
      return null;
    }
    return entry;
  }

  /** 任务终态后清理缓存 */
  invalidate(taskId: string): void {
    this.cache.delete(taskId);
  }

  /**
   * 房间锁定与座位号解析规则：
   * 1. 任务指定 roomId：严格在该房间内解析；房间不在目录中 → 返回空 roomId（回退）
   * 2. 未指定：逐个座位号找包含它的房间；
   *    - 唯一房间 → 直接锁定
   *    - 多房间同名 → 优先推荐房间（data.info），否则取第一个并标记 autoPickedRoom
   * 3. 所有座位号均无法解析到任何房间 → 返回空 roomId（回退）
   */
  private resolvePreferenceSeats(
    rooms: RoomSeats[],
    recommendedRoomId: string,
    task: GrabTask,
  ): {
    roomId: string;
    roomName: string;
    seats: PreparsedSeat[];
    unresolvedTitles: string[];
    autoPickedRoom: boolean;
  } {
    const preferences = task.seatPreference ?? [];
    const empty = {
      roomId: '',
      roomName: '',
      seats: [] as PreparsedSeat[],
      unresolvedTitles: preferences,
      autoPickedRoom: false,
    };

    if (rooms.length === 0) {
      return empty;
    }

    // 情形 1：任务显式指定房间
    if (task.roomId) {
      const pinned = rooms.find((r) => r.id === task.roomId);
      if (!pinned) {
        return empty;
      }
      const seats: PreparsedSeat[] = [];
      const unresolvedTitles: string[] = [];
      for (const title of preferences) {
        const seat = pinned.seats.find((s) => s.title === title);
        if (seat) {
          seats.push({ title, seatId: seat.id });
        } else {
          unresolvedTitles.push(title);
        }
      }
      return {
        roomId: pinned.id,
        roomName: pinned.name,
        seats,
        unresolvedTitles,
        autoPickedRoom: false,
      };
    }

    // 情形 2：自动挑房
    // 候选房间 = 包含全部偏好座位号的房间；不存在时退化为包含任一座位号的房间
    let candidates = rooms.filter((r) =>
      preferences.every((t) => r.seats.some((s) => s.title === t)),
    );
    if (candidates.length === 0) {
      candidates = rooms.filter((r) =>
        preferences.some((t) => r.seats.some((s) => s.title === t)),
      );
    }
    if (candidates.length === 0) {
      return empty;
    }

    // 多候选时优先推荐房间（服务端当前 data.info 指向的房间），否则取第一个
    let autoPickedRoom = false;
    let picked = candidates.find((r) => r.id === recommendedRoomId);
    if (!picked) {
      picked = candidates[0];
      autoPickedRoom = candidates.length > 1;
    } else if (candidates.length > 1) {
      autoPickedRoom = true;
    }

    const seats: PreparsedSeat[] = [];
    const unresolvedTitles: string[] = [];
    for (const title of preferences) {
      const seat = picked.seats.find((s) => s.title === title);
      if (seat) {
        seats.push({ title, seatId: seat.id });
      } else {
        unresolvedTitles.push(title);
      }
    }
    return {
      roomId: picked.id,
      roomName: picked.name,
      seats,
      unresolvedTitles,
      autoPickedRoom,
    };
  }
}
