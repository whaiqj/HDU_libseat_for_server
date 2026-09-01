import { SeatPreparseService } from './seat-preparse.service';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';
import type { GrabTask } from '../grab-task/entities/grab-task.entity';

/** 与 seat-preparse.service.ts 内的 CACHE_TTL_MS 保持一致 */
const CACHE_TTL_MS = 10 * 60 * 1000;

describe('SeatPreparseService 缓存生命周期', () => {
  let service: SeatPreparseService;
  let searchSeats: jest.Mock;

  const makeTask = (id: string): GrabTask =>
    ({
      id,
      accountId: 'acc-1',
      categoryId: '591',
      contentId: '3',
      roomId: 'room-1',
      roomName: '三楼自习室',
      beginTime: 1700000000,
      duration: 7200,
      seatPreference: ['001'],
      strictMode: true,
      triggerAt: 1700000300,
      status: 'pending',
      attempts: 0,
      result: null,
    }) as GrabTask;

  const seat = () => ({
    id: 'seat-001',
    title: '001',
    state: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    hasSocket: false,
  });

  const makeSearchResult = () => ({
    room: { id: 'room-1', name: '三楼自习室', plan: '', width: 0, height: 0 },
    seats: [seat()],
    recommendedSeats: [],
    allRooms: [{ id: 'room-1', name: '三楼自习室', seats: [seat()] }],
    userInfoId: 'user-1',
    rawUiType: 'test',
  });

  /** 直接访问进程内缓存（测试 TTL 清扫用） */
  const cache = (): Map<string, { resolvedAt: number }> =>
    (service as any).cache as Map<string, { resolvedAt: number }>;

  beforeEach(() => {
    searchSeats = jest.fn().mockResolvedValue(makeSearchResult());
    service = new SeatPreparseService({
      searchSeats,
    } as unknown as HduLibraryClientService);
  });

  it('preparse 成功后写入缓存，get 可读取未过期条目', async () => {
    const outcome = await service.preparse(makeTask('task-a'));

    expect(outcome.entry).not.toBeNull();
    expect(outcome.entry!.seats).toEqual([
      { title: '001', seatId: 'seat-001' },
    ]);
    expect(cache().has('task-a')).toBe(true);
    expect(service.get('task-a')?.seats[0].seatId).toBe('seat-001');
  });

  it('Case 5: preparse 写入新缓存前清扫已过期条目', async () => {
    await service.preparse(makeTask('task-a'));
    expect(cache().has('task-a')).toBe(true);

    // 将 task-a 的条目回拨为已过期
    cache().get('task-a')!.resolvedAt = Date.now() - CACHE_TTL_MS - 1;

    await service.preparse(makeTask('task-b'));

    expect(cache().has('task-a')).toBe(false);
    expect(cache().has('task-b')).toBe(true);
  });

  it('TTL 清扫不会删除未过期条目', async () => {
    await service.preparse(makeTask('task-a'));
    await service.preparse(makeTask('task-b'));

    // task-a / task-b 均在有效期内，不应被清扫
    expect(cache().has('task-a')).toBe(true);
    expect(cache().has('task-b')).toBe(true);
    expect(service.get('task-a')).not.toBeNull();
    expect(service.get('task-b')).not.toBeNull();
  });

  it('get 对已过期条目返回 null 并惰性删除（原行为保持不变）', async () => {
    await service.preparse(makeTask('task-a'));
    cache().get('task-a')!.resolvedAt = Date.now() - CACHE_TTL_MS - 1;

    expect(service.get('task-a')).toBeNull();
    expect(cache().has('task-a')).toBe(false);
  });

  it('invalidate 删除指定任务的缓存条目', async () => {
    await service.preparse(makeTask('task-a'));
    expect(cache().has('task-a')).toBe(true);

    service.invalidate('task-a');

    expect(cache().has('task-a')).toBe(false);
    expect(service.get('task-a')).toBeNull();
  });

  it('invalidate 对不存在的 taskId 是安全的 no-op', () => {
    expect(() => service.invalidate('not-exist')).not.toThrow();
  });
});
