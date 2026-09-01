import { GrabSeatWorker } from './grab-seat-worker.service';
import type { GrabTask } from '../grab-task/entities/grab-task.entity';
import { TaskStatus } from '../grab-task/entities/grab-task.entity';
import type { PreparseEntry } from './seat-preparse.service';

/**
 * GrabSeatWorker 预解析缓存生命周期测试：
 * 验证任务进入终态（成功/失败/取消/异常）后统一调用 seatPreparse.invalidate(task.id)，
 * 且缓存缺失时正常回退 search-first 链路（searchSeats → seat selection → bookSeats）不受影响。
 */
describe('GrabSeatWorker 预解析缓存清理', () => {
  let worker: GrabSeatWorker;
  let searchSeats: jest.Mock;
  let bookSeats: jest.Mock;
  let selectCandidates: jest.Mock;
  let preparseGet: jest.Mock;
  let preparseCall: jest.Mock;
  let invalidate: jest.Mock;
  let updateStatus: jest.Mock;
  let incrementAttempts: jest.Mock;
  let isCancellationRequested: jest.Mock;
  let recordSeatTaken: jest.Mock;
  let attemptLog: jest.Mock;
  let refreshSession: jest.Mock;
  let notify: jest.Mock;

  const makeTask = (overrides: Partial<GrabTask> = {}): GrabTask =>
    ({
      id: 'task-1',
      accountId: 'acc-1',
      categoryId: '591',
      contentId: '3',
      roomId: null,
      roomName: null,
      beginTime: 1700000000,
      duration: 7200,
      seatPreference: [],
      strictMode: false,
      triggerAt: Math.floor(Date.now() / 1000),
      status: 'pending',
      attempts: 0,
      result: null,
      ...overrides,
    }) as GrabTask;

  const makeSearchResult = () => ({
    room: { id: 'room-1', name: '三楼自习室', plan: '', width: 0, height: 0 },
    seats: [
      {
        id: 'seat-001',
        title: '001',
        state: 0,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        hasSocket: false,
      },
    ],
    recommendedSeats: [],
    allRooms: [],
    userInfoId: 'user-1',
    rawUiType: 'test',
  });

  const makePreparseEntry = (taskId: string): PreparseEntry => ({
    taskId,
    accountId: 'acc-1',
    userInfoId: 'user-1',
    roomId: 'room-1',
    roomName: '三楼自习室',
    seats: [{ title: '001', seatId: 'seat-001' }],
    unresolvedTitles: [],
    autoPickedRoom: false,
    resolvedAt: Date.now(),
  });

  beforeEach(() => {
    searchSeats = jest.fn().mockResolvedValue(makeSearchResult());
    bookSeats = jest.fn().mockResolvedValue({ success: true });
    selectCandidates = jest.fn().mockReturnValue(['seat-001']);
    preparseGet = jest.fn().mockReturnValue(null);
    preparseCall = jest.fn().mockResolvedValue({ entry: null });
    invalidate = jest.fn();
    updateStatus = jest.fn().mockResolvedValue(undefined);
    incrementAttempts = jest.fn().mockResolvedValue(undefined);
    isCancellationRequested = jest.fn().mockReturnValue(false);
    recordSeatTaken = jest.fn().mockResolvedValue(undefined);
    attemptLog = jest.fn().mockResolvedValue(undefined);
    refreshSession = jest.fn().mockResolvedValue(undefined);
    notify = jest.fn().mockResolvedValue(undefined);

    worker = new GrabSeatWorker(
      { searchSeats, bookSeats } as any,
      { selectCandidates } as any,
      { get: preparseGet, preparse: preparseCall, invalidate } as any,
      {
        updateStatus,
        incrementAttempts,
        isCancellationRequested,
        recordSeatTaken,
      } as any,
      { log: attemptLog } as any,
      { refreshSession } as any,
      { notify } as any,
    );
  });

  it('Case 1: 正常成功路径 —— 终态后缓存被清理', async () => {
    const task = makeTask();

    await worker.executeGrab(task);

    expect(searchSeats).toHaveBeenCalled();
    expect(bookSeats).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 2: 正常失败路径（不可重试业务错误）—— 终态后缓存被清理', async () => {
    const task = makeTask();
    searchSeats.mockRejectedValue(
      Object.assign(new Error('预约人数过多'), { isBusinessError: true }),
    );

    await worker.executeGrab(task);

    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.FAILED,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 3: 运行中取消路径 —— 退出后缓存被清理', async () => {
    const task = makeTask();
    isCancellationRequested.mockReturnValue(true);

    await worker.executeGrab(task);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 4: 异常退出路径 —— executeGrab 抛出后 finally 仍清理缓存', async () => {
    const task = makeTask();
    selectCandidates.mockImplementation(() => {
      throw new Error('seat selection boom');
    });

    await expect(worker.executeGrab(task)).rejects.toThrow('seat selection boom');

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 6a: 缓存不存在/预解析失败 —— 正常回退 search-first，不因缓存缺失而失败', async () => {
    const task = makeTask({ strictMode: true, seatPreference: ['001'] });
    preparseGet.mockReturnValue(null);
    preparseCall.mockResolvedValue({ entry: null, failReason: '座位搜索失败' });

    await worker.executeGrab(task);

    // 缓存缺失 → 正常走 searchSeats → 选座 → bookSeats，任务成功
    expect(preparseGet).toHaveBeenCalledWith('task-1');
    expect(searchSeats).toHaveBeenCalled();
    expect(selectCandidates).toHaveBeenCalled();
    expect(bookSeats).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 6b: 盲抢路径（缓存命中）—— 不经 searchSeats 直发 bookSeats，终态后缓存被清理', async () => {
    // triggerAt 设为过去：跳过盲抢起始偏移等待，避免测试真实 sleep
    const task = makeTask({
      strictMode: true,
      seatPreference: ['001'],
      triggerAt: Math.floor(Date.now() / 1000) - 10,
    });
    preparseGet.mockReturnValue(makePreparseEntry('task-1'));

    await worker.executeGrab(task);

    expect(preparseGet).toHaveBeenCalledWith('task-1');
    expect(searchSeats).not.toHaveBeenCalled();
    expect(bookSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        seats: ['seat-001'],
        seatBookers: ['user-1'],
      }),
      'acc-1',
      'task-1',
    );
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case 6c: 缓存被清理后再次执行同一任务 —— search-first 链路行为不变', async () => {
    const task = makeTask();
    searchSeats.mockClear();
    bookSeats.mockClear();

    await worker.executeGrab(task);
    expect(invalidate).toHaveBeenCalledWith('task-1');

    // 第二次执行（缓存已被 invalidate / 不存在）：仍正常 search-first 成功
    invalidate.mockClear();
    updateStatus.mockClear();
    searchSeats.mockClear();
    bookSeats.mockClear();

    await worker.executeGrab(task);

    expect(searchSeats).toHaveBeenCalledTimes(1);
    expect(bookSeats).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });
});
