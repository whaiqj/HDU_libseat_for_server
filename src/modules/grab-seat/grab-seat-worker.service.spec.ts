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

/**
 * search-first 路径 roomId 房间锁定测试：
 * 任务指定 roomId 时，座位快照/占座提醒/候选筛选必须基于 allRooms 目录中锁定的房间，
 * 而非 searchSeats 返回的推荐房间（多房间分类下推荐房间会轮换）。
 * 复现线上问题：用户选四楼 078 号，推荐房间轮换到二楼东（078 被占），
 * 被误报"占座"并分配到二楼东的其他座位。
 */
describe('GrabSeatWorker search-first 房间锁定（roomId）', () => {
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

  /** 推荐房间 = 二楼东（078 被占），allRooms 目录含四楼（078 空闲） */
  const makeSearchResult = () => ({
    room: { id: 'room-2', name: '二楼东', plan: '', width: 0, height: 0 },
    seats: [
      { id: 'seat-201', title: '078', state: 1, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
      { id: 'seat-202', title: '079', state: 0, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
    ],
    recommendedSeats: [],
    allRooms: [
      {
        id: 'room-2',
        name: '二楼东',
        seats: [
          { id: 'seat-201', title: '078', state: 1, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
          { id: 'seat-202', title: '079', state: 0, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
        ],
      },
      {
        id: 'room-4',
        name: '四楼',
        seats: [
          { id: 'seat-401', title: '078', state: 0, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
          { id: 'seat-402', title: '079', state: 0, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
        ],
      },
    ],
    userInfoId: 'user-1',
    rawUiType: 'test',
  });

  beforeEach(() => {
    searchSeats = jest.fn().mockResolvedValue(makeSearchResult());
    bookSeats = jest.fn().mockResolvedValue({ success: true });
    // 默认按真实策略语义：返回传入座位表中的可用座位
    selectCandidates = jest.fn().mockImplementation((result: any) =>
      result.seats.filter((s: any) => s.state === 0).map((s: any) => s.id),
    );
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

  it('Case A1: 指定 roomId（四楼）—— 候选筛选与预约均基于锁定房间，二楼东同名座位被占不误报', async () => {
    const task = makeTask({
      roomId: 'room-4',
      roomName: '四楼',
      seatPreference: ['078'],
      strictMode: false,
    });

    await worker.executeGrab(task);

    // selectCandidates 收到的是四楼的座位表（seat-401/402），而非推荐房间二楼东
    expect(selectCandidates).toHaveBeenCalledTimes(1);
    const [selectArg] = selectCandidates.mock.calls[0];
    expect(selectArg.seats.map((s: any) => s.id)).toEqual(['seat-401', 'seat-402']);

    // 预约的是四楼座位
    expect(bookSeats).toHaveBeenCalledWith(
      expect.objectContaining({ seats: ['seat-401'] }),
      'acc-1',
      'task-1',
    );

    // 二楼东 078 被占但四楼 078 空闲 → 不误报占座
    expect(recordSeatTaken).not.toHaveBeenCalled();

    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
  });

  it('Case A2: 指定 roomId 且该房间在锁定房间内被占 —— 基于锁定房间占位表提醒一次', async () => {
    const searchResult = makeSearchResult();
    // 四楼 078 也被占
    const room4 = searchResult.allRooms.find((r: any) => r.id === 'room-4');
    room4.seats = room4.seats.map((s: any) =>
      s.title === '078' ? { ...s, state: 1 } : s,
    );
    searchSeats.mockResolvedValue(searchResult);

    const task = makeTask({
      roomId: 'room-4',
      roomName: '四楼',
      seatPreference: ['078'],
      strictMode: false,
    });

    await worker.executeGrab(task);

    // 四楼 078 被占 → 提醒（seatTitle 来自锁定房间座位表）
    expect(recordSeatTaken).toHaveBeenCalledWith('task-1', '078');
  });

  it('Case A3: 指定 roomId 但推荐房间就是该房间（allRooms 为空）—— 退化使用推荐座位表，正常预约', async () => {
    const searchResult = makeSearchResult();
    searchResult.room = { id: 'room-4', name: '四楼', plan: '', width: 0, height: 0 };
    searchResult.seats = [
      { id: 'seat-401', title: '078', state: 0, x: 0, y: 0, w: 0, h: 0, hasSocket: false },
    ];
    searchResult.allRooms = [];
    searchSeats.mockResolvedValue(searchResult);

    const task = makeTask({
      roomId: 'room-4',
      roomName: '四楼',
      seatPreference: ['078'],
      strictMode: false,
    });

    await worker.executeGrab(task);

    expect(bookSeats).toHaveBeenCalledWith(
      expect.objectContaining({ seats: ['seat-401'] }),
      'acc-1',
      'task-1',
    );
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.SUCCESS,
      expect.anything(),
    );
  });

  it('Case A4: 指定 roomId 但房间不在目录中 —— 任务失败，不预约任何座位', async () => {
    const task = makeTask({
      roomId: 'room-x',
      roomName: '不存在的房间',
      seatPreference: ['078'],
      strictMode: false,
    });

    await worker.executeGrab(task);

    expect(bookSeats).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.FAILED,
      expect.objectContaining({
        reason: '指定房间（roomId=room-x）不在房间目录中',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('task-1');
  });

  it('Case A5: 未指定 roomId —— 行为不变，仍使用推荐房间座位表', async () => {
    const task = makeTask({ seatPreference: ['078'], strictMode: false });

    await worker.executeGrab(task);

    const [selectArg] = selectCandidates.mock.calls[0];
    expect(selectArg.seats.map((s: any) => s.id)).toEqual(['seat-201', 'seat-202']);

    // 二楼东 078 被占 → 按现状提醒（未指定房间时以推荐房间为准）
    expect(recordSeatTaken).toHaveBeenCalledWith('task-1', '078');
  });
});
