import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  INotificationService,
  NotificationPayload,
} from './notification.service';
import { AccountService } from '../account/account.service';
import {
  buildPreReminderMessage,
  buildTaskStartedMessage,
  buildSeatTakenMessage,
  buildSuccessMessage,
  buildFailedMessage,
  NotificationTemplateData,
} from './notification-templates';

/** WxPusher 消息推送接口（Topic 广播模式） */
const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message';

/** WxPusher 返回成功时的业务码 */
const WXPUSHER_SUCCESS_CODE = 1000;

/**
 * WxPusherNotificationService
 * 通过 WxPusher Topic 广播模式把抢座关键节点推送到微信。
 * 所有方法内部 try-catch：推送失败只 logger.warn，不 throw、不重试，
 * 绝不能影响抢座主流程。
 */
@Injectable()
export class WxPusherNotificationService implements INotificationService {
  private readonly logger = new Logger(WxPusherNotificationService.name);

  private readonly appToken: string;
  private readonly topicId: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly accountService: AccountService,
  ) {
    this.appToken = process.env.WXPUSHER_APP_TOKEN ?? '';
    this.topicId = process.env.WXPUSHER_TOPIC_ID ?? '';
  }

  async notify(payload: NotificationPayload): Promise<void> {
    try {
      const templateData = await this.toTemplateData(payload);
      const markdown = this.render(payload.type, templateData);
      if (!markdown) {
        // session_precheck_failed / preparse_warning 等非 5 类事件不推微信
        return;
      }
      await this.send(markdown, payload.taskId);
    } catch (e) {
      this.logger.warn(
        `[WxPusher 推送失败] taskId=${payload.taskId} type=${payload.type} message=${(e as Error).message}`,
      );
    }
  }

  /** 把 payload 组装为模板统一入参，账号名按 payload.userId（即 accountId）查询 */
  private async toTemplateData(
    payload: NotificationPayload,
  ): Promise<NotificationTemplateData> {
    return {
      taskId: payload.taskId,
      accountUsername: await this.resolveUsername(payload.userId),
      room: payload.meta?.room ?? '未指定',
      date: payload.meta?.date ?? '',
      timeStart: payload.meta?.timeStart ?? '',
      timeEnd: payload.meta?.timeEnd ?? '',
      seatId: payload.data?.seatTitle,
      retryRound: payload.meta?.retryRound,
      failReason: payload.data?.errorReason,
    };
  }

  /** 解析学号：查不到账号时回退为 accountId，保证字段非空 */
  private async resolveUsername(accountId: string): Promise<string> {
    try {
      const account = await this.accountService.findById(accountId);
      return account?.username ?? accountId;
    } catch (e) {
      this.logger.warn(
        `[解析账号失败] accountId=${accountId} message=${(e as Error).message}`,
      );
      return accountId;
    }
  }

  /** 事件类型 → Markdown 模板（仅 5 类事件推送微信） */
  private render(
    type: NotificationPayload['type'],
    d: NotificationTemplateData,
  ): string | null {
    switch (type) {
      case 'pre_reminder':
        return buildPreReminderMessage(d);
      case 'grab_started':
        return buildTaskStartedMessage(d);
      case 'seat_taken':
        return buildSeatTakenMessage(d);
      case 'grab_success':
        return buildSuccessMessage(d);
      case 'grab_failed':
        return buildFailedMessage(d);
      default:
        return null;
    }
  }

  /** 调 WxPusher API 发送 Markdown 消息（Topic 广播），失败抛出由 notify 兜底 */
  private async send(markdown: string, taskId: string): Promise<void> {
    if (!this.appToken || !this.topicId) {
      this.logger.warn(`[WxPusher 未配置] 跳过推送 taskId=${taskId}`);
      return;
    }

    const response = await firstValueFrom(
      this.httpService.post(WXPUSHER_SEND_URL, {
        appToken: this.appToken,
        content: markdown,
        contentType: 3,
        topicIds: [Number(this.topicId)],
      }),
    );
    const body = response.data;
    if (body?.code !== WXPUSHER_SUCCESS_CODE) {
      throw new Error(`code=${body?.code} msg=${body?.msg ?? ''}`);
    }
  }
}
