import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    deleteByFilter: vi.fn(),
    client: mockQdrantClient,
  },
  default: {
    upsert: vi.fn(),
    deleteByFilter: vi.fn(),
    client: mockQdrantClient,
  },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
  },
  default: {
    embed: vi.fn(),
  },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
  default: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/metrics', () => ({
  graphEdgesTotal: { inc: vi.fn() },
  graphExpansionDuration: { observe: vi.fn() },
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { graphStore } from '../../services/graph-store';
import type { GraphEdge } from '../../services/parsers/ast-parser';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('GraphStoreService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.resetAllMocks();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
    // Default: no edges
    mockQdrantClient.scroll.mockResolvedValue({ points: [], next_page_offset: undefined });
    mockedVS.upsert.mockResolvedValue(undefined);
    mockedVS.deleteByFilter.mockResolvedValue(undefined);
  });

  describe('indexFileEdges', () => {
    it('clears existing edges then upserts new edge points to {project}_graph', async () => {
      const edges: GraphEdge[] = [
        {
          fromFile: 'src/a.ts',
          fromSymbol: 'MyClass',
          toFile: 'src/b.ts',
          toSymbol: 'BaseClass',
          edgeType: 'extends',
        },
        {
          fromFile: 'src/a.ts',
          fromSymbol: 'myFn',
          toFile: 'src/c.ts',
          toSymbol: 'helper',
          edgeType: 'calls',
        },
      ];

      await graphStore.indexFileEdges('testproj', 'src/a.ts', edges);

      // deleteByFilter called first to clear old edges
      expect(mockedVS.deleteByFilter).toHaveBeenCalledWith(
        'testproj_graph',
        { must: [{ key: 'fromFile', match: { value: 'src/a.ts' } }] }
      );

      // One embed per edge
      expect(mockedEmbed.embed).toHaveBeenCalledTimes(2);

      // Upsert with 2 points
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'testproj_graph',
        expect.arrayContaining([
          expect.objectContaining({
            vector: fakeVector,
            payload: expect.objectContaining({
              fromFile: 'src/a.ts',
              toFile: 'src/b.ts',
              edgeType: 'extends',
              project: 'testproj',
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              edgeType: 'calls',
            }),
          }),
        ])
      );
    });

    it('skips upsert when edges array is empty', async () => {
      await graphStore.indexFileEdges('testproj', 'src/empty.ts', []);

      // deleteByFilter still called
      expect(mockedVS.deleteByFilter).toHaveBeenCalledOnce();
      expect(mockedEmbed.embed).not.toHaveBeenCalled();
      expect(mockedVS.upsert).not.toHaveBeenCalled();
    });

    it('stores correct payload fields per edge point', async () => {
      const edges: GraphEdge[] = [
        {
          fromFile: 'src/x.ts',
          fromSymbol: 'Foo',
          toFile: 'src/y.ts',
          toSymbol: 'Bar',
          edgeType: 'imports',
        },
      ];

      await graphStore.indexFileEdges('proj', 'src/x.ts', edges);

      const upsertCall = mockedVS.upsert.mock.calls[0];
      const point = upsertCall[1][0];
      expect(point.payload.fromFile).toBe('src/x.ts');
      expect(point.payload.fromSymbol).toBe('Foo');
      expect(point.payload.toFile).toBe('src/y.ts');
      expect(point.payload.toSymbol).toBe('Bar');
      expect(point.payload.edgeType).toBe('imports');
      expect(point.payload.project).toBe('proj');
    });
  });

  describe('expand', () => {
    it('returns seed files plus 1-hop connected files', async () => {
      // First scroll: outgoing edges from src/a.ts → src/b.ts
      // Second scroll: incoming edges to src/a.ts → none
      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: 'e1', payload: { toFile: 'src/b.ts' } }],
          next_page_offset: undefined,
        })
        .mockResolvedValueOnce({
          points: [],
          next_page_offset: undefined,
        })
        // hop for src/b.ts outgoing
        .mockResolvedValueOnce({
          points: [],
          next_page_offset: undefined,
        })
        // hop for src/b.ts incoming
        .mockResolvedValueOnce({
          points: [],
          next_page_offset: undefined,
        });

      const result = await graphStore.expand('testproj', ['src/a.ts'], 1);

      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
    });

    it('returns only seed files when no edges exist (1-hop)', async () => {
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [], next_page_offset: undefined })
        .mockResolvedValueOnce({ points: [], next_page_offset: undefined });

      const result = await graphStore.expand('testproj', ['src/lone.ts'], 1);

      expect(result).toEqual(['src/lone.ts']);
    });

    it('expands 2 hops to find transitively connected files', async () => {
      // Hop 1 from src/a.ts: outgoing → src/b.ts, incoming → none
      // Hop 2 from src/b.ts: outgoing → src/c.ts, incoming → none
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [{ id: 'e1', payload: { toFile: 'src/b.ts' } }], next_page_offset: undefined })
        .mockResolvedValueOnce({ points: [], next_page_offset: undefined })
        .mockResolvedValueOnce({ points: [{ id: 'e2', payload: { toFile: 'src/c.ts' } }], next_page_offset: undefined })
        .mockResolvedValueOnce({ points: [], next_page_offset: undefined });

      const result = await graphStore.expand('testproj', ['src/a.ts'], 2);

      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
      expect(result).toContain('src/c.ts');
    });

    it('handles 404 gracefully and returns seed files', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockQdrantClient.scroll.mockRejectedValue(err);

      const result = await graphStore.expand('testproj', ['src/a.ts'], 1);

      expect(result).toEqual(['src/a.ts']);
    });

    it('does not duplicate files already in visited set', async () => {
      // Both outgoing and incoming return the same file src/b.ts
      mockQdrantClient.scroll
        .mockResolvedValueOnce({ points: [{ id: 'e1', payload: { toFile: 'src/b.ts' } }], next_page_offset: undefined })
        .mockResolvedValueOnce({ points: [{ id: 'e2', payload: { fromFile: 'src/b.ts' } }], next_page_offset: undefined });

      const result = await graphStore.expand('testproj', ['src/a.ts'], 1);

      const unique = new Set(result);
      expect(unique.size).toBe(result.length);
    });
  });

  describe('getBlastRadius', () => {
    it('finds all files affected (upstream dependents) with depth limit', async () => {
      // Depth 1: who imports src/core.ts → src/feature.ts
      // Depth 2: who imports src/feature.ts → none
      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: 'e1', payload: { fromFile: 'src/feature.ts' } }],
          next_page_offset: undefined,
        })
        .mockResolvedValueOnce({
          points: [],
          next_page_offset: undefined,
        });

      const result = await graphStore.getBlastRadius('testproj', ['src/core.ts'], 2);

      expect(result.affectedFiles).toContain('src/core.ts');
      expect(result.affectedFiles).toContain('src/feature.ts');
      expect(result.edgeCount).toBeGreaterThanOrEqual(1);
    });

    it('returns only seed files when no dependents exist', async () => {
      mockQdrantClient.scroll.mockResolvedValue({ points: [], next_page_offset: undefined });

      const result = await graphStore.getBlastRadius('testproj', ['src/isolated.ts'], 3);

      expect(result.affectedFiles).toEqual(['src/isolated.ts']);
      expect(result.edgeCount).toBe(0);
    });

    it('handles 404 gracefully and returns seed files', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockQdrantClient.scroll.mockRejectedValue(err);

      const result = await graphStore.getBlastRadius('testproj', ['src/x.ts'], 3);

      expect(result.affectedFiles).toEqual(['src/x.ts']);
    });

    it('respects maxDepth and does not traverse beyond it', async () => {
      // With maxDepth=1, only traverse one level regardless of further edges
      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: 'e1', payload: { fromFile: 'src/level1.ts' } }],
          next_page_offset: undefined,
        });
      // No second call should reach level2

      const result = await graphStore.getBlastRadius('testproj', ['src/root.ts'], 1);

      expect(result.affectedFiles).toContain('src/level1.ts');
      // With maxDepth=1, scroll was called exactly once (for the single depth pass)
      expect(mockQdrantClient.scroll).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDependents', () => {
    it('returns edges where toFile matches the given file', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 'e1',
            payload: {
              fromFile: 'src/consumer.ts',
              fromSymbol: 'Consumer',
              toFile: 'src/service.ts',
              toSymbol: 'ServiceClass',
              edgeType: 'imports',
            },
          },
        ],
        next_page_offset: undefined,
      });

      const edges = await graphStore.getDependents('testproj', 'src/service.ts');

      expect(edges).toHaveLength(1);
      expect(edges[0].fromFile).toBe('src/consumer.ts');
      expect(edges[0].toFile).toBe('src/service.ts');
    });

    it('returns empty array when collection does not exist (404)', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockQdrantClient.scroll.mockRejectedValue(err);

      const edges = await graphStore.getDependents('testproj', 'src/x.ts');

      expect(edges).toEqual([]);
    });
  });
});
