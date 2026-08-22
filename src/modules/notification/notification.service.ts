/**
 * 通知内容
 */
export interface NotificationPayload {
  userId: string;
  taskId: string;
  type: 'grab_success' | 'grab_failed' | 'grab_started' | 'seat_taken' | 'session_precheck_failed';
  data: {
    seatTitle?: string;
    categoryId?: string;
    errorReason?: string;
  };
}

/**
 * 通知服务接口
 * 抢座结果实时触达用户
 */
export interface INotificationService {
  notify(payload: NotificationPayload): Promise<void>;
}