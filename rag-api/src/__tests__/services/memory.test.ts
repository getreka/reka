import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding, mockSearchResult } from '../helpers/fixtures';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
  setPayload: vi.fn().mockResolvedValue(undefined),
}));

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
    searchByKeywords: vi.fn().mockResolvedValue([]),
    client: mockQdrantClient,
  },
  default: {
    upsert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    deleteByFilter: vi.fn(),
    getCollectionInfo: vi.fn(),
    aggregateByField: vi.fn(),
    recommend: vi.fn(),
    searchByKeywords: vi.fn().mockResolvedValue([]),
    client: mockQdrantClient,
  },
}));

vi.mock('../../events/emitter', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
    embedBatch: vi.fn(),
    embedQuery: vi.fn(),
  },
  default: {
    embed: vi.fn(),
    embedBatch: vi.fn(),
    embedQuery: vi.fn(),
  },
}));

vi.mock('../../services/llm', () => ({
  llm: {
    complete: vi.fn(),
  },
  default: {
    complete: vi.fn(),
  },
}));

vi.mock('../../services/memory-versions', () => ({
  memoryVersions: {
    record: vi.fn().mockResolvedValue(null),
  },
  default: {
    record: vi.fn().mockResolvedValue(null),
  },
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { memoryService } from '../../services/memory';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('MemoryService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
    mockedEmbed.embedBatch.mockResolvedValue([fakeVector, fakeVector]);
    // Default: no existing similar memories for relationship detection
    mockedVS.search.mockResolvedValue([]);
  });

  describe('remember', () => {
    it('creates memory, embeds content, and upserts to Qdrant', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const memory = await memoryService.remember({
        projectName: 'test',
        content: 'BGE-M3 uses /embed not /embed_batch',
        type: 'decision',
        tags: ['bugfix'],
      });

      expect(memory.id).toBeDefined();
      expect(memory.type).toBe('decision');
      expect(memory.content).toBe('BGE-M3 uses /embed not /embed_batch');
      expect(memory.tags).toEqual(['bugfix']);
      expect(memory.createdAt).toBeDefined();

      expect(mockedEmbed.embed).toHaveBeenCalledWith(
        expect.stringContaining('decision: BGE-M3 uses /embed')
      );
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.arrayContaining([
          expect.objectContaining({
            id: memory.id,
            vector: fakeVector,
            payload: expect.objectContaining({
              content: 'BGE-M3 uses /embed not /embed_batch',
              project: 'test',
            }),
          }),
        ])
      );
    });

    it('sets pending status for todo type', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const memory = await memoryService.remember({
        projectName: 'test',
        content: 'fix the bug',
        type: 'todo',
      });

      expect(memory.status).toBe('pending');
      expect(memory.statusHistory).toHaveLength(1);
      expect(memory.statusHistory![0].status).toBe('pending');
    });

    it('embeds and stores triggerDescription + pin when provided', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const memory = await memoryService.remember({
        projectName: 'test',
        content: 'Always run npm run build before pushing',
        type: 'procedure',
        triggerDescription: 'when the user asks to push or commit',
        pin: 'repo',
      });

      expect(memory.triggerDescription).toBe('when the user asks to push or commit');
      expect(memory.pin).toBe('repo');
      // Content + trigger are each embedded (2 embed calls).
      expect(mockedEmbed.embed).toHaveBeenCalledWith('when the user asks to push or commit');
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              triggerDescription: 'when the user asks to push or commit',
              pin: 'repo',
              triggerEmbedding: fakeVector,
            }),
          }),
        ])
      );
    });

    it('stays backward-compatible: no trigger means a single content embed', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);
      mockedEmbed.embed.mockClear();

      const memory = await memoryService.remember({
        projectName: 'test',
        content: 'plain memory',
      });

      expect(memory.triggerDescription).toBeUndefined();
      // Only the content embed — no trigger embed.
      expect(mockedEmbed.embed).toHaveBeenCalledTimes(1);
    });
  });

  describe('recall with trigger descriptions', () => {
    it('blends a trigger-embedding similarity into the result score', async () => {
      const now = new Date().toISOString();
      // Trigger embedding identical to the query embedding → cosine 1.0, lifting score.
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'trig-mem',
          score: 0.5,
          payload: {
            type: 'procedure',
            content: 'run build before push',
            tags: [],
            createdAt: now,
            updatedAt: now,
            triggerDescription: 'when pushing',
            triggerEmbedding: fakeVector, // same vector the mocked embed returns
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'I want to push my changes',
        limit: 5,
        multiStrategy: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0].memory.triggerDescription).toBe('when pushing');
      // ADDITIVE boost: base 0.5 + weight 0.3 * trigSim 1.0 = 0.8. The trigger only
      // ever lifts the score; it never multiplies the base down.
      expect(results[0].score).toBeGreaterThan(0.5);
      expect(results[0].score).toBeCloseTo(0.8, 2);
    });

    it('trigger boost never demotes a triggered memory below a stronger untriggered one', async () => {
      const now = new Date().toISOString();
      // A triggered memory with a LOWER base score than an untriggered one, and a
      // trigger that does NOT match the query (orthogonal vector → trigSim 0).
      // With the old multiplicative blend (base*0.7) the triggered memory would be
      // pushed even further down; with the additive boost it can only stay or rise,
      // so ordering by base score is preserved.
      const orthogonal = mockEmbedding(1024).map((_, i) => (i === 0 ? 1 : 0));
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'triggered-low',
          score: 0.6,
          payload: {
            type: 'procedure',
            content: 'triggered but weak base match',
            tags: [],
            createdAt: now,
            updatedAt: now,
            triggerDescription: 'unrelated cue',
            triggerEmbedding: orthogonal,
          },
        }),
        mockSearchResult({
          id: 'untriggered-high',
          score: 0.7,
          payload: {
            type: 'procedure',
            content: 'no trigger but stronger base match',
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'something',
        limit: 5,
        multiStrategy: false,
      });

      // The triggered memory's score must NOT drop below its base (no multiplicative
      // demotion), and the stronger untriggered memory still ranks first.
      const triggered = results.find((r) => r.memory.id === 'triggered-low')!;
      const untriggered = results.find((r) => r.memory.id === 'untriggered-high')!;
      expect(triggered.score).toBeGreaterThanOrEqual(0.6);
      expect(untriggered.score).toBeCloseTo(0.7, 5);
      expect(results[0].memory.id).toBe('untriggered-high');
    });

    it('leaves scores untouched when no result carries a trigger embedding', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'plain',
          score: 0.7,
          payload: {
            type: 'note',
            content: 'no trigger here',
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'anything',
        limit: 5,
        multiStrategy: false,
      });

      expect(results[0].score).toBeCloseTo(0.7, 5);
    });
  });

  describe('recall', () => {
    it('embeds query, searches, and returns results', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'mem-1',
          score: 0.9,
          payload: {
            type: 'note',
            content: 'found memory',
            tags: ['test'],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'find stuff',
        limit: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].memory.content).toBe('found memory');
      expect(results[0].score).toBeCloseTo(0.9, 1);
      expect(mockedVS.search).toHaveBeenCalledWith(
        'test_agent_memory',
        fakeVector,
        10, // limit * 2
        undefined
      );
    });

    it('filters out superseded memories', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'active',
          score: 0.9,
          payload: { type: 'note', content: 'active', tags: [], createdAt: now, updatedAt: now },
        }),
        mockSearchResult({
          id: 'superseded',
          score: 0.85,
          payload: {
            type: 'note',
            content: 'old',
            tags: [],
            createdAt: now,
            updatedAt: now,
            supersededBy: 'active',
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'anything',
        limit: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe('active');
    });

    it('applies aging decay to old unvalidated memories', async () => {
      // Memory 90 days old → 2 periods past first 30 → decay = min(0.50, 2 * 0.10) = 0.20
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'old-mem',
          score: 1.0,
          payload: {
            type: 'note',
            content: 'old memory',
            tags: [],
            createdAt: old,
            updatedAt: old,
            validated: false,
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'anything',
        limit: 5,
      });

      expect(results[0].score).toBeLessThan(1.0);
      // rate=0.10, 2 periods → 20% decay → score = 0.80
      expect(results[0].score).toBeCloseTo(0.8, 1);
    });

    it('does not apply aging decay to validated memories', async () => {
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'validated-mem',
          score: 1.0,
          payload: {
            type: 'note',
            content: 'validated memory',
            tags: [],
            createdAt: old,
            updatedAt: old,
            validated: true,
          },
        }),
      ]);

      const results = await memoryService.recall({
        projectName: 'test',
        query: 'anything',
        limit: 5,
      });

      expect(results[0].score).toBe(1.0);
    });

    it('builds type filter when specified', async () => {
      mockedVS.search.mockResolvedValue([]);

      await memoryService.recall({
        projectName: 'test',
        query: 'decisions',
        type: 'decision',
        limit: 5,
      });

      expect(mockedVS.search).toHaveBeenCalledWith('test_agent_memory', fakeVector, 10, {
        must: [{ key: 'type', match: { value: 'decision' } }],
      });
    });
  });

  describe('list', () => {
    it('returns memories with proper structure', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'list-1',
          score: 0.8,
          payload: {
            type: 'insight',
            content: 'listed',
            tags: ['a'],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ]);

      const memories = await memoryService.list({
        projectName: 'test',
        limit: 10,
      });

      expect(memories).toHaveLength(1);
      expect(memories[0].type).toBe('insight');
      expect(memories[0].content).toBe('listed');
    });
  });

  describe('forget', () => {
    it('deletes memory by ID', async () => {
      mockedVS.delete.mockResolvedValue(undefined);

      const result = await memoryService.forget('test', 'mem-1');

      expect(result).toBe(true);
      expect(mockedVS.delete).toHaveBeenCalledWith('test_agent_memory', ['mem-1']);
    });

    it('returns false on error', async () => {
      mockedVS.delete.mockRejectedValue(new Error('fail'));

      const result = await memoryService.forget('test', 'mem-1');

      expect(result).toBe(false);
    });
  });

  describe('batchRemember', () => {
    it('embeds all texts in batch and upserts', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await memoryService.batchRemember('test', [
        { content: 'memory 1', type: 'note', tags: [] },
        { content: 'memory 2', type: 'insight', tags: ['important'] },
      ]);

      expect(result.saved).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(mockedEmbed.embedBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringContaining('note: memory 1'),
          expect.stringContaining('insight: memory 2'),
        ])
      );
      expect(mockedVS.upsert).toHaveBeenCalledTimes(1);
    });

    it('captures errors without throwing', async () => {
      mockedEmbed.embedBatch.mockRejectedValue(new Error('embed failed'));

      const result = await memoryService.batchRemember('test', [{ content: 'will fail' }]);

      expect(result.saved).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('embed failed');
    });
  });

  describe('forgetOlderThan', () => {
    it('deletes memories older than cutoff from durable', async () => {
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
      const recent = new Date().toISOString();

      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: 'old-1', payload: { createdAt: old } },
          { id: 'old-2', payload: { createdAt: old } },
          { id: 'recent-1', payload: { createdAt: recent } },
        ],
        next_page_offset: undefined,
      });
      mockedVS.delete.mockResolvedValue(undefined);

      const deleted = await memoryService.forgetOlderThan('test', 30);

      expect(deleted).toBe(2);
      expect(mockedVS.delete).toHaveBeenCalledWith('test_agent_memory', ['old-1', 'old-2']);
      expect(mockQdrantClient.scroll).toHaveBeenCalledWith('test_agent_memory', expect.anything());
    });

    it('targets quarantine collection when tier is quarantine', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'q-old',
            payload: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() },
          },
        ],
        next_page_offset: undefined,
      });
      mockedVS.delete.mockResolvedValue(undefined);

      const deleted = await memoryService.forgetOlderThan('test', 30, 'quarantine');

      expect(deleted).toBe(1);
      expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
        'test_memory_pending',
        expect.anything()
      );
      expect(mockedVS.delete).toHaveBeenCalledWith('test_memory_pending', ['q-old']);
    });

    it('returns 0 when collection does not exist (404)', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const deleted = await memoryService.forgetOlderThan('test', 30);

      expect(deleted).toBe(0);
    });

    it('paginates through large collections', async () => {
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: 'p1', payload: { createdAt: old } }],
          next_page_offset: 'next-1',
        })
        .mockResolvedValueOnce({
          points: [{ id: 'p2', payload: { createdAt: old } }],
          next_page_offset: undefined,
        });
      mockedVS.delete.mockResolvedValue(undefined);

      const deleted = await memoryService.forgetOlderThan('test', 30);

      expect(deleted).toBe(2);
      expect(mockQdrantClient.scroll).toHaveBeenCalledTimes(2);
    });
  });

  describe('forgetByType', () => {
    it('deletes memories by type filter', async () => {
      mockedVS.deleteByFilter.mockResolvedValue(undefined);

      const result = await memoryService.forgetByType('test', 'note');

      expect(result).toBe(1);
      expect(mockedVS.deleteByFilter).toHaveBeenCalledWith('test_agent_memory', {
        must: [{ key: 'type', match: { value: 'note' } }],
      });
    });

    it('returns 0 on error', async () => {
      mockedVS.deleteByFilter.mockRejectedValue(new Error('fail'));

      const result = await memoryService.forgetByType('test', 'note');
      expect(result).toBe(0);
    });
  });

  describe('updateTodoStatus', () => {
    it('updates todo status and statusHistory', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'todo-1',
          score: 0.95,
          payload: {
            type: 'todo',
            content: 'fix the bug',
            tags: [],
            createdAt: now,
            updatedAt: now,
            status: 'pending',
            statusHistory: [{ status: 'pending', timestamp: now }],
          },
        }),
      ]);
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await memoryService.updateTodoStatus('test', 'todo-1', 'done', 'completed');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('done');
      expect(result!.statusHistory).toHaveLength(2);
      expect(result!.statusHistory![1].status).toBe('done');
      expect(result!.statusHistory![1].note).toBe('completed');
      expect(mockedVS.upsert).toHaveBeenCalled();
    });

    it('returns null when todo not found', async () => {
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'other-id',
          score: 0.5,
          payload: {
            type: 'todo',
            content: 'different',
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      ]);

      const result = await memoryService.updateTodoStatus('test', 'todo-missing', 'done');
      expect(result).toBeNull();
    });
  });

  describe('getStats', () => {
    it('returns total and byType counts', async () => {
      mockedVS.getCollectionInfo.mockResolvedValue({
        vectorsCount: 50,
        segmentsCount: 1,
        indexedFields: ['type'],
      } as any);
      mockedVS.aggregateByField.mockResolvedValue({
        decision: 10,
        insight: 15,
        note: 20,
        todo: 5,
      });

      const stats = await memoryService.getStats('test');

      expect(stats.total).toBe(50);
      expect(stats.byType.decision).toBe(10);
      expect(stats.byType.insight).toBe(15);
      expect(stats.byType.note).toBe(20);
      expect(stats.byType.todo).toBe(5);
      expect(stats.byType.context).toBe(0);
      expect(stats.byType.conversation).toBe(0);
    });
  });

  describe('validateMemory', () => {
    it('marks memory as validated', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'mem-v',
          score: 0.95,
          payload: {
            type: 'insight',
            content: 'auto-extracted fact',
            tags: ['auto'],
            createdAt: now,
            updatedAt: now,
            validated: false,
          },
        }),
      ]);
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await memoryService.validateMemory('test', 'mem-v', true);

      expect(result).not.toBeNull();
      expect(result!.validated).toBe(true);
      expect(result!.metadata?.validatedAt).toBeDefined();
      expect(mockedVS.upsert).toHaveBeenCalled();
    });

    it('returns null when memory not found', async () => {
      mockedVS.search.mockResolvedValue([]);

      const result = await memoryService.validateMemory('test', 'missing', true);
      expect(result).toBeNull();
    });
  });

  describe('mergeMemories', () => {
    it('returns empty result when fewer than 2 memories', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [{ id: 'm1', payload: { type: 'note', content: 'only one', tags: [] } }],
        next_page_offset: undefined,
      });

      const result = await memoryService.mergeMemories({ projectName: 'test' });

      expect(result.totalMerged).toBe(0);
      expect(result.merged).toHaveLength(0);
    });

    it('dry run finds clusters without modifying', async () => {
      const now = new Date().toISOString();
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'm1',
            payload: {
              type: 'note',
              content: 'memory one',
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: 'm2',
            payload: {
              type: 'note',
              content: 'memory two',
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        next_page_offset: undefined,
      });

      mockedVS.recommend.mockResolvedValue([
        {
          id: 'm2',
          score: 0.95,
          payload: {
            type: 'note',
            content: 'memory two',
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      ]);

      const { llm } = await import('../../services/llm');
      vi.mocked(llm.complete).mockResolvedValue({ text: 'merged content', usage: {} as any });

      const result = await memoryService.mergeMemories({
        projectName: 'test',
        dryRun: true,
        threshold: 0.9,
      });

      expect(result.totalMerged).toBe(1);
      expect(result.merged).toHaveLength(1);
      // Dry run should NOT upsert or delete
      expect(mockedVS.upsert).not.toHaveBeenCalled();
      expect(mockedVS.delete).not.toHaveBeenCalled();
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const result = await memoryService.mergeMemories({ projectName: 'test' });
      expect(result.totalMerged).toBe(0);
    });

    it('non-destructive merge: supersedes originals (no delete) and preserves governance state', async () => {
      const older = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const newer = new Date(Date.now() - 1 * 86_400_000).toISOString();

      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'm1',
            payload: {
              type: 'decision',
              content: 'use postgres',
              tags: ['db'],
              createdAt: older,
              updatedAt: older,
              validated: true,
              confidence: 0.7,
              source: 'manual',
              metadata: { promotedAt: older },
            },
          },
          {
            id: 'm2',
            payload: {
              type: 'decision',
              content: 'postgres chosen for db',
              tags: ['db'],
              createdAt: newer,
              updatedAt: newer,
              confidence: 0.9,
              source: 'auto_pattern',
            },
          },
        ],
        next_page_offset: undefined,
      });

      mockedVS.recommend.mockResolvedValue([
        {
          id: 'm2',
          score: 0.95,
          payload: {
            type: 'decision',
            content: 'postgres chosen for db',
            tags: ['db'],
            createdAt: newer,
            updatedAt: newer,
            confidence: 0.9,
            source: 'auto_pattern',
          },
        },
      ]);

      const { llm } = await import('../../services/llm');
      vi.mocked(llm.complete).mockResolvedValue({ text: 'use postgres for db', usage: {} as any });

      const result = await memoryService.mergeMemories({
        projectName: 'test',
        dryRun: false,
        threshold: 0.9,
      });

      expect(result.totalMerged).toBe(1);

      // Originals must NOT be deleted — they are superseded instead.
      expect(mockedVS.delete).not.toHaveBeenCalled();
      expect(mockQdrantClient.setPayload).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.objectContaining({
          points: ['m1'],
          payload: expect.objectContaining({ supersededBy: expect.any(String) }),
        })
      );

      // Merged memory carries over governance state + newest createdAt (no decay reset).
      const merged = result.merged[0].merged;
      expect(merged.validated).toBe(true);
      expect(merged.confidence).toBe(0.9); // max(0.7, 0.9)
      expect(merged.source).toBe('manual'); // strongest provenance
      expect(merged.createdAt).toBe(newer); // newest, not oldest
      expect(merged.metadata?.promotedAt).toBe(older);
    });

    it('constrains clusters to the same type (passes a type filter to recommend)', async () => {
      const now = new Date().toISOString();
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'd1',
            payload: { type: 'decision', content: 'a', tags: [], createdAt: now, updatedAt: now },
          },
          {
            id: 'n1',
            payload: { type: 'note', content: 'b', tags: [], createdAt: now, updatedAt: now },
          },
        ],
        next_page_offset: undefined,
      });
      mockedVS.recommend.mockResolvedValue([]);

      await memoryService.mergeMemories({ projectName: 'test', dryRun: true, threshold: 0.9 });

      expect(mockedVS.recommend).toHaveBeenCalledWith(
        'test_agent_memory',
        ['d1'],
        [],
        10,
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'type', match: { value: 'decision' } },
            { is_empty: { key: 'supersededBy' } },
          ]),
        })
      );
    });

    it('does not re-cluster superseded originals (scroll excludes + recommend post-filters)', async () => {
      const now = new Date().toISOString();
      // The scroll mock returns ONLY the live merged successor — the real Qdrant
      // is_empty filter would already exclude the superseded original. We assert the
      // scroll filter carries that exclusion so superseded points never load.
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'merged-successor',
            payload: {
              type: 'note',
              content: 'merged result',
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        next_page_offset: undefined,
      });

      // recommend leaks a superseded original (e.g. a client that ignores is_empty).
      // The defensive post-filter must drop it so it can't form a re-merge cluster.
      mockedVS.recommend.mockResolvedValue([
        {
          id: 'old-original',
          score: 0.99,
          payload: {
            type: 'note',
            content: 'merged result',
            tags: [],
            createdAt: now,
            updatedAt: now,
            supersededBy: 'merged-successor',
          },
        },
      ]);

      const result = await memoryService.mergeMemories({
        projectName: 'test',
        dryRun: true,
        threshold: 0.9,
      });

      // Scroll filter must require supersededBy to be empty.
      expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ is_empty: { key: 'supersededBy' } }]),
          }),
        })
      );

      // The superseded original was post-filtered out, so no cluster (>=2) forms and
      // nothing is re-merged — no unbounded re-merge loop.
      expect(result.totalMerged).toBe(0);
      expect(result.merged).toHaveLength(0);
    });

    it('preserves pin + trigger on the merged memory', async () => {
      const older = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const newer = new Date(Date.now() - 1 * 86_400_000).toISOString();
      const trigVec = mockEmbedding(1024);

      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'p1',
            payload: {
              type: 'procedure',
              content: 'always build before push',
              tags: [],
              createdAt: older,
              updatedAt: older,
              pin: 'repo',
            },
          },
          {
            id: 'p2',
            payload: {
              type: 'procedure',
              content: 'run npm build prior to pushing',
              tags: [],
              createdAt: newer,
              updatedAt: newer,
              pin: 'all', // strongest pin in the cluster
              triggerDescription: 'when pushing or committing',
              triggerEmbedding: trigVec,
            },
          },
        ],
        next_page_offset: undefined,
      });

      mockedVS.recommend.mockResolvedValue([
        {
          id: 'p2',
          score: 0.96,
          payload: {
            type: 'procedure',
            content: 'run npm build prior to pushing',
            tags: [],
            createdAt: newer,
            updatedAt: newer,
            pin: 'all',
            triggerDescription: 'when pushing or committing',
            triggerEmbedding: trigVec,
          },
        },
      ]);

      const { llm } = await import('../../services/llm');
      vi.mocked(llm.complete).mockResolvedValue({
        text: 'always run npm build before pushing',
        usage: {} as any,
      });

      const result = await memoryService.mergeMemories({
        projectName: 'test',
        dryRun: false,
        threshold: 0.9,
      });

      expect(result.totalMerged).toBe(1);
      const merged = result.merged[0].merged;
      // Strongest pin carried (all > repo), trigger cue preserved.
      expect(merged.pin).toBe('all');
      expect(merged.triggerDescription).toBe('when pushing or committing');
      // Non-dryRun re-embeds the carried trigger description so the stored vector
      // matches remember()'s document-side embed.
      expect(merged.triggerEmbedding).toEqual(fakeVector);
      expect(mockedEmbed.embed).toHaveBeenCalledWith('when pushing or committing');

      // The upserted payload must include pin + trigger so they are not stripped.
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_agent_memory',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              pin: 'all',
              triggerDescription: 'when pushing or committing',
            }),
          }),
        ])
      );
    });
  });

  describe('getUnvalidatedMemories', () => {
    it('returns unvalidated auto-extracted memories', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValue([
        mockSearchResult({
          id: 'unval-1',
          score: 0.8,
          payload: {
            type: 'insight',
            content: 'auto fact',
            tags: ['auto'],
            createdAt: now,
            updatedAt: now,
            validated: false,
            source: 'auto_conversation',
          },
        }),
      ]);

      const memories = await memoryService.getUnvalidatedMemories('test');

      expect(memories).toHaveLength(1);
      expect(memories[0].validated).toBe(false);
      expect(mockedVS.search).toHaveBeenCalledWith(
        'test_agent_memory',
        fakeVector,
        40, // limit * 2
        expect.objectContaining({
          must: expect.arrayContaining([{ key: 'validated', match: { value: false } }]),
        })
      );
    });
  });

  describe('list with filters', () => {
    it('applies type filter', async () => {
      mockedVS.search.mockResolvedValue([]);

      await memoryService.list({
        projectName: 'test',
        type: 'decision',
        limit: 5,
      });

      expect(mockedVS.search).toHaveBeenCalledWith('test_agent_memory', fakeVector, 5, {
        must: [{ key: 'type', match: { value: 'decision' } }],
      });
    });

    it('applies tag filter', async () => {
      mockedVS.search.mockResolvedValue([]);

      await memoryService.list({
        projectName: 'test',
        tag: 'important',
        limit: 5,
      });

      expect(mockedVS.search).toHaveBeenCalledWith('test_agent_memory', fakeVector, 5, {
        must: [{ key: 'tags', match: { any: ['important'] } }],
      });
    });

    it('applies both type and tag filters', async () => {
      mockedVS.search.mockResolvedValue([]);

      await memoryService.list({
        projectName: 'test',
        type: 'decision',
        tag: 'important',
        limit: 5,
      });

      expect(mockedVS.search).toHaveBeenCalledWith('test_agent_memory', fakeVector, 5, {
        must: [
          { key: 'type', match: { value: 'decision' } },
          { key: 'tags', match: { any: ['important'] } },
        ],
      });
    });
  });
});
