import { Injectable, Inject, Logger } from '@nestjs/common';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';
import { SeatSelectionStrategy } from './strategies/seat-selection.strategy';
import { GrabTaskService } from '../grab-task/grab-task.service';
import {
  GrabAttemptLogService,
  CreateAttemptLogParams,
} from '../grab-attempt-log/grab-attempt-log.service';
import { AttemptResult } from '../grab-attempt-log/entities/grab-attempt-log.entity';
import { GrabTask, TaskStatus } from '../grab-task/entities/grab-task.entity';
import { SearchSeatsResult } from '../hdu-library/dto/search-seats-result.dto';
import type { IAuthKeeperService } from '../session/auth-keeper.service';
import type { INotificationService } from '../notification/notification.service';
import { BookErrorCode } from '../hdu-library/errors/book-error-code.enum';
import { ErrorCategory } from '../hdu-library/errors/error-category.enum';
import { isRetryable } from '../hdu-library/errors/error-classifier';

/**
 * 抢座重试配置（两段式节奏 + WINDOW_NOT_OPEN 快速通道）
 * - 任务唤醒后先高频探测（每 highFreqIntervalMs 一轮），持续 highFreqDurationMs
 * - 之后转入低频探测（每 lowFreqIntervalMs 一轮），直到 windowMs 窗口结束
 * - 限流错误不走常规间隔，单独短退避 rateLimitBackoffMs
 * - WINDOW_NOT_OPEN 错误单独 300ms 快速重试（窗口随时可能开放），连续命中超阈值后降级
 * - 时间窗口驱动：不再设尝试次数上限，次数仅作统计与日志
 * 所有时间判定以 task.triggerAt 为绝对锚点校准，不受队列唤醒延迟影响
 *
 * 重试间隔决策优先级（由高到低）：
 * 1. WINDOW_NOT_OPEN（连续 < degradeThreshold）→ windowNotOpenIntervalMs
 *    —— 无论当前处于 high_freq 还是 low_freq 阶段，"还没开闸"是比阶段更强的信号
 * 2. WINDOW_NOT_OPEN（连续 ≥ degradeThreshold）→ 降级为常规间隔（保险丝）
 * 3. RATE_LIMIT → rateLimitBackoffMs
 * 4. 其他可重试错误 → 按阶段：high_freq=highFreqIntervalMs / low_freq=lowFreqIntervalMs
 *
 * 注意：windowNotOpenIntervalMs 是"上一轮请求结束后的等待间隔"，不是"两次请求发起时刻的间隔"。
 * 若请求本身耗时 1 秒以上，真实节奏会比这个值慢，重试间隔下限最终被网络延迟卡住。
 */
export const RETRY_CONFIG = {
  highFreqIntervalMs: 1_000, // 高频段探测间隔：1秒
  highFreqDurationMs: 15_000, // 高频段持续时长：15秒
  lowFreqIntervalMs: 3_000, // 低频段探测间隔：3秒
  rateLimitBackoffMs: 3_000, // 限流错误短退避：3秒
  windowNotOpenIntervalMs: 300, // WINDOW_NOT_OPEN 快速重试：300ms（窗口随时可能开放）
  windowNotOpenDegradeThreshold: 10, // 连续命中 10 次后降级到常规间隔（保险丝：防止误分类导致失控空转）
  unknownMaxAttempts: 2, // UNKNOWN 未知错误独立重试上限（问题7 设计原则 #1）
  windowMs: 3 * 60 * 1000, // 3分钟总时间窗口硬上限
};

/** 单次抢座尝试结果 */
export interface GrabResult {
  success: boolean;
  bookedSeatId?: string;
  seatTitle?: string;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
}

/** 单轮尝试的耗时信息（埋点）：记录 searchSeats 与每次 bookSeats 的起止时间戳 */
interface AttemptTiming {
  searchStartMs: number;
  /** searchSeats 抛异常时无结束时间戳 */
  searchEndMs?: number;
  /** 各候选座位 bookSeats 的耗时，按 seatId 对应 */
  books: Array<{ seatId: string; startMs: number; endMs: number }>;
}

