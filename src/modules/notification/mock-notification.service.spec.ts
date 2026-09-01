import { MockNotificationService } from './mock-notification.service';
import type { NotificationPayload } from './notification.service';

describe('MockNotificationService（空 taskId 兼容）', () => {
  function createService() {
    const notificationRepo = {
      create: jest.fn((x) => x),
      save: jest.fn().mockResolvedValue({}),
    };
    return {
      service: new MockNotificationService(notificationRepo as any),
      notificationRepo,
    };
  }

  it('appoint_message 通知无 taskId：写库 taskId=null，不报错', async () => {
    const ctx = createService();
    const payload: NotificationPayload = {
      userId: 'acc-1',
      type: 'appoint_message',
      data: { messageTitle: '签到提醒', messageLevel: 'normal' },
    };

    await expect(ctx.service.notify(payload)).resolves.not.toThrow();

    expect(ctx.notificationRepo.create).toHaveBeenCalledWith({
      userId: 'acc-1',
      taskId: null,
      type: 'appoint_message',
      data: { messageTitle: '签到提醒', messageLevel: 'normal' },
    });
    expect(ctx.notificationRepo.save).toHaveBeenCalledTimes(1);
  });

  it('带 taskId 的既有通知：taskId 原样写库', async () => {
    const ctx = createService();
    await ctx.service.notify({
      userId: 'acc-1',
      taskId: 'task-1',
      type: 'grab_success',
      data: { seatTitle: '3-015' },
    });

    expect(ctx.notificationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });
});
