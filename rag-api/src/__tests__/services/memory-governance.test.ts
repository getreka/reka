import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

// Hoist mocks so they're available in vi.mock factories
const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
  setPayload: vi.fn(),
}));

const mockTimerEnd = vi.hoisted(() => vi.fn());
const mockStartTimer = vi.hoisted(() => vi.fn(() => mockTimerEnd));

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

vi.mock('../../services/feedback', () => ({
  feedbackService: {
    getMemoryFeedbackCounts: vi.fn(),
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
      // For adaptive threshold: default with < 5 total
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [] })
        .mockResolvedValueOnce({ points: [] });

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
      // Return enough to compute a threshold > 0.7
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [] }) // promoted
        .mockResolvedValueOnce({ points: Array.from({ length: 10 }, () => ({})) }); // pending (10 items)

      // With 0 promoted / 10 total → successRate=0 → threshold=0.8
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
    it('returns default 0.5 when < 5 total memories', async () => {
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [{}] }) // 1 promoted
        .mockResolvedValueOnce({ points: [{}] }); // 1 pending

      const threshold = await memoryGovernance.getAdaptiveThreshold('fresh-proj');

      expect(threshold).toBe(0.5);
    });

    it('computes threshold from success rate', async () => {
      // 8 promoted, 2 pending → successRate=0.8 → threshold = 0.8 - 0.8*0.4 = 0.48
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: Array.from({ length: 8 }, () => ({})) })
        .mockResolvedValueOnce({ points: Array.from({ length: 2 }, () => ({})) });

      const threshold = await memoryGovernance.getAdaptiveThreshold('newproj');

      expect(threshold).toBeGreaterThanOrEqual(0.4);
      expect(threshold).toBeLessThanOrEqual(0.8);
      expect(threshold).toBeCloseTo(0.48, 1);
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
    it('defaults to quarantine_cleanup + feedback_maintenance', async () => {
      const fresh = new Date().toISOString();
      // quarantine_cleanup scroll
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'f-1', payload: { createdAt: fresh } }],
        next_page_offset: undefined,
      });
      // feedback: no feedback data
      const { feedbackService } = await import('../../services/feedback');
      vi.mocked(feedbackService.getMemoryFeedbackCounts).mockResolvedValue(new Map());

      const result = await memoryGovernance.runMaintenance('test');

      expect(result.quarantine_cleanup).toBeDefined();
      expect(result.feedback_maintenance).toBeDefined();
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
        feedback_maintenance: false,
        compaction: true,
        compaction_dry_run: true,
      });

      expect(result.quarantine_cleanup).toBeUndefined();
      expect(result.feedback_maintenance).toBeUndefined();
      expect(result.compaction).toBeDefined();
      expect(result.compaction!.dryRun).toBe(true);
    });
  });
});
