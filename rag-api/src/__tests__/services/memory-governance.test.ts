import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

// Hoist mocks so they're available in vi.mock factories
const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
  setPayload: vi.fn(),
}));

const mockTimerEnd = vi.hoisted(() => vi.fn());
const mockStartTimer = vi.hoisted(() => vi.fn(() => mockTimerEnd));

// Redis-backed governance counters (promoted/rejected). The map mirrors what
// cacheService.increment / getClient().get would do against Redis.
const counters = vi.hoisted(() => new Map<string, number>());
const mockCacheGet = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const v = counters.get(key);
    return v === undefined ? null : String(v);
  })
);
const mockCacheIncrement = vi.hoisted(() =>
  vi.fn(async (key: string, amount = 1) => {
    const next = (counters.get(key) ?? 0) + amount;
    counters.set(key, next);
    return next;
  })
);

// Mock dependencies
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    deleteByFilter: vi.fn(),
    getCollectionInfo: vi.fn(),
    aggregateByField: vi.fn(),
    recommend: vi.fn(),
    ensureCollection: vi.fn(),
    // Expose the mock client as the private 'client' field
    // governance service accesses this via vectorStore['client']
    client: mockQdrantClient,
  },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
    embedBatch: vi.fn(),
  },
}));

vi.mock('../../services/memory', () => ({
  memoryService: {
    remember: vi.fn(),
    recall: vi.fn(),
    mergeMemories: vi.fn(),
    forgetOlderThan: vi.fn(),
  },
}));

vi.mock('../../services/quality-gates', () => ({
  qualityGates: {
    runGates: vi.fn(),
  },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    increment: mockCacheIncrement,
    getClient: vi.fn(() => ({ get: mockCacheGet })),
  },
}));

