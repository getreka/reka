import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

vi.mock('../../config', () => ({
  default: {
    EPISODIC_BASE_STABILITY_DAYS: 7,
    SEMANTIC_BASE_STABILITY_DAYS: 90,
    PROCEDURAL_BASE_STABILITY_DAYS: 180,
    RECALL_STRENGTHENING_FACTOR: 1.5,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockQdrantClient = vi.hoisted(() => ({
  retrieve: vi.fn().mockResolvedValue([]),
  setPayload: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    ensureCollection: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    scrollCollection: vi.fn().mockResolvedValue({ points: [], nextOffset: undefined }),
    client: mockQdrantClient,
  },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
  },
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { memoryLtm, computeRetention } from '../../services/memory-ltm';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('computeRetention', () => {
  it('returns 1.0 for just-created memory', () => {
    const now = new Date().toISOString();
    const ret = computeRetention(now, 90, 0);
    expect(ret).toBeCloseTo(1.0, 1);
  });

  it('decays for old memory with no access', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    // S = 7 * (1 + 0 * 0.5) = 7, age = 30d
    // R = e^(-30/7) = e^(-4.28) ≈ 0.014
    const ret = computeRetention(thirtyDaysAgo, 7, 0);
    expect(ret).toBeLessThan(0.05);
  });

  it('strengthens with access count', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    // Without access: S=7, R=e^(-30/7)≈0.014
    // With 5 accesses: S=7*(1+5*0.5)=24.5, R=e^(-30/24.5)≈0.294
    const withoutAccess = computeRetention(thirtyDaysAgo, 7, 0);
    const withAccess = computeRetention(thirtyDaysAgo, 7, 5);
    expect(withAccess).toBeGreaterThan(withoutAccess * 10);
  });

  it('semantic memory (90d stability) retains well at 30 days', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    // S = 90, R = e^(-30/90) = e^(-0.33) ≈ 0.72
    const ret = computeRetention(thirtyDaysAgo, 90, 0);
    expect(ret).toBeGreaterThan(0.6);
    expect(ret).toBeLessThan(0.8);
  });

  it('procedural memory (180d stability) retains very well at 30 days', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    // S = 180, R = e^(-30/180) = e^(-0.167) ≈ 0.846
    const ret = computeRetention(thirtyDaysAgo, 180, 0);
    expect(ret).toBeGreaterThan(0.8);
  });
});

describe('LongTermMemoryService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
  });

  describe('storeEpisodic', () => {
    it('creates episodic memory with correct fields', async () => {
      const mem = await memoryLtm.storeEpisodic({
        projectName: 'test',
        content: 'Debugged auth issue in auth.ts',
        sessionId: 'sess-123',
        files: ['src/auth.ts'],
        tags: ['debug'],
      });

      expect(mem.id).toBeDefined();
      expect(mem.content).toBe('Debugged auth issue in auth.ts');
      expect(mem.sessionId).toBe('sess-123');
      expect(mem.stability).toBe(7); // EPISODIC_BASE_STABILITY_DAYS
      expect(mem.accessCount).toBe(0);
      expect(mockedVS.upsert).toHaveBeenCalledWith('test_memory_episodic', expect.any(Array));
    });

    it('embeds with [episodic] prefix', async () => {
      await memoryLtm.storeEpisodic({
        projectName: 'test',
        content: 'some event',
        sessionId: 'sess',
      });

      expect(mockedEmbed.embed).toHaveBeenCalledWith('[episodic] some event');
    });
  });

  describe('storeSemantic', () => {
    it('creates semantic memory with subtype and stability', async () => {
      const mem = await memoryLtm.storeSemantic({
        projectName: 'test',
        content: 'Auth uses JWT with RS256',
        subtype: 'decision',
        tags: ['auth', 'jwt'],
      });

      expect(mem.subtype).toBe('decision');
      expect(mem.stability).toBe(90); // SEMANTIC_BASE_STABILITY_DAYS
      expect(mem.confidence).toBe(0.7);
      expect(mockedVS.upsert).toHaveBeenCalledWith('test_memory_semantic', expect.any(Array));
    });

    it('uses procedural stability for procedure subtype', async () => {
      const mem = await memoryLtm.storeSemantic({
        projectName: 'test',
        content: 'To deploy: stop docker, build, start local',
        subtype: 'procedure',
      });

      expect(mem.stability).toBe(180); // PROCEDURAL_BASE_STABILITY_DAYS
    });
  });

  describe('recall', () => {
    it('searches both collections in parallel', async () => {
      await memoryLtm.recall({
        projectName: 'test',
        query: 'auth',
        limit: 5,
      });

      // Should search both collections
      expect(mockedVS.search).toHaveBeenCalledTimes(2);
      expect(mockedVS.search.mock.calls[0][0]).toBe('test_memory_episodic');
      expect(mockedVS.search.mock.calls[1][0]).toBe('test_memory_semantic');
    });

    it('filters out memories with retention below threshold', async () => {
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString(); // 60d ago
      mockedVS.search
        .mockResolvedValueOnce([
          {
            id: 'old-ep',
            score: 0.8,
            payload: {
              id: 'old-ep',
              content: 'old event',
              timestamp: oldDate,
              stability: 7, // episodic — will decay heavily
              accessCount: 0,
              tags: [],
              sessionId: 's1',
              files: [],
              actions: [],
            },
          },
        ])
        .mockResolvedValueOnce([]);

      const results = await memoryLtm.recall({
        projectName: 'test',
        query: 'anything',
        minRetention: 0.1,
      });

      // 60d with stability=7, retention = e^(-60/7) ≈ 0.0002 → filtered
      expect(results).toHaveLength(0);
    });

    it('returns results sorted by retention-weighted score', async () => {
      const now = new Date().toISOString();
      mockedVS.search
        .mockResolvedValueOnce([]) // episodic empty
        .mockResolvedValueOnce([
          {
            id: 'sem-1',
            score: 0.7,
            payload: {
              id: 'sem-1',
              content: 'fact A',
              createdAt: now,
              stability: 90,
              accessCount: 3,
              tags: [],
              subtype: 'insight',
            },
          },
          {
            id: 'sem-2',
            score: 0.9,
            payload: {
              id: 'sem-2',
              content: 'fact B',
              createdAt: now,
              stability: 90,
              accessCount: 0,
              tags: [],
              subtype: 'decision',
            },
          },
        ]);

      const results = await memoryLtm.recall({
        projectName: 'test',
        query: 'test',
        limit: 10,
      });

      expect(results).toHaveLength(2);
      // Both fresh → retention ≈ 1.0, so score order matches vector score
      expect(results[0].memory.id).toBe('sem-2');
    });

    it('skips superseded memories', async () => {
      const now = new Date().toISOString();
      mockedVS.search.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'sup',
          score: 0.9,
          payload: {
            id: 'sup',
            content: 'old',
            createdAt: now,
            stability: 90,
            accessCount: 0,
            supersededBy: 'new-id',
            tags: [],
          },
        },
      ]);

      const results = await memoryLtm.recall({ projectName: 'test', query: 'test' });
      expect(results).toHaveLength(0);
    });
  });

  describe('strengthenOnRecall', () => {
    it('increments accessCount and stability', async () => {
      mockQdrantClient.retrieve.mockResolvedValue([
        {
          id: 'mem-1',
          payload: { accessCount: 2, stability: 90 },
        },
      ]);

      await memoryLtm.strengthenOnRecall('test', 'mem-1', 'semantic');

      expect(mockQdrantClient.setPayload).toHaveBeenCalledWith(
        'test_memory_semantic',
        expect.objectContaining({
          points: ['mem-1'],
          payload: expect.objectContaining({
            accessCount: 3,
            stability: 135, // 90 * 1.5
          }),
        })
      );
    });
  });
});