/** tryGrabOnce 内部返回结构：抢座结果 + 本轮耗时信息 */
type TryGrabOnceResult = GrabResult & { timing: AttemptTiming };

/**
 * 抢座执行核心
 * 完整执行流程：
 * 任务唤醒 → 校验登录态 → searchSeats → 筛选候选座位 → bookSeats
 * → 成功更新状态并通知 / 失败分类后换座重试或终止
 */
@Injectable()
export class GrabSeatWorker {
  private readonly logger = new Logger(GrabSeatWorker.name);

  constructor(
    private readonly hduLibraryClient: HduLibraryClientService,
    private readonly seatSelection: SeatSelectionStrategy,
    private readonly grabTaskService: GrabTaskService,
    private readonly attemptLogService: GrabAttemptLogService,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
    @Inject('INotificationService')
    private readonly notification: INotificationService,
  ) {}

  /**
   * 执行抢座任务
   * @param wakeupMs BullMQ 队列唤醒时刻（processor 在 findById 之前采集）。
   *                 未传入时 grab_round 日志的 wakeupMs 记为 null，明确表示缺失，
   *                 绝不用下游时间点冒充唤醒时刻。
   */
  async executeGrab(task: GrabTask, wakeupMs?: number): Promise<void> {
    const startMs = Date.now();
    this.logger.log(`[任务开始] taskId=${task.id} accountId=${task.accountId}`);

    // 1. 通知任务开始（fire-and-forget：不阻塞首击，异常仅告警）
    this.fireAndForget(
      this.notification.notify({
        userId: task.accountId,
        taskId: task.id,
        type: 'grab_started',
        data: { categoryId: task.categoryId },
      }),
      `notify(grab_started) taskId=${task.id}`,
    );

    // 2. 更新任务状态为 running（fire-and-forget：不阻塞首击）
    this.fireAndForget(
      this.grabTaskService.updateStatus(task.id, TaskStatus.RUNNING),
      `updateStatus(RUNNING) taskId=${task.id}`,
    );
    this.logger.log(`[状态已置为 running] taskId=${task.id}`);

    // 3. 时间窗口驱动的重试循环
    // 绝对锚点：以 task.triggerAt（放号时间点）校准阶段切换与窗口截止，
    // 即使队列唤醒有延迟，节奏仍对齐放号时刻
    const triggerAtMs = Number(task.triggerAt) * 1000;
    let anchor =
      Number.isFinite(triggerAtMs) && triggerAtMs > 0
        ? triggerAtMs
        : Date.now();
    // 兜底：唤醒时刻已晚于窗口终点（任务延迟触发）时，退化为以唤醒时间为锚，避免不做任何探测就直接终止
    if (Date.now() >= anchor + RETRY_CONFIG.windowMs) {
      anchor = Date.now();
    }
    const highFreqEnd = anchor + RETRY_CONFIG.highFreqDurationMs;
    const deadline = anchor + RETRY_CONFIG.windowMs;

    let attempt = 0;
    let unknownAttempts = 0;
    let consecutiveWindowNotOpen = 0; // 连续命中 WINDOW_NOT_OPEN 的计数（保险丝：超阈值后降级）
    // 已确认被占的座位集合：跨尝试去重，保证每个座位只提醒一次
    const notifiedTakenSeats = new Set<string>();
    // 最后一次"座位不可用"的具体原因，最终失败时透出给用户
    let lastSeatError: string | undefined;

    while (Date.now() < deadline) {
      // 用户在抢座过程中手动终止任务 → 立即退出，不标记失败、不发失败通知
      if (this.grabTaskService.isCancellationRequested(task.id)) {
        this.logger.log(`[任务已被用户取消] taskId=${task.id}`);
        // 任务终态收尾日志
        this.logger.log(
          JSON.stringify({
            event: 'task_finished',
            taskId: task.id,
            result: 'cancelled',
            seatId: null,
            totalDurationMs: Date.now() - startMs,
            totalRounds: attempt,
            ts: Date.now(),
          }),
        );
        return;
      }

      attempt++;
      // fire-and-forget：底层 repository.increment 为数据库原子自增
      //（UPDATE SET attempts = attempts + 1），并发甩出不会丢更新，无需阻塞热路径
      this.fireAndForget(
        this.grabTaskService.incrementAttempts(task.id),
        `incrementAttempts taskId=${task.id}`,
      );
      this.logger.log(`[第 ${attempt} 次尝试开始] taskId=${task.id}`);

      const result = await this.tryGrabOnce(task, notifiedTakenSeats);
      this.logger.log(
        `[第 ${attempt} 次尝试结果] taskId=${task.id} success=${result.success} ` +
          `errorCategory=${result.errorCategory ?? '-'} errorMessage=${result.errorMessage ?? '-'}`,
      );

      // 轮次级结构化日志（debug 级别、单行 JSON、含 taskId 关联字段）：
      // 耗时埋点 + 座位状态观察，用于判断座位何时开始松动
      this.logger.debug(
        JSON.stringify({
          event: 'grab_round',
          taskId: task.id,
          attempt,
          phase: Date.now() < highFreqEnd ? 'high_freq' : 'low_freq',
          wakeupMs: wakeupMs ?? null,
          roundStartMs: result.timing.searchStartMs,
          roundEndMs: Date.now(),
          success: result.success,
          errorCategory: result.errorCategory ?? null,
          errorMessage: result.errorMessage ?? null,
          searchDurationMs:
            result.timing.searchEndMs !== undefined
              ? result.timing.searchEndMs - result.timing.searchStartMs
              : null,
          bookCount: result.timing.books.length,
          bookDurationMs: result.timing.books.reduce(
            (sum, b) => sum + (b.endMs - b.startMs),
            0,
          ),
        }),
      );

      if (result.errorCategory === ErrorCategory.SEAT_UNAVAILABLE) {
        lastSeatError = result.errorMessage;
      }

      if (result.success) {
        await this.markSuccess(task, result, attempt, startMs);
        return;
      }

      // 登录态失效：尝试刷新会话后重试，刷新失败则终止
      if (result.errorCategory === ErrorCategory.SESSION_EXPIRED) {
        try {
          await this.authKeeper.refreshSession(task.accountId);
        } catch (e) {
          await this.markFailed(
            task,
            `登录态刷新失败: ${(e as Error).message}`,
            attempt,
            startMs,
          );
          return;
        }
        // 刷新成功，继续重试循环
      }

      // 不可重试错误（黑名单/参数错误等）直接终止
      if (result.errorCategory && !isRetryable(result.errorCategory)) {
        await this.markFailed(task, result.errorMessage ?? '不可重试错误', attempt, startMs);
        return;
      }

      // UNKNOWN 未知错误单独限制重试上限，避免对不明错误无限重试
      if (result.errorCategory === ErrorCategory.UNKNOWN) {
        unknownAttempts++;
        if (unknownAttempts >= RETRY_CONFIG.unknownMaxAttempts) {
          await this.markFailed(
            task,
            `未知错误重试达 ${RETRY_CONFIG.unknownMaxAttempts} 次上限，终止`,
            attempt,
            startMs,
          );
          return;
        }
      }

      // 决定下一轮前的等待间隔（优先级见 RETRY_CONFIG 注释）：
      // - 绝对时间校准：等待时长钳制到窗口终点，绝不越过 deadline
      let nextInterval: number;

      if (result.errorCategory === ErrorCategory.WINDOW_NOT_OPEN) {
        consecutiveWindowNotOpen++;
        if (consecutiveWindowNotOpen < RETRY_CONFIG.windowNotOpenDegradeThreshold) {
          nextInterval = RETRY_CONFIG.windowNotOpenIntervalMs; // 300ms 快速重试
        } else {
          // 保险丝：连续命中超阈值，降级为常规阶段间隔
          nextInterval = Date.now() < highFreqEnd
            ? RETRY_CONFIG.highFreqIntervalMs
            : RETRY_CONFIG.lowFreqIntervalMs;
        }
      } else {
        // 命中其他错误类型时清零 WINDOW_NOT_OPEN 连续计数
        consecutiveWindowNotOpen = 0;

        nextInterval =
          result.errorCategory === ErrorCategory.RATE_LIMIT
            ? RETRY_CONFIG.rateLimitBackoffMs
            : Date.now() < highFreqEnd
              ? RETRY_CONFIG.highFreqIntervalMs
              : RETRY_CONFIG.lowFreqIntervalMs;
      }
      const sleepMs = Math.min(nextInterval, deadline - Date.now());

      // 等待期间轮询取消标记，被用户终止时立即退出
      if (sleepMs > 0) {
        const cancelled = await this.sleepInterruptible(sleepMs, task.id);
        if (cancelled) {
          this.logger.log(`[任务已被用户取消] taskId=${task.id}`);
          // 任务终态收尾日志
          this.logger.log(
            JSON.stringify({
              event: 'task_finished',
              taskId: task.id,
              result: 'cancelled',
              seatId: null,
              totalDurationMs: Date.now() - startMs,
              totalRounds: attempt,
              ts: Date.now(),
            }),
          );
          return;
        }
      }
    }

    // 超出时间窗口
    // 若期间确认过"座位被占"，把具体原因透出，替代笼统文案
    const reason = lastSeatError
      ? `${lastSeatError}（已尝试 ${attempt} 次后放弃）`
      : '超出时间窗口';
    await this.markFailed(task, reason, attempt, startMs);
  }

