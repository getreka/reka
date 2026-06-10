import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * In-memory fake of the Redis client surface that memory-versions uses:
 * pipeline (set/lpush/ltrim), lrange, mget, get, set.
 */
const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
}));

const mockClient = vi.hoisted(() => {
  const pipelineOps: Array<() => void> = [];
  return {
    pipeline() {
      const ops: Array<() => void> = [];
      const api: any = {
        set(key: string, val: string) {
          ops.push(() => store.kv.set(key, val));
          return api;
        },
        lpush(key: string, val: string) {
          ops.push(() => {
            const list = store.lists.get(key) ?? [];
            list.unshift(val);
            store.lists.set(key, list);
          });
          return api;
        },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => {
            const list = store.lists.get(key) ?? [];
            store.lists.set(key, list.slice(start, stop + 1));
          });
          return api;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return api;
    },
    async lrange(key: string, start: number, stop: number) {
      const list = store.lists.get(key) ?? [];
      // ioredis stop is inclusive; -1 means end
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async mget(...keys: string[]) {
      return keys.map((k) => store.kv.get(k) ?? null);
    },
    async get(key: string) {
      return store.kv.get(key) ?? null;
    },
    async set(key: string, val: string) {
      store.kv.set(key, val);
      return 'OK';
    },
  };
});

vi.mock('../../services/cache', () => ({
  cacheService: {
    getClient: vi.fn(() => mockClient),
  },
}));

// rollback (lazy dynamic import) re-embeds the snapshot and upserts the point
// directly under its ORIGINAL id — so it touches memory/vector-store/embedding.
const mockGetById = vi.hoisted(() => vi.fn());
vi.mock('../../services/memory', () => ({
  memoryService: {
    getById: mockGetById,
  },
}));

const mockUpsert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: mockUpsert,
  },
}));

const mockEmbed = vi.hoisted(() => vi.fn(async () => [0.1, 0.2, 0.3]));
vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: mockEmbed,
  },
}));

import { memoryVersions } from '../../services/memory-versions';

