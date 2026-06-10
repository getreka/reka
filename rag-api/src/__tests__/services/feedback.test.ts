import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    search: vi.fn(),
    client: mockQdrantClient,
  },
  default: {
    upsert: vi.fn(),
    search: vi.fn(),
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

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { feedbackService } from '../../services/feedback';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('FeedbackService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.resetAllMocks();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
  });

  describe('submitSearchFeedback', () => {
    it('embeds query+feedback and upserts point to search_feedback collection', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await feedbackService.submitSearchFeedback({
        projectName: 'myproject',
        queryId: 'q-1',
        query: 'how does auth work',
        resultId: 'r-1',
        resultFile: 'src/auth.ts',
        feedbackType: 'helpful',
        sessionId: 'sess-1',
      });

      expect(result.id).toBeDefined();
      expect(result.projectName).toBe('myproject');
      expect(result.queryId).toBe('q-1');
      expect(result.query).toBe('how does auth work');
      expect(result.feedbackType).toBe('helpful');
      expect(result.timestamp).toBeDefined();

      expect(mockedEmbed.embed).toHaveBeenCalledWith(expect.stringContaining('how does auth work'));
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'myproject_search_feedback',
        expect.arrayContaining([
          expect.objectContaining({
            id: result.id,
            vector: fakeVector,
            payload: expect.objectContaining({
              feedbackType: 'helpful',
              resultFile: 'src/auth.ts',
            }),
          }),
        ])
      );
    });

    it('includes betterQuery in the embed text when provided', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      await feedbackService.submitSearchFeedback({
        projectName: 'proj',
        queryId: 'q-2',
        query: 'bad query',
        resultId: 'r-2',
        feedbackType: 'not_helpful',
        betterQuery: 'improved query',
      });

      expect(mockedEmbed.embed).toHaveBeenCalledWith(expect.stringContaining('improved query'));
    });

    it('throws when vectorStore.upsert fails', async () => {
      mockedVS.upsert.mockRejectedValue(new Error('Qdrant unavailable'));

      await expect(
        feedbackService.submitSearchFeedback({
          projectName: 'proj',
          queryId: 'q-3',
          query: 'query',
          resultId: 'r-3',
          feedbackType: 'helpful',
        })
      ).rejects.toThrow('Qdrant unavailable');
    });
  });

  describe('submitMemoryFeedback', () => {
    it('embeds memory content and upserts to memory_feedback collection', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      const result = await feedbackService.submitMemoryFeedback({
        projectName: 'myproject',
        memoryId: 'mem-1',
        memoryContent: 'Use singleton pattern for services',
        feedbackType: 'accurate',
        sessionId: 'sess-2',
      });

      expect(result.id).toBeDefined();
      expect(result.memoryId).toBe('mem-1');
      expect(result.feedbackType).toBe('accurate');

      expect(mockedEmbed.embed).toHaveBeenCalledWith(
        expect.stringContaining('Use singleton pattern for services')
      );
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'myproject_memory_feedback',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              memoryId: 'mem-1',
              feedbackType: 'accurate',
            }),
          }),
        ])
      );
    });

    it('includes correction in the embed text when provided', async () => {
      mockedVS.upsert.mockResolvedValue(undefined);

      await feedbackService.submitMemoryFeedback({
        projectName: 'proj',
        memoryId: 'mem-2',
        memoryContent: 'outdated info',
        feedbackType: 'outdated',
        correction: 'updated info here',
      });

      expect(mockedEmbed.embed).toHaveBeenCalledWith(expect.stringContaining('updated info here'));
    });

    it('throws when vectorStore.upsert fails', async () => {
      mockedVS.upsert.mockRejectedValue(new Error('write failed'));

      await expect(
        feedbackService.submitMemoryFeedback({
          projectName: 'proj',
          memoryId: 'mem-x',
          memoryContent: 'content',
          feedbackType: 'incorrect',
        })
      ).rejects.toThrow('write failed');
    });
  });

  describe('getMemoryFeedbackCounts', () => {
    it('aggregates feedback counts per memoryId', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: '1', payload: { memoryId: 'mem-a', feedbackType: 'accurate' } },
          { id: '2', payload: { memoryId: 'mem-a', feedbackType: 'accurate' } },
          { id: '3', payload: { memoryId: 'mem-a', feedbackType: 'outdated' } },
          { id: '4', payload: { memoryId: 'mem-b', feedbackType: 'incorrect' } },
        ],
        next_page_offset: undefined,
      });

      const counts = await feedbackService.getMemoryFeedbackCounts('myproject');

      expect(counts.get('mem-a')).toEqual({ accurate: 2, outdated: 1, incorrect: 0 });
      expect(counts.get('mem-b')).toEqual({ accurate: 0, outdated: 0, incorrect: 1 });
    });

    it('returns empty map when collection does not exist (404)', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockQdrantClient.scroll.mockRejectedValue(err);

      const counts = await feedbackService.getMemoryFeedbackCounts('proj');

      expect(counts.size).toBe(0);
    });

    it('returns empty map when no feedback exists', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [],
        next_page_offset: undefined,
      });

      const counts = await feedbackService.getMemoryFeedbackCounts('empty-proj');

      expect(counts.size).toBe(0);
    });

    it('skips entries without memoryId', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          { id: '1', payload: { feedbackType: 'accurate' } }, // no memoryId
          { id: '2', payload: { memoryId: 'mem-z', feedbackType: 'accurate' } },
        ],
        next_page_offset: undefined,
      });

      const counts = await feedbackService.getMemoryFeedbackCounts('proj');

      expect(counts.size).toBe(1);
      expect(counts.has('mem-z')).toBe(true);
    });
  });

  describe('getSuggestedQueries', () => {
    it('returns betterQuery suggestions from not_helpful feedback', async () => {
      mockedVS.search.mockResolvedValue([
        {
          id: 'fb-1',
          score: 0.9,
          payload: {
            feedbackType: 'not_helpful',
            query: 'how auth',
            betterQuery: 'how does JWT auth work',
          },
        },
        {
          id: 'fb-2',
          score: 0.8,
          payload: {
            feedbackType: 'not_helpful',
            query: 'auth',
            betterQuery: null, // no betterQuery — should be skipped
          },
        },
      ]);

      const suggestions = await feedbackService.getSuggestedQueries('proj', 'auth');

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].betterQuery).toBe('how does JWT auth work');
      expect(suggestions[0].score).toBe(0.9);
    });

    it('returns empty array when search fails', async () => {
      mockedVS.search.mockRejectedValue(new Error('search error'));

      const suggestions = await feedbackService.getSuggestedQueries('proj', 'query');

      expect(suggestions).toEqual([]);
    });
  });
});
