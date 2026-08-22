import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'node:crypto';
import { SearchSeatsParams } from './dto/search-seats-params.dto';
import {
  SearchSeatsResult,
  SeatInfo,
  RoomInfo,
} from './dto/search-seats-result.dto';
import { BookSeatsParams } from './dto/book-seats-params.dto';
import { BookSeatsResult } from './dto/book-seats-result.dto';
import { BookErrorCode } from './errors/book-error-code.enum';
import { classifyError } from './errors/error-classifier';
import type { IAuthKeeperService } from '../session/auth-keeper.service';
import { LIBRARY_API } from '../../common/constants/api-endpoints';
import { buildFormBody, FORM_CONTENT_TYPE } from '../../common/utils/form-urlencoded.util';

/**
 * bookSeats 的 Api-Token 签名：base64(md5(canonical_string))
 * canonical 串的字段名与顺序必须与前端 app.es6.min.js 完全一致
 */
function signBookToken(params: BookSeatsParams): string {
  const seatBookersPart = params.seatBookers
    .map((x, i) => `seatBookers[${i}]${x}`)
    .join('&');
  const seatsPart = params.seats.map((x, i) => `seats[${i}]${x}`).join('&');
  const canonical =
    `post&${LIBRARY_API.BOOK_SEATS}` +
    `&api_time${params.api_time}` +
    `&beginTime${params.beginTime}` +
    `&duration${params.duration}` +
    `&is_recommend${params.is_recommend}` +
    `&${seatBookersPart}` +
    `&${seatsPart}`;
  const md5Hex = crypto.createHash('md5').update(canonical, 'utf8').digest('hex');
  return Buffer.from(md5Hex, 'utf8').toString('base64');
}

/**
 * 图书馆底层 API 客户端
 * 封装 searchSeats / bookSeats 接口，负责：
 * 1. 发 HTTP 请求（form-urlencoded 编码 + 自动附带登录凭证 Cookie + Api-Token 签名）
 * 2. 将第三方 data.info / data.POIs 结构 → 内部 DTO
 * 3. 标准化错误分类
 */
@Injectable()
export class HduLibraryClientService {
  private readonly logger = new Logger(HduLibraryClientService.name);
  private baseUrl: string;

  // RTT 滑动窗口：search 和 book 是两种量级的耗时分布，分开追踪，避免互相污染估计值
  private readonly searchRttWindow: number[] = [];
  private readonly bookRttWindow: number[] = [];
  private readonly RTT_WINDOW_SIZE = 5;
  private readonly MIN_TIMEOUT_MS = 8_000;   // 硬下限 8 秒
  private readonly MAX_TIMEOUT_MS = 15_000;  // 硬上限 15 秒
  private readonly RTT_MULTIPLIER = 3;       // RTT 倍数

  constructor(
    private readonly httpService: HttpService,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
  ) {
    this.baseUrl =
      process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';
  }

  /** 记录一次 RTT 样本到指定滑动窗口 */
  private recordRtt(window: number[], ms: number): void {
    window.push(ms);
    if (window.length > this.RTT_WINDOW_SIZE) {
      window.shift();
    }
  }

  /** 从滑动窗口计算自适应超时：max(中位数 × RTT_MULTIPLIER, MIN_TIMEOUT_MS)，硬上限 MAX_TIMEOUT_MS */
  private computeAdaptiveTimeout(window: number[]): number {
    if (window.length === 0) {
      return this.MIN_TIMEOUT_MS; // 冷启动：8 秒
    }
    const sorted = [...window].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.min(
      Math.max(median * this.RTT_MULTIPLIER, this.MIN_TIMEOUT_MS),
      this.MAX_TIMEOUT_MS,
    );
  }