  /**
   * 单次抢座尝试：包含 searchSeats + bookSeats 全流程
   * @param notifiedTakenSeats 已提醒过的被占座位集合（跨尝试去重）
   * @returns 抢座结果 + 本轮耗时信息（埋点）
   */
  private async tryGrabOnce(
    task: GrabTask,
    notifiedTakenSeats: Set<string>,
  ): Promise<TryGrabOnceResult> {
    const timing: AttemptTiming = { searchStartMs: Date.now(), books: [] };

    // searchSeats 获取最新座位状态快照
    let searchResult: SearchSeatsResult;
    this.logger.debug(
      `[searchSeats 请求] taskId=${task.id} beginTime=${task.beginTime} duration=${task.duration}`,
    );
    try {
      searchResult = await this.hduLibraryClient.searchSeats({
        beginTime: task.beginTime,
        duration: task.duration,
        num: 1,
        space_category: {
          category_id: task.categoryId,
          content_id: task.contentId,
        },
      }, task.accountId, task.id);
      timing.searchEndMs = Date.now();
    } catch (error) {
      // searchSeats 抛异常：无结束时间戳
      const err = error as any;
      this.logger.error(
        `[searchSeats 失败] taskId=${task.id} message=${err.message} status=${err.response?.status ?? '-'}`,
      );

      // 业务错误（如"预约人数过多"）：归为 BUSINESS_RULE，不可重试
      if (err?.isBusinessError) {
        const result: GrabResult = {
          success: false,
          errorCategory: ErrorCategory.BUSINESS_RULE,
          errorMessage: err.message ?? 'searchSeats 业务错误',
        };
        // 轮次级日志行（无 bookSeats 的轮次）：此后继续重试 → fire-and-forget
        this.writeAttemptLog(
          {
            taskId: task.id,
            accountId: task.accountId,
            seatId: '-',
            result: AttemptResult.FAILED,
            errorMsg: result.errorMessage,
            searchStartMs: timing.searchStartMs,
            searchEndMs: null,
          },
          false,
        );
        return { ...result, timing };
      }

      const result: GrabResult = {
        success: false,
        errorCategory: ErrorCategory.NETWORK,
        errorMessage: `searchSeats 异常: ${err.message}`,
      };
      this.writeAttemptLog(
        {
          taskId: task.id,
          accountId: task.accountId,
          seatId: '-',
          result: AttemptResult.FAILED,
          errorMsg: result.errorMessage,
          searchStartMs: timing.searchStartMs,
          searchEndMs: null,
        },
        false,
      );
      return { ...result, timing };
    }

    this.logger.debug(
      `[searchSeats 成功] taskId=${task.id} seats=${searchResult.seats.length} recommended=${searchResult.recommendedSeats.length}`,
    );

    // 预约人必须用 userInfo.id（图书馆内部 id），不能用 cookie 里的 uid
    if (!searchResult.userInfoId) {
      const result: GrabResult = {
        success: false,
        errorCategory: ErrorCategory.PARAM_INVALID,
        errorMessage: '未能从 searchSeats 提取预约人 userInfo.id',
      };
      // 该错误不可重试、任务即将终止，此后不再发请求 → 阻塞落盘
      await this.writeAttemptLog(
        {
          taskId: task.id,
          accountId: task.accountId,
          seatId: '-',
          result: AttemptResult.FAILED,
          errorMsg: result.errorMessage,
          searchStartMs: timing.searchStartMs,
          searchEndMs: timing.searchEndMs,
        },
        true,
      );
      return { ...result, timing };
    }

    // 实时提醒：偏好座位在快照中已被占用时立即通知（只提示存在于本房间、但状态非空闲的）
    // 严格模式下候选会为空，用户正是靠这条消息知道"我要的座位没了"
    // fire-and-forget：此后还要继续发起候选座位请求，通知不阻塞热路径
    if (task.seatPreference?.length) {
      const seatByTitle = new Map(searchResult.seats.map((s) => [s.title, s]));
      for (const prefTitle of task.seatPreference) {
        const prefSeat = seatByTitle.get(prefTitle);
        if (
          prefSeat &&
          prefSeat.state !== 0 &&
          !notifiedTakenSeats.has(prefSeat.id)
        ) {
          notifiedTakenSeats.add(prefSeat.id);
          void this.notifySeatTaken(task, prefSeat.title);
        }
      }
    }

    // 按优先级筛选候选座位（用户偏好 > 系统推荐 > 任意可用座位）
    const candidates = this.seatSelection.selectCandidates(
      searchResult,
      task.seatPreference ?? [],
      task.strictMode ?? false,
    );

    if (candidates.length === 0) {
      const result: GrabResult = {
        success: false,
        errorCategory: ErrorCategory.SEAT_UNAVAILABLE,
        errorMessage: '无可用座位',
      };
      // 轮次级日志行（无 bookSeats 的轮次）：此后继续重试 → fire-and-forget
      this.writeAttemptLog(
        {
          taskId: task.id,
          accountId: task.accountId,
          seatId: '-',
          result: AttemptResult.FAILED,
          errorMsg: result.errorMessage,
          searchStartMs: timing.searchStartMs,
          searchEndMs: timing.searchEndMs,
        },
        false,
      );
      return { ...result, timing };
    }

    // 依次尝试候选座位
    for (const seatId of candidates) {
      const bookStartMs = Date.now();
      const bookResult = await this.hduLibraryClient.bookSeats({
        beginTime: task.beginTime,
        duration: task.duration,
        seats: [seatId],
        is_recommend: 0,
        api_time: Math.floor(Date.now() / 1000),
        seatBookers: [searchResult.userInfoId],
      }, task.accountId, task.id);
      const bookEndMs = Date.now();
      timing.books.push({ seatId, startMs: bookStartMs, endMs: bookEndMs });

      if (bookResult.success) {
        // 记录成功尝试日志（含耗时埋点）
        // 成功后不再发请求 → 阻塞落盘
        await this.writeAttemptLog(
          {
            taskId: task.id,
            accountId: task.accountId,
            seatId,
            result: AttemptResult.SUCCESS,
            searchStartMs: timing.searchStartMs,
            searchEndMs: timing.searchEndMs,
            bookStartMs,
            bookEndMs,
          },
          true,
        );

        const seat = searchResult.seats.find((s) => s.id === seatId);
        return {
          success: true,
          bookedSeatId: seatId,
          seatTitle: seat?.title,
          timing,
        };
      }

      // 记录失败尝试日志（原始 errorMessage 保留复盘依据；含耗时埋点）
      // 此后可能换座或外层重试 → fire-and-forget
      this.writeAttemptLog(
        {
          taskId: task.id,
          accountId: task.accountId,
          seatId,
          result: AttemptResult.FAILED,
          errorMsg: bookResult.errorMessage,
          searchStartMs: timing.searchStartMs,
          searchEndMs: timing.searchEndMs,
          bookStartMs,
          bookEndMs,
        },
        false,
      );

      const errorCategory = this.mapBookErrorToCategory(bookResult.errorCode);

      // 座位被占 → 实时提醒一次，然后换下一个候选座位
      // 提醒 fire-and-forget：此后还要继续尝试下一个候选座位
      if (errorCategory === ErrorCategory.SEAT_UNAVAILABLE) {
        const takenSeat = searchResult.seats.find((s) => s.id === seatId);
        if (takenSeat && !notifiedTakenSeats.has(seatId)) {
          notifiedTakenSeats.add(seatId);
          void this.notifySeatTaken(task, takenSeat.title);
        }
        continue;
      }

      // 其他错误 → 返回，交由外层循环判断是否可重试
      return {
        success: false,
        errorCategory,
        errorMessage: bookResult.errorMessage,
        timing,
      };
    }

    // 所有候选座位均被占用
    return {
      success: false,
      errorCategory: ErrorCategory.SEAT_UNAVAILABLE,
      errorMessage: '所有候选座位均被占用',
      timing,
    };
  }