vi.mock('../../utils/metrics', () => ({
  memoryGovernanceTotal: { inc: vi.fn() },
  maintenanceDuration: { startTimer: mockStartTimer },
  qualityGateResults: { inc: vi.fn() },
  qualityGateDuration: { observe: vi.fn() },
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { memoryService } from '../../services/memory';
import { qualityGates } from '../../services/quality-gates';
import { cacheService } from '../../services/cache';
import { memoryGovernance } from '../../services/memory-governance';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);
const mockedMemory = vi.mocked(memoryService);
const mockedGates = vi.mocked(qualityGates);

describe('MemoryGovernanceService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-set hoisted mocks that resetAllMocks clears
    mockStartTimer.mockImplementation(() => mockTimerEnd);
    // Re-wire the counter-backed cache mocks (resetAllMocks clears implementations)
    counters.clear();
    mockCacheGet.mockImplementation(async (key: string) => {
      const v = counters.get(key);
      return v === undefined ? null : String(v);
    });
    mockCacheIncrement.mockImplementation(async (key: string, amount = 1) => {
      const next = (counters.get(key) ?? 0) + amount;
      counters.set(key, next);
      return next;
    });
    vi.mocked(cacheService.getClient).mockReturnValue({ get: mockCacheGet } as any);
    // Clear the governance service's internal caches to prevent cross-test leaks
    (memoryGovernance as any).thresholdCache.clear();
    (memoryGovernance as any).compactionLocks.clear();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
    mockedEmbed.embedBatch.mockResolvedValue([fakeVector, fakeVector]);
    // Default: no existing memories for relationship detection
    mockedVS.search.mockResolvedValue([]);
  });

  describe('ingest', () => {
    it('routes manual memory to durable via memoryService.remember', async () => {
      const fakeMemory = {
        id: 'durable-1',
        type: 'decision' as const,
        content: 'use TypeScript',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockedMemory.remember.mockResolvedValue(fakeMemory);

      const result = await memoryGovernance.ingest({
        projectName: 'test',
        content: 'use TypeScript',
        type: 'decision',
      });

      expect(mockedMemory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test',
          content: 'use TypeScript',
          type: 'decision',
        })
      );
      expect(result.id).toBe('durable-1');
    });

    it('routes auto-generated memory to quarantine', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);
      // No review history → adaptive threshold stays at default 0.5, conf 0.8 > 0.5

      const result = await memoryGovernance.ingest({
        projectName: 'test',
        content: 'auto-discovered pattern',
        type: 'insight',
        source: 'auto_pattern',
        confidence: 0.8,
      });

      expect(mockedMemory.remember).not.toHaveBeenCalled();
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_memory_pending',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              content: 'auto-discovered pattern',
              source: 'auto_pattern',
              validated: false,
            }),
          }),
        ])
      );
      expect(result.source).toBe('auto_pattern');
    });

    it('skips auto-memory below adaptive confidence threshold', async () => {
      // Review history dominated by rejections → threshold climbs toward 0.8.
      // 0 promoted / 10 rejected → successRate=0 → threshold=0.8.
      counters.set('governance:test:promoted', 0);
      counters.set('governance:test:rejected', 10);

      const result = await memoryGovernance.ingest({
        projectName: 'test',
        content: 'low confidence',
        type: 'note',
        source: 'auto_conversation',
        confidence: 0.3,
      });

      expect(result.metadata).toEqual(
        expect.objectContaining({ skipped: true, reason: 'below_threshold' })
      );
      expect(mockedVS.upsert).not.toHaveBeenCalled();
      expect(mockedMemory.remember).not.toHaveBeenCalled();
    });

    it('does NOT raise the threshold from an unreviewed quarantine backlog', async () => {
      // A normal backlog (many pending, ZERO reviews) must keep the default 0.5
      // so a confidence-0.6 auto-memory is still quarantined, not silently dropped.
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await memoryGovernance.ingest({
        projectName: 'test',
        content: 'medium confidence',
        type: 'note',
        source: 'auto_conversation',
        confidence: 0.6,
      });

      expect(result.metadata?.skipped).toBeUndefined();
      expect(mockedVS.upsert).toHaveBeenCalled();
    });

    it('ALWAYS quarantines auto_memory_tool writes (no confidence -> never threshold-dropped)', async () => {
      // M2: the memory-tool adapter sends source 'auto_memory_tool' and NO
      // confidence. Even with a hostile review history (threshold at max 0.8)
      // the write must land in quarantine — confidence-undefined writes are
      // never dropped, preserving memory_20250818's create-succeeds contract.
      counters.set('governance:test:promoted', 0);
      counters.set('governance:test:rejected', 10);
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await memoryGovernance.ingest({
        projectName: 'test',
        content: 'memory tool write',
        type: 'note',
        tags: ['mem:path=/memories/auth.md'],
        source: 'auto_memory_tool',
        // no confidence — deliberate
      });

      expect(result.metadata?.skipped).toBeUndefined();
      expect(mockedMemory.remember).not.toHaveBeenCalled();
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_memory_pending',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              source: 'auto_memory_tool',
              validated: false,
            }),
          }),
        ])
      );
    });
  });

  describe('promote', () => {
    it('moves memory from quarantine to durable', async () => {
      // Find in quarantine
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-1',
            payload: {
              id: 'q-1',
              type: 'insight',
              content: 'promoted content',
              tags: ['test'],
              source: 'auto_pattern',
              confidence: 0.8,
              metadata: {},
            },
          },
        ],
      });
      mockedVS.delete.mockResolvedValue(undefined);
      mockedMemory.remember.mockResolvedValue({
        id: 'durable-2',
        type: 'insight',
        content: 'promoted content',
        tags: ['test'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await memoryGovernance.promote('test', 'q-1', 'human_validated');

      expect(mockedVS.delete).toHaveBeenCalledWith('test_memory_pending', ['q-1']);
      expect(mockedMemory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test',
          content: 'promoted content',
          metadata: expect.objectContaining({
            validated: true,
            promoteReason: 'human_validated',
          }),
        })
      );
      expect(result.id).toBe('durable-2');
    });

    it('throws when memory not found in quarantine', async () => {
      mockQdrantClient.scroll.mockResolvedValue({ points: [] });

      await expect(
        memoryGovernance.promote('test', 'nonexistent', 'human_validated')
      ).rejects.toThrow('Memory not found in quarantine');
    });

    it('does NOT delete from quarantine when durable write fails (no data loss)', async () => {
      // Gate passes (no gates requested), memory found in quarantine...
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-1',
            payload: {
              id: 'q-1',
              type: 'insight',
              content: 'precious content',
              tags: [],
              metadata: {},
            },
          },
        ],
      });
      mockedVS.delete.mockResolvedValue(undefined);
      // ...but the durable write throws (embed/upsert failure).
      mockedMemory.remember.mockRejectedValue(new Error('embed service down'));

      await expect(memoryGovernance.promote('test', 'q-1', 'human_validated')).rejects.toThrow(
        'embed service down'
      );

      // Critical: quarantine copy must remain — delete never ran.
      expect(mockedVS.delete).not.toHaveBeenCalled();
      // And the promote counter must NOT advance on a failed promotion.
      expect(counters.get('governance:test:promoted')).toBeUndefined();
    });

    it('rejects promotion when quality gates fail', async () => {
      mockedGates.runGates.mockResolvedValue({
        passed: false,
        gates: [{ gate: 'typecheck', passed: false, details: 'TS2322: Type error', duration: 100 }],
      });

      await expect(
        memoryGovernance.promote('test', 'q-1', 'tests_passed', undefined, {
          runGates: true,
          projectPath: '/project',
        })
      ).rejects.toThrow('Quality gates failed');
    });
  });

  describe('reject', () => {
    it('deletes memory from quarantine', async () => {
      mockedVS.delete.mockResolvedValue(undefined);

      const result = await memoryGovernance.reject('test', 'q-1');

      expect(result).toBe(true);
      expect(mockedVS.delete).toHaveBeenCalledWith('test_memory_pending', ['q-1']);
    });

    it('returns false on error', async () => {
      mockedVS.delete.mockRejectedValue(new Error('fail'));

      const result = await memoryGovernance.reject('test', 'q-1');

      expect(result).toBe(false);
    });
  });

  describe('listQuarantine (?tag= filter, M2)', () => {
    it('passes an exact-tag filter to the quarantine scroll', async () => {
      const tag = 'mem:path=/memories/auth.md';
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'q-1', payload: { id: 'q-1', type: 'note', content: 'c', tags: [tag] } }],
      });

      const memories = await memoryGovernance.listQuarantine('test', 20, undefined, tag);

      expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
        'test_memory_pending',
        expect.objectContaining({
          filter: { must: [{ key: 'tags', match: { any: [tag] } }] },
        })
      );
      expect(memories).toHaveLength(1);
      expect(memories[0].tags).toContain(tag);
    });

    it('omits the filter when no tag is given', async () => {
      mockQdrantClient.scroll.mockResolvedValue({ points: [] });

      await memoryGovernance.listQuarantine('test', 20);

      const args = mockQdrantClient.scroll.mock.calls[0][1];
      expect(args.filter).toBeUndefined();
    });
  });

  describe('getQuarantineById / deleteFromQuarantine (M2)', () => {
    it('getQuarantineById finds a quarantine memory by exact id', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'q-7', payload: { id: 'q-7', type: 'note', content: 'pending write' } }],
      });

      const memory = await memoryGovernance.getQuarantineById('test', 'q-7');

      expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
        'test_memory_pending',
        expect.objectContaining({
          filter: { must: [{ key: 'id', match: { value: 'q-7' } }] },
        })
      );
      expect(memory?.id).toBe('q-7');
      expect(memory?.content).toBe('pending write');
    });

    it('getQuarantineById returns null when missing or collection absent', async () => {
      mockQdrantClient.scroll.mockResolvedValue({ points: [] });
      expect(await memoryGovernance.getQuarantineById('test', 'nope')).toBeNull();

      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);
      expect(await memoryGovernance.getQuarantineById('test', 'nope')).toBeNull();
    });

    it('deleteFromQuarantine deletes WITHOUT counting a review outcome', async () => {
      mockedVS.delete.mockResolvedValue(undefined);

      const ok = await memoryGovernance.deleteFromQuarantine('counterproj', 'q-8');

      expect(ok).toBe(true);
      expect(mockedVS.delete).toHaveBeenCalledWith('counterproj_memory_pending', ['q-8']);
      // Unlike reject(): the adaptive-threshold rejected counter must NOT move —
      // an agent deleting/superseding its own unpromoted write is not a review.
      expect(counters.get('governance:counterproj:rejected')).toBeUndefined();
    });
  });

  describe('recallDurable', () => {
    it('delegates to memoryService.recall', async () => {
      mockedMemory.recall.mockResolvedValue([]);

      await memoryGovernance.recallDurable({
        projectName: 'test',
        query: 'search',
        limit: 5,
      });

      expect(mockedMemory.recall).toHaveBeenCalledWith({
        projectName: 'test',
        query: 'search',
        limit: 5,
      });
    });
  });

  describe('getAdaptiveThreshold', () => {
    it('returns default 0.5 when < 5 reviewed memories', async () => {
      counters.set('governance:fresh-proj:promoted', 1);
      counters.set('governance:fresh-proj:rejected', 1);

      const threshold = await memoryGovernance.getAdaptiveThreshold('fresh-proj');

      expect(threshold).toBe(0.5);
    });

    it('computes threshold from promote/reject success rate', async () => {
      // 8 promoted, 2 rejected → successRate=0.8 → threshold = 0.8 - 0.8*0.4 = 0.48
      counters.set('governance:newproj:promoted', 8);
      counters.set('governance:newproj:rejected', 2);

      const threshold = await memoryGovernance.getAdaptiveThreshold('newproj');

      expect(threshold).toBeGreaterThanOrEqual(0.4);
      expect(threshold).toBeLessThanOrEqual(0.8);
      expect(threshold).toBeCloseTo(0.48, 1);
    });

    it('increments the promoted counter on promote()', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-1',
            payload: { id: 'q-1', type: 'insight', content: 'c', tags: [], metadata: {} },
          },
        ],
      });
      mockedVS.delete.mockResolvedValue(undefined);
      mockedMemory.remember.mockResolvedValue({
        id: 'd-1',
        type: 'insight',
        content: 'c',
        tags: [],
        createdAt: '',
        updatedAt: '',
      });

      await memoryGovernance.promote('counterproj', 'q-1', 'human_validated');

      expect(counters.get('governance:counterproj:promoted')).toBe(1);
    });

    it('increments the rejected counter on reject()', async () => {
      mockedVS.delete.mockResolvedValue(undefined);

      await memoryGovernance.reject('counterproj', 'q-2');

      expect(counters.get('governance:counterproj:rejected')).toBe(1);
    });
  });

  describe('per-source capture-funnel counters (M5)', () => {
    it('bumps ingest:{source} when an auto-memory is quarantined', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      await memoryGovernance.ingest({
        projectName: 'srcproj',
        content: 'mined from a transcript',
        type: 'context',
        source: 'auto_transcript',
        confidence: 0.9,
      });

      expect(counters.get('governance:srcproj:ingest:auto_transcript')).toBe(1);
    });

    it('does NOT bump ingest:{source} when the memory is threshold-dropped', async () => {
      counters.set('governance:srcproj:promoted', 0);
      counters.set('governance:srcproj:rejected', 10); // threshold → 0.8

      await memoryGovernance.ingest({
        projectName: 'srcproj',
        content: 'low confidence',
        type: 'note',
        source: 'auto_transcript',
        confidence: 0.3,
      });

      expect(counters.get('governance:srcproj:ingest:auto_transcript')).toBeUndefined();
    });

    it('bumps promote:{source} from the quarantine payload on promote()', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-1',
            payload: {
              id: 'q-1',
              type: 'context',
              content: 'c',
              tags: [],
              source: 'auto_transcript',
              metadata: {},
            },
          },
        ],
      });
      mockedVS.delete.mockResolvedValue(undefined);
      mockedMemory.remember.mockResolvedValue({
        id: 'd-1',
        type: 'context',
        content: 'c',
        tags: [],
        createdAt: '',
        updatedAt: '',
      });

      await memoryGovernance.promote('srcproj', 'q-1', 'human_validated');

      expect(counters.get('governance:srcproj:promote:auto_transcript')).toBe(1);
      // The aggregate review counter still advances (threshold math untouched).
      expect(counters.get('governance:srcproj:promoted')).toBe(1);
    });

    it('bumps reject:{source} read from the quarantine payload on reject()', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-2',
            payload: { id: 'q-2', type: 'note', content: 'c', source: 'auto_memory_tool' },
          },
        ],
      });
      mockedVS.delete.mockResolvedValue(undefined);

      await memoryGovernance.reject('srcproj', 'q-2');

      expect(counters.get('governance:srcproj:reject:auto_memory_tool')).toBe(1);
      expect(counters.get('governance:srcproj:rejected')).toBe(1);
    });

    it('reject() still succeeds when the source read fails (attribution is best-effort)', async () => {
      mockQdrantClient.scroll.mockRejectedValue(new Error('scroll down'));
      mockedVS.delete.mockResolvedValue(undefined);

      const result = await memoryGovernance.reject('srcproj', 'q-3');

      expect(result).toBe(true);
      expect(counters.get('governance:srcproj:rejected')).toBe(1);
    });

    it('getSourceCounters returns per-source ingest/promote/reject counts (zeros when unset)', async () => {
      counters.set('governance:srcproj:ingest:auto_transcript', 7);
      counters.set('governance:srcproj:promote:auto_transcript', 2);
      counters.set('governance:srcproj:reject:auto_transcript', 1);

      const result = await memoryGovernance.getSourceCounters('srcproj', [
        'auto_transcript',
        'auto_memory_tool',
      ]);

      expect(result.auto_transcript).toEqual({ ingested: 7, promoted: 2, rejected: 1 });
      expect(result.auto_memory_tool).toEqual({ ingested: 0, promoted: 0, rejected: 0 });
    });
  });

  describe('cleanupExpiredQuarantine', () => {
    it('deletes quarantine memories older than TTL', async () => {
      const expired = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days (> 7 TTL)
      const fresh = new Date().toISOString();

      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: 'exp-1', payload: { createdAt: expired } },
          { id: 'exp-2', payload: { createdAt: expired } },
          { id: 'fresh-1', payload: { createdAt: fresh } },
        ],
        next_page_offset: undefined,
      });
      mockedVS.delete.mockResolvedValue(undefined);

      const result = await memoryGovernance.cleanupExpiredQuarantine('test');

      expect(result.rejected).toEqual(['exp-1', 'exp-2']);
      expect(result.errors).toHaveLength(0);
      expect(mockedVS.delete).toHaveBeenCalledWith('test_memory_pending', ['exp-1', 'exp-2']);
    });

    it('returns empty when quarantine collection does not exist', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const result = await memoryGovernance.cleanupExpiredQuarantine('test');

      expect(result.rejected).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('returns empty when no expired memories', async () => {
      const fresh = new Date().toISOString();
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'f-1', payload: { createdAt: fresh } }],
        next_page_offset: undefined,
      });

      const result = await memoryGovernance.cleanupExpiredQuarantine('test');

      expect(result.rejected).toHaveLength(0);
      expect(mockedVS.delete).not.toHaveBeenCalled();
    });
  });

  describe('runCompaction', () => {
    it('returns clusters in dry-run mode without writing', async () => {
      mockedMemory.mergeMemories.mockResolvedValue({
        merged: [
          {
            original: [
              { id: 'a', type: 'note', content: 'foo', tags: [], createdAt: '', updatedAt: '' },
              { id: 'b', type: 'note', content: 'bar', tags: [], createdAt: '', updatedAt: '' },
            ],
            merged: {
              id: 'merged-1',
              type: 'note',
              content: 'foo + bar',
              tags: [],
              createdAt: '',
              updatedAt: '',
              metadata: {},
            },
          },
        ],
        totalFound: 10,
        totalMerged: 1,
      });

      const result = await memoryGovernance.runCompaction('test', { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].originalIds).toEqual(['a', 'b']);
      expect(result.clusters[0].mergedContent).toBe('foo + bar');
      expect(result.clusters[0].mergedId).toBeUndefined();
      // Should NOT write anything
      expect(mockedMemory.remember).not.toHaveBeenCalled();
      expect(mockQdrantClient.setPayload).not.toHaveBeenCalled();
    });

    it('creates merged memory and marks originals as superseded when not dry-run', async () => {
      mockedMemory.mergeMemories.mockResolvedValue({
        merged: [
          {
            original: [
              { id: 'a', type: 'note', content: 'foo', tags: [], createdAt: '', updatedAt: '' },
              { id: 'b', type: 'note', content: 'bar', tags: [], createdAt: '', updatedAt: '' },
            ],
            merged: {
              id: 'tmp',
              type: 'note',
              content: 'foo + bar',
              tags: ['test'],
              createdAt: '',
              updatedAt: '',
              metadata: {},
            },
          },
        ],
        totalFound: 10,
        totalMerged: 1,
      });
      mockedMemory.remember.mockResolvedValue({
        id: 'new-merged',
        type: 'note',
        content: 'foo + bar',
        tags: ['test'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockQdrantClient.setPayload.mockResolvedValue(undefined);

      const result = await memoryGovernance.runCompaction('test', { dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].mergedId).toBe('new-merged');
      expect(mockedMemory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test',
          content: 'foo + bar',
        })
      );
      // Both originals marked superseded
      expect(mockQdrantClient.setPayload).toHaveBeenCalledTimes(2);
      expect(mockQdrantClient.setPayload).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.objectContaining({
          points: ['a'],
          payload: expect.objectContaining({ supersededBy: 'new-merged' }),
        })
      );
    });

    it('throws when compaction already running for same project', async () => {
      // Simulate a long-running compaction by making mergeMemories hang
      let resolveHang: () => void;
      const hangPromise = new Promise<void>((resolve) => {
        resolveHang = resolve;
      });
      mockedMemory.mergeMemories.mockImplementation(() =>
        hangPromise.then(() => ({
          merged: [],
          totalFound: 0,
          totalMerged: 0,
        }))
      );

      // Start first compaction (will hang)
      const first = memoryGovernance.runCompaction('test');

      // Second attempt should throw immediately
      await expect(memoryGovernance.runCompaction('test')).rejects.toThrow(
        'Compaction already running for project: test'
      );

      // Cleanup: resolve the hanging promise
      resolveHang!();
      await first;
    });
  });

  describe('runMaintenance', () => {
    it('defaults to quarantine_cleanup', async () => {
      const fresh = new Date().toISOString();
      // quarantine_cleanup scroll
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'f-1', payload: { createdAt: fresh } }],
        next_page_offset: undefined,
      });

      const result = await memoryGovernance.runMaintenance('test');

      expect(result.quarantine_cleanup).toBeDefined();
      expect(result.compaction).toBeUndefined();
    });

    it('runs compaction when requested', async () => {
      mockedMemory.mergeMemories.mockResolvedValue({
        merged: [],
        totalFound: 0,
        totalMerged: 0,
      });

      const result = await memoryGovernance.runMaintenance('test', {
        quarantine_cleanup: false,
        compaction: true,
        compaction_dry_run: true,
      });

      expect(result.quarantine_cleanup).toBeUndefined();
      expect(result.compaction).toBeDefined();
      expect(result.compaction!.dryRun).toBe(true);
    });
  });
});
