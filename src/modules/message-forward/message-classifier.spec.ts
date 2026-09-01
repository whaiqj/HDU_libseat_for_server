import {
  classifyMessageByTitle,
} from './message-classifier';
import {
  AppointMessageType,
  MessageLevel,
} from '../hdu-library/dto/appoint-messages.dto';

describe('MessageClassifier（消息分类器）', () => {
  describe('已验证标题的精准匹配', () => {
    it('「签到提醒」→ 普通签到提醒 / normal 级别', () => {
      const result = classifyMessageByTitle('签到提醒');
      expect(result.type).toBe(AppointMessageType.CHECKIN_REMINDER);
      expect(result.level).toBe(MessageLevel.NORMAL);
      expect(result.emoji).toBeTruthy();
    });

    it('「签到提醒（二次提醒）」→ 二次提醒 / urgent 级别', () => {
      const result = classifyMessageByTitle('签到提醒（二次提醒）');
      expect(result.type).toBe(AppointMessageType.CHECKIN_SECOND_REMINDER);
      expect(result.level).toBe(MessageLevel.URGENT);
      expect(result.emoji).toBeTruthy();
    });

    it('「超时未签到」→ 超时违约 / alert 级别', () => {
      const result = classifyMessageByTitle('超时未签到');
      expect(result.type).toBe(AppointMessageType.CHECKIN_OVERDUE);
      expect(result.level).toBe(MessageLevel.ALERT);
      expect(result.emoji).toBeTruthy();
    });
  });

  describe('未知标题降级兜底（零漏消息）', () => {
    it('未识别标题（如「暂离提醒」）降级为 OTHER / normal，不丢弃', () => {
      const result = classifyMessageByTitle('暂离提醒');
      expect(result.type).toBe(AppointMessageType.OTHER);
      expect(result.level).toBe(MessageLevel.NORMAL);
      expect(result.emoji).toBeTruthy();
    });

    it('未识别标题（如「座位被暂座」）降级为 OTHER / normal', () => {
      const result = classifyMessageByTitle('座位被暂座');
      expect(result.type).toBe(AppointMessageType.OTHER);
      expect(result.level).toBe(MessageLevel.NORMAL);
    });

    it('空标题降级为 OTHER / normal', () => {
      const result = classifyMessageByTitle('');
      expect(result.type).toBe(AppointMessageType.OTHER);
      expect(result.level).toBe(MessageLevel.NORMAL);
    });
  });
});
