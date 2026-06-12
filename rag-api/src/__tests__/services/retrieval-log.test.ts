import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock('../../services/cache', () => ({
  cacheService: { getClient: mocks.getClient },
}));

import { retrievalLog } from '../../services/retrieval-log';

function createFakeRedis() {
  return {
    rpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
    zadd: vi.fn().mockResolvedValue(1),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zrangebyscore: vi.fn().mockResolvedValue([]),
  };
}

describe('RetrievalLog', () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    mocks.getClient.mockReturnValue(redis);
  });

  describe('log', () => {
    it('appends a JSON entry with capped snippets and sets TTL + compaction', async () => {
      await retrievalLog.log({
        projectName: 'proj',
        sessionId: 'sess-1',
        surface: 'recall',
        memoryIds: ['m1', 'm2'],
        snippets: ['short one', 'y'.repeat(400)],
        query: 'how does auth work',
      });

      expect(redis.rpush).toHaveBeenCalledOnce();
      const [key, raw] = redis.rpush.mock.calls[0];
      expect(key).toBe('retrieval-log:proj:sess-1');
      const entry = JSON.parse(raw);
      expect(entry).toMatchObject({
        projectName: 'proj',
        sessionId: 'sess-1',
        surface: 'recall',
        memoryIds: ['m1', 'm2'],
        query: 'how does auth work',
      });
      expect(entry.snippets[0]).toBe('short one');
      expect(entry.snippets[1].length).toBeLessThanOrEqual(150);
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);

      // Compaction + ~90d TTL
      expect(redis.ltrim).toHaveBeenCalledWith(key, -500, -1);
      expect(redis.expire).toHaveBeenCalledWith(key, 90 * 24 * 60 * 60);
      // recall surface does NOT touch the digest index
      expect(redis.zadd).not.toHaveBeenCalled();
    });

    it('indexes digest deliveries per project (for memory-roi aggregation)', async () => {
      await retrievalLog.log({
        projectName: 'proj',
        sessionId: 'sess-1',
        surface: 'digest',
        memoryIds: ['m1', 'm2', 'm3'],
        snippets: ['a', 'b', 'c'],
      });

      expect(redis.zadd).toHaveBeenCalledOnce();
      const [indexKey, score, member] = redis.zadd.mock.calls[0];
      expect(indexKey).toBe('retrieval-log:proj:digest-index');
      expect(typeof score).toBe('number');
      expect(member).toMatch(/^sess-1\|\d+\|3$/);
      expect(redis.zremrangebyscore).toHaveBeenCalled();
    });

    it('no-ops when Redis is unavailable', async () => {
      mocks.getClient.mockReturnValue(null);
      await expect(
        retrievalLog.log({
          projectName: 'proj',
          sessionId: 's',
          surface: 'recall',
          memoryIds: [],
          snippets: [],
        })
      ).resolves.toBeUndefined();
    });

    it('never rejects even when Redis throws (fire-and-forget safety)', async () => {
      redis.rpush.mockRejectedValue(new Error('redis down'));
      await expect(
        retrievalLog.log({
          projectName: 'proj',
          sessionId: 's',
          surface: 'digest',
          memoryIds: ['m1'],
          snippets: ['x'],
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('getSessionRetrievals', () => {
    it('returns parsed entries sorted oldest-first', async () => {
      const older = {
        projectName: 'proj',
        sessionId: 'sess-1',
        surface: 'digest',
        memoryIds: ['m1'],
        snippets: ['a'],
        timestamp: '2026-06-12T08:00:00.000Z',
      };
      const newer = {
        ...older,
        surface: 'recall',
        query: 'q',
        timestamp: '2026-06-12T09:00:00.000Z',
      };
      // Stored out of order — must come back oldest-first
      redis.lrange.mockResolvedValue([JSON.stringify(newer), JSON.stringify(older), 'not-json']);

      const entries = await retrievalLog.getSessionRetrievals('proj', 'sess-1');

      expect(redis.lrange).toHaveBeenCalledWith('retrieval-log:proj:sess-1', 0, -1);
      expect(entries).toHaveLength(2); // malformed entry skipped
      expect(entries[0].surface).toBe('digest');
      expect(entries[1].surface).toBe('recall');
    });

    it('returns [] without Redis', async () => {
      mocks.getClient.mockReturnValue(null);
      expect(await retrievalLog.getSessionRetrievals('proj', 's')).toEqual([]);
    });
  });

  describe('getDigestStats', () => {
    it('aggregates deliveries / nonEmpty / distinct sessions over the window', async () => {
      redis.zrangebyscore.mockResolvedValue([
        'sess-1|1760000000000|3',
        'sess-1|1760000100000|0',
        'sess-2|1760000200000|5',
      ]);

      const stats = await retrievalLog.getDigestStats('proj', 30);

      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        'retrieval-log:proj:digest-index',
        expect.any(Number),
        '+inf'
      );
      expect(stats).toEqual({
        deliveries: 3,
        nonEmptyDeliveries: 2,
        sessionsWithDigest: 2,
      });
    });

    it('returns zeros without Redis', async () => {
      mocks.getClient.mockReturnValue(null);
      expect(await retrievalLog.getDigestStats('proj', 30)).toEqual({
        deliveries: 0,
        nonEmptyDeliveries: 0,
        sessionsWithDigest: 0,
      });
    });
  });
});