  /**
   * 将 BookErrorCode 映射为 ErrorCategory
   */
  private mapBookErrorToCategory(code?: BookErrorCode): ErrorCategory {
    switch (code) {
      case BookErrorCode.SEAT_TAKEN:
        return ErrorCategory.SEAT_UNAVAILABLE;
      case BookErrorCode.BLACKLISTED:
        return ErrorCategory.BLACKLIST;
      case BookErrorCode.NOT_LOGIN:
        // 登录态失效：外层循环会调用 refreshSession 后重试
        return ErrorCategory.SESSION_EXPIRED;
      case BookErrorCode.NETWORK_ERROR:
        return ErrorCategory.NETWORK;
      case BookErrorCode.RATE_LIMIT:
        return ErrorCategory.RATE_LIMIT;
      case BookErrorCode.WINDOW_NOT_OPEN:
        return ErrorCategory.WINDOW_NOT_OPEN;
      default:
        return ErrorCategory.UNKNOWN;
    }
  }

  /**
   * 标记任务成功并通知
   */
  private async markSuccess(task: GrabTask, result: GrabResult, totalRounds: number, startMs: number): Promise<void> {
    await this.grabTaskService.updateStatus(task.id, TaskStatus.SUCCESS, {
      seatId: result.bookedSeatId,
      seatTitle: result.seatTitle,
    });
    await this.notification.notify({
      userId: task.accountId,
      taskId: task.id,
      type: 'grab_success',
      data: {
        seatTitle: result.seatTitle,
        categoryId: task.categoryId,
      },
    });

    // 任务终态收尾日志
    this.logger.log(
      JSON.stringify({
        event: 'task_finished',
        taskId: task.id,
        result: 'success',
        seatId: result.bookedSeatId ?? null,
        totalDurationMs: Date.now() - startMs,
        totalRounds,
        ts: Date.now(),
      }),
    );
  }