  /**
   * 查询可用座位
   * 发起 HTTP 请求，将第三方 data.info / data.POIs 结构拍平为 SearchSeatsResult DTO
   */
  async searchSeats(params: SearchSeatsParams, accountId: string, taskId: string): Promise<SearchSeatsResult> {
    // 调试日志：打印实际发出的 beginTime 及对应北京时间（debug 级别，生产默认不输出）
    const beginTimeBeijing = new Date(params.beginTime * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    this.logger.debug(
      `taskId=${taskId} [searchSeats 请求参数] beginTime=${params.beginTime} (北京时间: ${beginTimeBeijing}) ` +
      `duration=${params.duration} category_id=${params.space_category.category_id} ` +
      `content_id=${params.space_category.content_id}`,
    );

    const searchStartMs = Date.now();
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.baseUrl}${LIBRARY_API.SEARCH_SEATS}`,
        buildFormBody(params),
        {
          headers: {
            ...this.getAuthHeaders(accountId),
            'Content-Type': FORM_CONTENT_TYPE,
          },
          timeout: this.computeAdaptiveTimeout(this.searchRttWindow),
        },
      ),
    );
    this.recordRtt(this.searchRttWindow, Date.now() - searchStartMs);

    const raw = response.data;

    // 调试日志：降噪，只打印摘要（seats总数 / available数 / recommended数）
    const seatsTotal = raw?.data?.POIs?.length ?? 0;
    const availableCount = raw?.data?.POIs?.filter((p: any) => p.state === 0).length ?? 0;
    const recommendedCount = raw?.data?.bestPairSeats?.seats?.filter((s: any) => s.recommend === true).length ?? 0;
    this.logger.debug(
      `taskId=${taskId} [searchSeats 响应摘要] seats总数=${seatsTotal} available数=${availableCount} recommended数=${recommendedCount}`,
    );

    // 错误响应识别：ui_type === "com.Message" 表示第三方返回的是消息提示（如"预约人数过多"）
    // 不是正常的座位列表数据，应作为业务错误抛出
    if (raw?.ui_type === 'com.Message') {
      const msg = raw?.MESSAGE ?? raw?.DATA?.MESSAGE ?? '未知错误';
      const code = raw?.CODE;
      this.logger.warn(`taskId=${taskId} [searchSeats 返回业务错误] CODE=${code} MESSAGE=${msg}`);
      // 异常时兜底打印完整原始响应
      const rawStr = JSON.stringify(raw);
      this.logger.debug(`taskId=${taskId} [searchSeats 异常原始响应] ${rawStr}`);
      const err = new Error(`searchSeats 业务错误: ${msg} (CODE=${code})`);
      (err as any).code = code;
      (err as any).message = msg;
      (err as any).isBusinessError = true;
      throw err;
    }

    return this.transformSearchResponse(raw);
  }

  /**
   * 提交预约
   * 返回标准化结果
   */
  async bookSeats(params: BookSeatsParams, accountId: string, taskId: string): Promise<BookSeatsResult> {
    // 调试日志：打印实际发出的 beginTime 及对应北京时间（debug 级别，生产默认不输出）
    const beginTimeBeijing = new Date(params.beginTime * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const apiTimeBeijing = new Date(params.api_time * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    this.logger.debug(
      `taskId=${taskId} [bookSeats 请求参数] beginTime=${params.beginTime} (北京时间: ${beginTimeBeijing}) ` +
      `duration=${params.duration} seats=${params.seats.join(',')} ` +
      `api_time=${params.api_time} (北京时间: ${apiTimeBeijing}) ` +
      `seatBookers=${params.seatBookers.join(',')} is_recommend=${params.is_recommend}`,
    );

    try {
      const bookStartMs = Date.now();
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}${LIBRARY_API.BOOK_SEATS}`,
          buildFormBody(params),
          {
            headers: {
              ...this.getAuthHeaders(accountId),
              'Content-Type': FORM_CONTENT_TYPE,
              'Api-Token': signBookToken(params),
            },
            timeout: this.computeAdaptiveTimeout(this.bookRttWindow),
          },
        ),
      );
      this.recordRtt(this.bookRttWindow, Date.now() - bookStartMs);
      const raw = response.data;

      // 成功判定层级：DATA.result === 'success'（顶层无 result）
      if (raw?.DATA?.result === 'success') {
        this.logger.debug(
          `taskId=${taskId} [bookSeats 响应] code=success message=${raw?.MESSAGE ?? '预约成功'}`,
        );
        return {
          success: true,
          bookedSeatId: params.seats[0],
        };
      }

      // 分类错误
      const errorCode = this.classifyBookError(raw);
      const code = raw?.CODE ?? raw?.code ?? 'unknown';
      const message = raw?.MESSAGE ?? raw?.msg ?? '';
      this.logger.debug(
        `taskId=${taskId} [bookSeats 响应] code=${code} message=${message}`,
      );

      // 若返回码不在已知枚举内，打印完整原始响应作为兜底
      if (errorCode === BookErrorCode.UNKNOWN) {
        const rawStr = JSON.stringify(raw);
        this.logger.debug(`taskId=${taskId} [bookSeats 未知错误原始响应] ${rawStr}`);
      }

      return {
        success: false,
        errorCode,
        errorMessage: message,
      };
    } catch (error) {
      // 网络异常
      const category = classifyError(null, error);
      let errorCode: BookErrorCode;
      switch (category) {
        case 'network':
          errorCode = BookErrorCode.NETWORK_ERROR;
          break;
        default:
          errorCode = BookErrorCode.UNKNOWN;
      }
      const message = error.message ?? 'Network error';
      this.logger.debug(
        `taskId=${taskId} [bookSeats 网络异常] errorCode=${errorCode} message=${message}`,
      );
      return {
        success: false,
        errorCode,
        errorMessage: message,
      };
    }
  }

  /**
   * 解析第三方 data.info / data.POIs 结构为内部 DTO
   * 同时提取 content 里内嵌的 userInfo.id（预约人内部 id）
   */
  private transformSearchResponse(raw: any): SearchSeatsResult {
    const info = raw?.data?.info ?? {};
    const pois = raw?.data?.POIs ?? [];

    // 房间信息（data.info）
    const room: RoomInfo = {
      id: String(info.id ?? ''),
      name: String(info.title ?? ''),
      plan: String(info.plan ?? ''),
      width: Number(info.width ?? 0),
      height: Number(info.height ?? 0),
    };

    // 座位列表（data.POIs，have_socket → hasSocket，state 转数字）
    const seats: SeatInfo[] = pois.map((poi: any) => ({
      id: String(poi.id ?? ''),
      title: String(poi.title ?? ''),
      state: Number(poi.state ?? 0),
      x: Number(poi.x ?? 0),
      y: Number(poi.y ?? 0),
      w: Number(poi.w ?? 0),
      h: Number(poi.h ?? 0),
      hasSocket:
        poi.have_socket === '1' ||
        poi.have_socket === 1 ||
        poi.have_socket === true,
    }));

    // 推荐座位：取 data.bestPairSeats.seats 与 POIs 里 recommend=true 的 id
    const recommendedSeats: string[] = [];
    const recommendedIds = new Set<string>();
    const bestPairSeats = raw?.data?.bestPairSeats;
    if (Array.isArray(bestPairSeats?.seats)) {
      for (const s of bestPairSeats.seats) {
        if (s?.recommend === true && s?.id !== undefined) {
          recommendedIds.add(String(s.id));
          recommendedSeats.push(String(s.id));
        }
      }
    }
    for (const poi of pois) {
      if (
        poi?.recommend === true &&
        poi?.id !== undefined &&
        !recommendedIds.has(String(poi.id))
      ) {
        recommendedIds.add(String(poi.id));
        recommendedSeats.push(String(poi.id));
      }
    }

    // 双人推荐组合：data.bestPairSeats.seats 为一组
    let bestPairSeatsPairs: string[][] | undefined;
    if (Array.isArray(bestPairSeats?.seats)) {
      bestPairSeatsPairs = [bestPairSeats.seats.map((s: any) => String(s.id))];
    }

    return {
      room,
      seats,
      recommendedSeats,
      bestPairSeats: bestPairSeatsPairs,
      userInfoId: this.extractUserInfoId(raw),
      rawUiType: String(raw?.ui_type ?? ''),
    };
  }

  /**
   * 从响应中提取预约人内部 id（userInfo.id）
   * 优先从 DATA.uid 取（错误响应和正常响应都有这个字段）
   * 兜底：从 content.children 的 userInfo.id 深搜
   */
  private extractUserInfoId(raw: any): string {
    // 优先从 DATA.uid 取，这是最稳定的字段
    if (raw?.DATA?.uid) {
      return String(raw.DATA.uid);
    }

    let found = '';
    const walk = (o: any): void => {
      if (found || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) {
        o.forEach(walk);
        return;
      }
      if (o.userInfo && o.userInfo.id !== undefined) {
        found = String(o.userInfo.id);
        return;
      }
      Object.values(o).forEach(walk);
    };
    walk(raw);
    return found;
  }

  /**
   * 分类 bookSeats 错误
   * 调用 classifyError 获取 ErrorCategory，映射为 BookErrorCode
   */
  private classifyBookError(raw: any): BookErrorCode {
    const category = classifyError(raw);

    switch (category) {
      case 'seat_unavailable':
        return BookErrorCode.SEAT_TAKEN;
      case 'blacklist':
        return BookErrorCode.BLACKLISTED;
      case 'session_expired':
        return BookErrorCode.NOT_LOGIN;
      case 'network':
        return BookErrorCode.NETWORK_ERROR;
      case 'rate_limit':
        return BookErrorCode.RATE_LIMIT;
      case 'window_not_open':
        return BookErrorCode.WINDOW_NOT_OPEN;
      default:
        return BookErrorCode.UNKNOWN;
    }
  }

  /**
   * 从 AuthKeeperService 获取凭证，构造请求头
   */
  private getAuthHeaders(accountId: string): Record<string, string> {
    const credential = this.authKeeper.getCredentials(accountId);
    if (!credential.value) {
      return {};
    }
    return { Cookie: credential.value };
  }
}