describe('MemoryVersionsService', () => {
  beforeEach(() => {
    store.kv.clear();
    store.lists.clear();
    mockGetById.mockReset();
    mockGetById.mockResolvedValue(null);
    mockUpsert.mockClear();
    mockEmbed.mockClear();
  });

  describe('record', () => {
    it('appends an immutable version with op, actor, sha256 hash, and snapshot', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'created',
        memoryId: 'mem-1',
        actor: 'api',
        content: 'hello world',
        type: 'note',
        tags: ['a'],
      });

      expect(v).not.toBeNull();
      expect(v!.op).toBe('created');
      expect(v!.actor).toBe('api');
      expect(v!.memoryId).toBe('mem-1');
      expect(v!.content).toBe('hello world');
      expect(v!.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(v!.timestamp).toBeDefined();
    });

    it('defaults actor to api when omitted', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'mem-2',
        content: 'bye',
      });
      expect(v!.actor).toBe('api');
    });

    it('returns null (no throw) when Redis is unavailable', async () => {
      const { cacheService } = await import('../../services/cache');
      vi.mocked(cacheService.getClient).mockReturnValueOnce(null as any);

      const v = await memoryVersions.record('proj', {
        op: 'created',
        memoryId: 'mem-x',
        content: 'x',
      });
      expect(v).toBeNull();
    });
  });

  describe('list', () => {
    it('returns project versions newest-first', async () => {
      await memoryVersions.record('proj', { op: 'created', memoryId: 'm1', content: 'first' });
      await memoryVersions.record('proj', { op: 'modified', memoryId: 'm1', content: 'second' });

      const versions = await memoryVersions.list('proj');
      expect(versions).toHaveLength(2);
      // newest-first
      expect(versions[0].content).toBe('second');
      expect(versions[1].content).toBe('first');
    });

    it('filters by memoryId', async () => {
      await memoryVersions.record('proj', { op: 'created', memoryId: 'm1', content: 'one' });
      await memoryVersions.record('proj', { op: 'created', memoryId: 'm2', content: 'two' });

      const m2 = await memoryVersions.list('proj', { memoryId: 'm2' });
      expect(m2).toHaveLength(1);
      expect(m2[0].memoryId).toBe('m2');
      expect(m2[0].content).toBe('two');
    });
  });

  describe('rollback', () => {
    it('restores the memory under its ORIGINAL id (no new uuid)', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'gone',
        content: 'restore me',
        type: 'decision',
        tags: ['db'],
      });

      const result = await memoryVersions.rollback('proj', v!.versionId);

      // Returned id is the original memoryId, NOT a freshly-minted one.
      expect(result).toEqual({ memoryId: 'gone' });

      // Upserted directly into the agent_memory collection at the original id.
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const [collection, points] = mockUpsert.mock.calls[0];
      expect(collection).toBe('proj_agent_memory');
      expect(points).toHaveLength(1);
      expect(points[0].id).toBe('gone');
      expect(points[0].payload.id).toBe('gone');
      expect(points[0].payload.content).toBe('restore me');
      expect(points[0].payload.type).toBe('decision');
      expect(points[0].payload.tags).toEqual(['db']);
      expect(points[0].payload.project).toBe('proj');
      // A restored memory must not stay marked superseded.
      expect(points[0].payload.supersededBy).toBeUndefined();
      expect(points[0].payload.metadata).toMatchObject({ rolledBackFrom: v!.versionId });

      // Embedding text mirrors MemoryService.remember exactly.
      expect(mockEmbed).toHaveBeenCalledWith('decision: restore me [tags: db]');

      // A 'modified'/restore version is recorded against the SAME memoryId.
      const versions = await memoryVersions.list('proj', { memoryId: 'gone' });
      expect(versions[0].op).toBe('modified');
      expect(versions[0].memoryId).toBe('gone');
    });

    it('is idempotent: a repeat rollback upserts the same id, not a duplicate', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'gone',
        content: 'restore me',
        type: 'note',
      });

      const first = await memoryVersions.rollback('proj', v!.versionId);
      const second = await memoryVersions.rollback('proj', v!.versionId);

      expect(first).toEqual({ memoryId: 'gone' });
      expect(second).toEqual({ memoryId: 'gone' });

      // Both rollbacks targeted the SAME id — no new uuid on the second pass.
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      expect(mockUpsert.mock.calls[0][1][0].id).toBe('gone');
      expect(mockUpsert.mock.calls[1][1][0].id).toBe('gone');
    });

    it('preserves identity fields (createdAt) of an existing point on rollback', async () => {
      mockGetById.mockResolvedValue({
        id: 'live',
        type: 'insight',
        content: 'old content',
        tags: ['x'],
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        relatedTo: 'feature-y',
        metadata: { source: 'manual' },
      });

      const v = await memoryVersions.record('proj', {
        op: 'modified',
        memoryId: 'live',
        content: 'rolled-back content',
        type: 'insight',
        tags: ['x'],
      });

      await memoryVersions.rollback('proj', v!.versionId);

      const points = mockUpsert.mock.calls[0][1];
      // Original createdAt preserved; relatedTo carried from the live point.
      expect(points[0].payload.createdAt).toBe('2020-01-01T00:00:00.000Z');
      expect(points[0].payload.relatedTo).toBe('feature-y');
      expect(points[0].payload.metadata).toMatchObject({ source: 'manual' });
      // relatedTo flows into the embedding text exactly like remember().
      expect(mockEmbed).toHaveBeenCalledWith(
        'insight: rolled-back content (related to: feature-y) [tags: x]'
      );
    });

    it('restores ALL payload fields of a deleted memory from the full snapshot', async () => {
      // The point is GONE after delete, so getById returns null — every field must
      // be reconstructed from the snapshot, not just content.
      mockGetById.mockResolvedValue(null);

      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'rich',
        content: 'use postgres for the orders table',
        type: 'decision',
        tags: ['db', 'orders'],
        snapshot: {
          id: 'rich',
          type: 'decision',
          content: 'use postgres for the orders table',
          tags: ['db', 'orders'],
          relatedTo: 'orders-service',
          createdAt: '2021-05-05T00:00:00.000Z',
          updatedAt: '2021-05-05T00:00:00.000Z',
          source: 'manual',
          confidence: 0.92,
          validated: true,
          pin: 'repo',
          factCategory: 'plan',
          triggerDescription: 'when choosing a datastore for orders',
          // bulky/derived fields that sanitizeSnapshot must drop:
          triggerEmbedding: [0.9, 0.9, 0.9],
          project: 'proj',
          metadata: { author: 'andrii' },
        },
      });

      // The stored version record must NOT carry the bulky triggerEmbedding/project.
      expect(v!.snapshot).toBeDefined();
      expect(v!.snapshot!.triggerEmbedding).toBeUndefined();
      expect(v!.snapshot!.project).toBeUndefined();
      expect(v!.snapshot!.confidence).toBe(0.92);

      const result = await memoryVersions.rollback('proj', v!.versionId);
      expect(result).toEqual({ memoryId: 'rich' });

      const points = mockUpsert.mock.calls[0][1];
      const payload = points[0].payload;
      expect(points[0].id).toBe('rich');
      expect(payload.id).toBe('rich');
      expect(payload.content).toBe('use postgres for the orders table');
      expect(payload.type).toBe('decision');
      expect(payload.tags).toEqual(['db', 'orders']);
      expect(payload.relatedTo).toBe('orders-service');
      // Identity + governance fields restored from the snapshot, not lost.
      expect(payload.createdAt).toBe('2021-05-05T00:00:00.000Z');
      expect(payload.source).toBe('manual');
      expect(payload.confidence).toBe(0.92);
      expect(payload.validated).toBe(true);
      expect(payload.pin).toBe('repo');
      expect(payload.factCategory).toBe('plan');
      expect(payload.triggerDescription).toBe('when choosing a datastore for orders');
      expect(payload.metadata).toMatchObject({ author: 'andrii', rolledBackFrom: v!.versionId });
      // A restored memory is never left superseded.
      expect(payload.supersededBy).toBeUndefined();
      expect(payload.project).toBe('proj');
      // triggerEmbedding is re-derived from triggerDescription (not the stale vector).
      expect(mockEmbed).toHaveBeenCalledWith('when choosing a datastore for orders');
      expect(payload.triggerEmbedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('is idempotent for a full-snapshot delete rollback (same id, fields preserved)', async () => {
      mockGetById.mockResolvedValue(null);

      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'rich2',
        content: 'restore me fully',
        type: 'insight',
        tags: ['x'],
        snapshot: {
          id: 'rich2',
          type: 'insight',
          content: 'restore me fully',
          tags: ['x'],
          confidence: 0.7,
          validated: true,
          createdAt: '2022-02-02T00:00:00.000Z',
        },
      });

      const first = await memoryVersions.rollback('proj', v!.versionId);
      const second = await memoryVersions.rollback('proj', v!.versionId);

      expect(first).toEqual({ memoryId: 'rich2' });
      expect(second).toEqual({ memoryId: 'rich2' });
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      // Same original id both times — no duplicate uuid.
      expect(mockUpsert.mock.calls[0][1][0].id).toBe('rich2');
      expect(mockUpsert.mock.calls[1][1][0].id).toBe('rich2');
      // Governance fields survive a repeat rollback.
      expect(mockUpsert.mock.calls[1][1][0].payload.confidence).toBe(0.7);
      expect(mockUpsert.mock.calls[1][1][0].payload.validated).toBe(true);
      expect(mockUpsert.mock.calls[1][1][0].payload.createdAt).toBe('2022-02-02T00:00:00.000Z');
    });

    it('falls back to content-only restore for a snapshot-less (legacy) version', async () => {
      mockGetById.mockResolvedValue(null);

      // No snapshot field — emulates a record written before full snapshots existed.
      const v = await memoryVersions.record('proj', {
        op: 'deleted',
        memoryId: 'legacy',
        content: 'old content',
        type: 'note',
        tags: ['t'],
      });
      expect(v!.snapshot).toBeUndefined();

      const result = await memoryVersions.rollback('proj', v!.versionId);
      expect(result).toEqual({ memoryId: 'legacy' });

      const payload = mockUpsert.mock.calls[0][1][0].payload;
      expect(payload.id).toBe('legacy');
      expect(payload.content).toBe('old content');
      expect(payload.type).toBe('note');
      expect(payload.tags).toEqual(['t']);
      // No governance fields available in a legacy record — none invented.
      expect(payload.confidence).toBeUndefined();
      expect(payload.validated).toBeUndefined();
      expect(payload.triggerEmbedding).toBeUndefined();
    });

    it('returns null for an unknown versionId', async () => {
      const result = await memoryVersions.rollback('proj', 'does-not-exist');
      expect(result).toBeNull();
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('refuses to roll back a redacted version', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'created',
        memoryId: 'm',
        content: 'secret',
      });
      await memoryVersions.redact('proj', v!.versionId);

      const result = await memoryVersions.rollback('proj', v!.versionId);
      expect(result).toBeNull();
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('redact', () => {
    it('clears the content snapshot but keeps actor, timestamp, and hash', async () => {
      const v = await memoryVersions.record('proj', {
        op: 'created',
        memoryId: 'm',
        actor: 'governance',
        content: 'sensitive data',
      });

      const redacted = await memoryVersions.redact('proj', v!.versionId);

      expect(redacted).not.toBeNull();
      expect(redacted!.redacted).toBe(true);
      expect(redacted!.content).toBeNull();
      expect(redacted!.actor).toBe('governance');
      expect(redacted!.timestamp).toBe(v!.timestamp);
      expect(redacted!.contentHash).toBe(v!.contentHash);

      // get() reflects the redaction
      const fetched = await memoryVersions.get('proj', v!.versionId);
      expect(fetched!.content).toBeNull();
      expect(fetched!.redacted).toBe(true);
    });

    it('returns null for an unknown versionId', async () => {
      const redacted = await memoryVersions.redact('proj', 'missing');
      expect(redacted).toBeNull();
    });
  });
});