  /**
   * 标记任务失败并通知
   */
  private async markFailed(task: GrabTask, reason: string, totalRounds: number, startMs: number): Promise<void> {
    await this.grabTaskService.updateStatus(task.id, TaskStatus.FAILED, {
      reason,
    });
    await this.notification.notify({
      userId: task.accountId,
      taskId: task.id,
      type: 'grab_failed',
      data: {
        errorReason: reason,
      },
    });

    // 任务终态收尾日志
    this.logger.log(
      JSON.stringify({
        event: 'task_finished',
        taskId: task.id,
        result: 'failed',
        failureCategory: this.classifyFailureReason(reason),
        reason,
        seatId: null,
        totalDurationMs: Date.now() - startMs,
        totalRounds,
        ts: Date.now(),
      }),
    );
  }

  /**
   * 将失败原因文本分类为结构化类别，便于统计分析
   */
  private classifyFailureReason(reason: string): string {
    if (reason.includes('超出时间窗口')) {
      return 'timeout';
    }
    if (reason.includes('超出可预约座位时间范围')) {
      return 'window_not_open';
    }
    if (reason.includes('已尝试') && reason.includes('次后放弃')) {
      return 'retry_exhausted';
    }
    if (reason.includes('未知错误重试达')) {
      return 'unknown_retry_limit';
    }
    if (reason.includes('登录态刷新失败')) {
      return 'login_failed';
    }
    if (reason.includes('不可重试错误')) {
      return 'non_retryable';
    }
    return 'other';
  }

