/**
 * 通知内容
 */
export interface NotificationPayload {
  userId: string;
  taskId: string;
  type:
    | 'grab_success'
    | 'grab_failed'
    | 'grab_started'
    | 'seat_taken'
    | 'pre_reminder'
    | 'session_precheck_failed'
    | 'preparse_warning';
  data: {
    seatTitle?: string;
    categoryId?: string;
    errorReason?: string;
  };
  /**
   * 任务级上下文（房间 / 日期 / 时间段 / 重试轮次）。
   * 由调用处通过 buildTaskMeta 派生，供 WxPusher 模板排版使用；mock 实现忽略。
   */
  meta?: NotificationMeta;
}

/** 通知模板渲染所需的额外任务上下文 */
export interface NotificationMeta {
  /** 房间名（任务未锁定房间时为空） */
  room?: string;
  /** 预约日期（北京时间 yyyy-MM-dd） */
  date?: string;
  /** 预约开始时刻（北京时间 HH:mm） */
  timeStart?: string;
  /** 预约结束时刻（北京时间 HH:mm） */
  timeEnd?: string;
  /** 换座重试轮次（seat_taken 用） */
  retryRound?: number;
}

/**
 * 通知服务接口
 * 抢座结果实时触达用户
 */
export interface INotificationService {
  notify(payload: NotificationPayload): Promise<void>;
}
