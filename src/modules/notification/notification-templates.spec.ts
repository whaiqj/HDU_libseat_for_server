import {
  buildAppointMessageNotification,
} from './notification-templates';
import { MessageLevel } from '../hdu-library/dto/appoint-messages.dto';

const BASE_DATA = {
  accountUsername: '22010123',
  title: '签到提醒',
  desc: '您预约的座位请及时签到',
  time: '2026-09-01 10:00',
  emoji: '🔔',
};

describe('buildAppointMessageNotification（图书馆消息分级模板）', () => {
  it('normal 级别渲染普通标题头', () => {
    const markdown = buildAppointMessageNotification({
      ...BASE_DATA,
      level: MessageLevel.NORMAL,
    });
    expect(markdown).toContain('## 🔔 图书馆消息');
    expect(markdown).toContain('**账号**：22010123');
    expect(markdown).toContain('**标题**：🔔 签到提醒');
    expect(markdown).toContain('**时间**：2026-09-01 10:00');
    expect(markdown).toContain('**内容**：您预约的座位请及时签到');
  });

  it('urgent 级别渲染加急标题头', () => {
    const markdown = buildAppointMessageNotification({
      ...BASE_DATA,
      level: MessageLevel.URGENT,
    });
    expect(markdown).toContain('## ⏰ 图书馆消息（加急）');
  });

  it('alert 级别渲染重要警告标题头', () => {
    const markdown = buildAppointMessageNotification({
      ...BASE_DATA,
      level: MessageLevel.ALERT,
    });
    expect(markdown).toContain('## ⚠️ 图书馆消息（重要警告）');
  });

  it('三级模板互不相同', () => {
    const normal = buildAppointMessageNotification({ ...BASE_DATA, level: MessageLevel.NORMAL });
    const urgent = buildAppointMessageNotification({ ...BASE_DATA, level: MessageLevel.URGENT });
    const alert = buildAppointMessageNotification({ ...BASE_DATA, level: MessageLevel.ALERT });
    expect(new Set([normal, urgent, alert]).size).toBe(3);
  });
});