  /**
   * 实时提醒用户：某个座位已被他人占用，任务仍在继续尝试
   * 1. 写任务 result.takenSeats → 前端轮询任务状态即可实时看到
   * 2. 发 seat_taken 通知（mock 阶段落 notifications 表，后续接微信推送）
   * 通知失败不影响抢座主流程，单独 try/catch 兜底
   */
  private async notifySeatTaken(
    task: GrabTask,
    seatTitle: string,
  ): Promise<void> {
    try {
      await this.grabTaskService.recordSeatTaken(task.id, seatTitle);
    } catch (e) {
      this.logger.warn(
        `[记录被占座位失败] taskId=${task.id} seat=${seatTitle} message=${(e as Error).message}`,
      );
    }

    try {
      await this.notification.notify({
        userId: task.accountId,
        taskId: task.id,
        type: 'seat_taken',
        data: {
          seatTitle,
          categoryId: task.categoryId,
        },
      });
    } catch (e) {
      this.logger.warn(
        `[seat_taken 通知失败] taskId=${task.id} seat=${seatTitle} message=${(e as Error).message}`,
      );
    }
  }

  /**
   * 写尝试日志
   * @param blocking true=此后不再发请求，阻塞等待落盘完成；
   *                 false=此后还要继续发请求，fire-and-forget 不阻塞热路径
   */
  private writeAttemptLog(
    params: CreateAttemptLogParams,
    blocking: boolean,
  ): Promise<void> {
    if (!blocking) {
      this.fireAndForget(
        this.attemptLogService.log(params),
        `attemptLog taskId=${params.taskId} seatId=${params.seatId}`,
      );
      return Promise.resolve();
    }
    return this.attemptLogService.log(params).then(() => undefined);
  }

  /**
   * fire-and-forget：发出异步写入后立即返回，异常仅告警、绝不中断主流程
   * 仅用于"此后还要继续发请求"的写入（开始通知、状态、尝试计数、过程日志）
   */
  private fireAndForget(action: unknown, what: string): void {
    Promise.resolve(action).catch((e) => {
      this.logger.warn(
        `[异步写入失败已忽略] ${what} message=${(e as Error).message}`,
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 可中断等待：在等待重试间隔期间，每隔 500ms 轮询一次取消标记。
   * 若期间任务被用户取消则立即返回 true，否则等满 ms 后返回 false。
   */
  private async sleepInterruptible(
    ms: number,
    taskId: string,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.grabTaskService.isCancellationRequested(taskId)) {
        return true;
      }
      await this.sleep(Math.min(500, deadline - Date.now()));
    }
    return false;
  }
}
