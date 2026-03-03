import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock object exists before vi.mock factory runs
const mockQdrantClient = vi.hoisted(() => ({
  getCollections: vi.fn(),
  getCollection: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  upsert: vi.fn(),
  search: vi.fn(),
  searchPointGroups: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  scroll: vi.fn(),
  recommend: vi.fn(),
  updateCollectionAliases: vi.fn(),
  getCollectionAliases: vi.fn(),
  updateCollection: vi.fn(),
  createSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => mockQdrantClient),
}));

import { vectorStore } from '../../services/vector-store';

describe('VectorStoreService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureCollection', () => {
    it('creates collection when it does not exist', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [],
      });
      mockQdrantClient.createCollection.mockResolvedValue(true);
      mockQdrantClient.createPayloadIndex.mockResolvedValue(true);

      await vectorStore.ensureCollection('test_codebase');

      expect(mockQdrantClient.createCollection).toHaveBeenCalledWith(
        'test_codebase',
        expect.objectContaining({
          vectors: expect.objectContaining({ size: 1024, distance: 'Cosine' }),
        })
      );
    });

    it('skips creation when collection already exists', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'test_codebase' }],
      });

      await vectorStore.ensureCollection('test_codebase');

      expect(mockQdrantClient.createCollection).not.toHaveBeenCalled();
    });
  });

  describe('upsert', () => {
    it('batches points in groups of 100', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'col' }],
      });
      mockQdrantClient.upsert.mockResolvedValue(true);

      const points = Array.from({ length: 150 }, (_, i) => ({
        id: `id-${i}`,
        vector: [0.1],
        payload: { idx: i },
      }));

      await vectorStore.upsert('col', points);

      // Should have 2 batches: 100 + 50
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(2);
      const firstBatch = mockQdrantClient.upsert.mock.calls[0][1].points;
      const secondBatch = mockQdrantClient.upsert.mock.calls[1][1].points;
      expect(firstBatch).toHaveLength(100);
      expect(secondBatch).toHaveLength(50);
    });

    it('generates UUIDs for points without IDs', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'col' }],
      });
      mockQdrantClient.upsert.mockResolvedValue(true);

      await vectorStore.upsert('col', [
        { vector: [0.1], payload: { test: true } },
      ]);

      const points = mockQdrantClient.upsert.mock.calls[0][1].points;
      expect(points[0].id).toBeDefined();
      expect(typeof points[0].id).toBe('string');
    });
  });

  describe('search', () => {
    it('returns mapped results on success', async () => {
      mockQdrantClient.search.mockResolvedValue([
        { id: 'a', score: 0.9, payload: { file: 'x.ts' } },
        { id: 'b', score: 0.8, payload: { file: 'y.ts' } },
      ]);

      const results = await vectorStore.search('col', [0.1, 0.2], 5);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: 'a',
        score: 0.9,
        payload: { file: 'x.ts' },
      });
    });

    it('falls back to anonymous vector on 400 error', async () => {
      const error400 = new Error('Bad Request');
      (error400 as any).status = 400;

      mockQdrantClient.search
        .mockRejectedValueOnce(error400)
        .mockResolvedValueOnce([
          { id: 'c', score: 0.7, payload: { file: 'z.ts' } },
        ]);

      const results = await vectorStore.search('col', [0.1], 5);

      expect(results).toHaveLength(1);
      expect(mockQdrantClient.search).toHaveBeenCalledTimes(2);
    });

    it('returns empty array on 404', async () => {
      const error404 = new Error('Not found');
      (error404 as any).status = 404;
      mockQdrantClient.search.mockRejectedValue(error404);

      const results = await vectorStore.search('missing', [0.1], 5);

      expect(results).toEqual([]);
    });
  });

  describe('delete', () => {
    it('deletes points by IDs', async () => {
      mockQdrantClient.delete.mockResolvedValue(true);

      await vectorStore.delete('col', ['id-1', 'id-2']);

      expect(mockQdrantClient.delete).toHaveBeenCalledWith('col', {
        wait: true,
        points: ['id-1', 'id-2'],
      });
    });
  });

  describe('deleteByFilter', () => {
    it('deletes points by filter', async () => {
      mockQdrantClient.delete.mockResolvedValue(true);

      const filter = { must: [{ key: 'type', match: { value: 'note' } }] };
      await vectorStore.deleteByFilter('col', filter);

      expect(mockQdrantClient.delete).toHaveBeenCalledWith('col', {
        wait: true,
        filter,
      });
    });
  });

  describe('count', () => {
    it('returns count with filter', async () => {
      mockQdrantClient.count.mockResolvedValue({ count: 42 });

      const filter = { must: [{ key: 'type', match: { value: 'note' } }] };
      const result = await vectorStore.count('col', filter);

      expect(result).toBe(42);
      expect(mockQdrantClient.count).toHaveBeenCalledWith('col', {
        filter,
        exact: true,
      });
    });

    it('returns points_count without filter', async () => {
      mockQdrantClient.getCollection.mockResolvedValue({
        points_count: 100,
      });

      const result = await vectorStore.count('col');

      expect(result).toBe(100);
    });

    it('returns 0 on 404', async () => {
      const error404 = new Error('Not found');
      (error404 as any).status = 404;
      mockQdrantClient.getCollection.mockRejectedValue(error404);

      const result = await vectorStore.count('missing');

      expect(result).toBe(0);
    });
  });

  describe('listCollections', () => {
    it('returns collection names', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'a' }, { name: 'b' }],
      });

      const result = await vectorStore.listCollections();

      expect(result).toEqual(['a', 'b']);
    });
  });

  describe('alias management', () => {
    it('creates an alias', async () => {
      mockQdrantClient.updateCollectionAliases.mockResolvedValue(true);

      await vectorStore.createAlias('my_alias', 'my_collection');

      expect(mockQdrantClient.updateCollectionAliases).toHaveBeenCalledWith({
        actions: [
          { create_alias: { alias_name: 'my_alias', collection_name: 'my_collection' } },
        ],
      });
    });

    it('lists aliases from all collections', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'col1' }],
      });
      mockQdrantClient.getCollectionAliases.mockResolvedValue({
        aliases: [{ alias_name: 'alias1' }],
      });

      const aliases = await vectorStore.listAliases();

      expect(aliases).toEqual([{ alias: 'alias1', collection: 'col1' }]);
    });
  });

  describe('searchHybridNative', () => {
    it('uses Query API with prefetch + RRF', async () => {
      mockQdrantClient.query.mockResolvedValue({
        points: [
          { id: 'x', score: 0.95, payload: { file: 'a.ts' } },
        ],
      });

      const results = await vectorStore.searchHybridNative(
        'col',
        [0.1],
        { indices: [1], values: [0.5] },
        5
      );

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('x');
      expect(mockQdrantClient.query).toHaveBeenCalled();
    });

    it('falls back to client-side RRF on Query API failure', async () => {
      mockQdrantClient.query.mockRejectedValue(new Error('not supported'));
      // Dense search (named vector fails with 400, anonymous succeeds)
      const error400 = new Error('Bad Request');
      (error400 as any).status = 400;
      mockQdrantClient.search
        .mockRejectedValueOnce(error400)
        .mockResolvedValueOnce([
          { id: 'd1', score: 0.9, payload: { file: 'a.ts' } },
        ])
        .mockResolvedValueOnce([
          { id: 's1', score: 0.8, payload: { file: 'b.ts' } },
        ]);

      const results = await vectorStore.searchHybridNative(
        'col',
        [0.1],
        { indices: [1], values: [0.5] },
        5
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('searchGroups', () => {
    it('returns grouped results from searchPointGroups', async () => {
      mockQdrantClient.searchPointGroups.mockResolvedValue({
        groups: [
          {
            id: 'src/a.ts',
            hits: [{ id: 'p1', score: 0.9, payload: { file: 'src/a.ts' } }],
          },
        ],
      });

      const results = await vectorStore.searchGroups('col', [0.1], 'file', 10);

      expect(results).toHaveLength(1);
      expect(results[0].group).toBe('src/a.ts');
      expect(results[0].results[0].id).toBe('p1');
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.searchPointGroups.mockRejectedValue(err);

      const results = await vectorStore.searchGroups('col', [0.1], 'file');
      expect(results).toEqual([]);
    });

    it('falls back to client-side grouping on non-404 error', async () => {
      mockQdrantClient.searchPointGroups.mockRejectedValue(new Error('unsupported'));
      mockQdrantClient.search.mockResolvedValue([
        { id: 'p1', score: 0.9, payload: { file: 'a.ts' } },
        { id: 'p2', score: 0.8, payload: { file: 'a.ts' } },
        { id: 'p3', score: 0.7, payload: { file: 'b.ts' } },
      ]);

      const results = await vectorStore.searchGroups('col', [0.1], 'file', 10, 1);

      expect(results.length).toBeGreaterThanOrEqual(2);
      // Each group should have at most groupSize=1 result
      for (const group of results) {
        expect(group.results.length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('aggregateByField', () => {
    it('counts field values from scroll', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: '1', payload: { type: 'note' } },
          { id: '2', payload: { type: 'note' } },
          { id: '3', payload: { type: 'decision' } },
        ],
        next_page_offset: undefined,
      });

      const counts = await vectorStore.aggregateByField('col', 'type');

      expect(counts.note).toBe(2);
      expect(counts.decision).toBe(1);
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const counts = await vectorStore.aggregateByField('missing', 'type');
      expect(counts).toEqual({});
    });
  });

  describe('scrollCollection', () => {
    it('returns mapped points with nextOffset', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: 'p1', payload: { file: 'a.ts' } },
        ],
        next_page_offset: 'next-1',
      });

      const result = await vectorStore.scrollCollection('col', 100);

      expect(result.points).toHaveLength(1);
      expect(result.points[0].id).toBe('p1');
      expect(result.nextOffset).toBe('next-1');
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const result = await vectorStore.scrollCollection('missing');
      expect(result.points).toEqual([]);
    });
  });

  describe('recommend', () => {
    it('returns recommendations from positive IDs', async () => {
      mockQdrantClient.recommend.mockResolvedValue([
        { id: 'r1', score: 0.95, payload: { file: 'related.ts' } },
      ]);

      const results = await vectorStore.recommend('col', ['id-1']);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('r1');
      expect(mockQdrantClient.recommend).toHaveBeenCalledWith(
        'col',
        expect.objectContaining({
          positive: ['id-1'],
          negative: [],
          limit: 10,
        })
      );
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.recommend.mockRejectedValue(err);

      const results = await vectorStore.recommend('col', ['id-1']);
      expect(results).toEqual([]);
    });
  });

  describe('quantization', () => {
    it('enableQuantization calls updateCollection with scalar config', async () => {
      mockQdrantClient.updateCollection.mockResolvedValue(true);

      await vectorStore.enableQuantization('col');

      expect(mockQdrantClient.updateCollection).toHaveBeenCalledWith(
        'col',
        expect.objectContaining({
          quantization_config: expect.objectContaining({
            scalar: expect.objectContaining({ type: 'int8' }),
          }),
        })
      );
    });

    it('disableQuantization calls updateCollection with null config', async () => {
      mockQdrantClient.updateCollection.mockResolvedValue(true);

      await vectorStore.disableQuantization('col');

      expect(mockQdrantClient.updateCollection).toHaveBeenCalledWith(
        'col',
        expect.objectContaining({ quantization_config: null })
      );
    });
  });

  describe('snapshots', () => {
    it('createSnapshot returns snapshot info', async () => {
      mockQdrantClient.createSnapshot.mockResolvedValue({ name: 'snap-1' });

      const result = await vectorStore.createSnapshot('col');

      expect(result.name).toBe('snap-1');
      expect(result.createdAt).toBeDefined();
    });

    it('listSnapshots returns mapped snapshots', async () => {
      mockQdrantClient.listSnapshots.mockResolvedValue([
        { name: 'snap-1', size: 1024, creation_time: '2025-01-01T00:00:00Z' },
      ]);

      const result = await vectorStore.listSnapshots('col');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('snap-1');
      expect(result[0].size).toBe(1024);
    });

    it('listSnapshots returns empty on error', async () => {
      mockQdrantClient.listSnapshots.mockRejectedValue(new Error('fail'));

      const result = await vectorStore.listSnapshots('col');
      expect(result).toEqual([]);
    });

    it('deleteSnapshot calls client', async () => {
      mockQdrantClient.deleteSnapshot.mockResolvedValue(true);

      await vectorStore.deleteSnapshot('col', 'snap-1');

      expect(mockQdrantClient.deleteSnapshot).toHaveBeenCalledWith('col', 'snap-1');
    });
  });

  describe('getCollectionInfo', () => {
    it('returns collection info with indexed fields', async () => {
      mockQdrantClient.getCollection.mockResolvedValue({
        points_count: 100,
        segments_count: 2,
        config: { params: { vectors: { size: 1024 } } },
        payload_schema: {
          type: { data_type: 'keyword' },
          file: { data_type: 'keyword' },
        },
      });

      const info = await vectorStore.getCollectionInfo('col');

      expect(info.vectorsCount).toBe(100);
      expect(info.indexedFields).toContain('type');
      expect(info.indexedFields).toContain('file');
    });
  });
});
