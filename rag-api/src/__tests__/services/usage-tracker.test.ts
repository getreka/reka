import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    search: vi.fn(),
    client: mockQdrantClient,
  },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid',
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { usageTracker } from '../../services/usage-tracker';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('UsageTrackerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEmbed.embed.mockResolvedValue([0.1, 0.2]);
    mockedVS.upsert.mockResolvedValue(undefined);
  });

  describe('track()', () => {
    it('creates usage record, embeds, and upserts', async () => {
      const usage = await usageTracker.track({
        projectName: 'test',
        sessionId: 'sess-1',
        toolName: 'search_codebase',
        inputSummary: 'find auth',
        startTime: Date.now() - 100,
        resultCount: 5,
        success: true,
      });

      expect(usage.id).toBe('test-uuid');
      expect(usage.toolName).toBe('search_codebase');
      expect(usage.success).toBe(true);
      expect(usage.durationMs).toBeGreaterThanOrEqual(0);

      expect(mockedEmbed.embed).toHaveBeenCalledWith('search_codebase: find auth');
      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'test_tool_usage',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'test-uuid',
            vector: [0.1, 0.2],
          }),
        ])
      );
    });

    it('truncates long input summaries to 500 chars', async () => {
      const longInput = 'x'.repeat(1000);
      const usage = await usageTracker.track({
        projectName: 'test',
        toolName: 'search',
        inputSummary: longInput,
        startTime: Date.now(),
        success: true,
      });

      expect(usage.inputSummary).toHaveLength(500);
    });

    it('defaults sessionId to unknown', async () => {
      const usage = await usageTracker.track({
        projectName: 'test',
        toolName: 'search',
        inputSummary: 'query',
        startTime: Date.now(),
        success: true,
      });

      expect(usage.sessionId).toBe('unknown');
    });

    it('returns usage even when upsert fails', async () => {
      mockedVS.upsert.mockRejectedValue(new Error('qdrant down'));

      const usage = await usageTracker.track({
        projectName: 'test',
        toolName: 'search',
        inputSummary: 'query',
        startTime: Date.now(),
        success: true,
      });

      expect(usage.toolName).toBe('search');
    });
  });

  describe('getStats()', () => {
    it('aggregates stats from scroll results', async () => {
      const usages = [
        {
          toolName: 'search',
          timestamp: '2025-06-15T10:00:00Z',
          durationMs: 100,
          success: true,
          timestampMs: Date.now(),
        },
        {
          toolName: 'search',
          timestamp: '2025-06-15T11:00:00Z',
          durationMs: 200,
          success: true,
          timestampMs: Date.now(),
        },
        {
          toolName: 'recall',
          timestamp: '2025-06-15T10:00:00Z',
          durationMs: 50,
          success: false,
          timestampMs: Date.now(),
        },
      ];

      mockQdrantClient.scroll.mockResolvedValue({
        points: usages.map((u, i) => ({ id: `id-${i}`, payload: u })),
        next_page_offset: undefined,
      });

      const stats = await usageTracker.getStats('test');

      expect(stats.totalCalls).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3, 2);
      expect(stats.avgDurationMs).toBeCloseTo((100 + 200 + 50) / 3, 0);
      expect(stats.topTools[0]).toEqual({ tool: 'search', count: 2 });
      expect(stats.errorsByTool.recall).toBe(1);
    });

    it('paginates through scroll results', async () => {
      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [
            {
              id: '1',
              payload: {
                toolName: 'a',
                timestamp: '2025-01-01T00:00:00Z',
                durationMs: 10,
                success: true,
              },
            },
          ],
          next_page_offset: 'next',
        })
        .mockResolvedValueOnce({
          points: [
            {
              id: '2',
              payload: {
                toolName: 'b',
                timestamp: '2025-01-01T01:00:00Z',
                durationMs: 20,
                success: true,
              },
            },
          ],
          next_page_offset: undefined,
        });

      const stats = await usageTracker.getStats('test');
      expect(stats.totalCalls).toBe(2);
      expect(mockQdrantClient.scroll).toHaveBeenCalledTimes(2);
    });

    it('returns empty stats on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const stats = await usageTracker.getStats('test');
      expect(stats.totalCalls).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it('throws non-404 errors', async () => {
      const err = new Error('Server error') as any;
      err.status = 500;
      mockQdrantClient.scroll.mockRejectedValue(err);

      await expect(usageTracker.getStats('test')).rejects.toThrow('Server error');
    });
  });

  describe('findSimilarQueries()', () => {
    it('embeds query and returns similar usages', async () => {
      mockedVS.search.mockResolvedValue([
        { id: 'u1', score: 0.9, payload: { toolName: 'search', inputSummary: 'auth' } },
      ]);

      const results = await usageTracker.findSimilarQueries('test', 'authentication', 5);

      expect(results).toHaveLength(1);
      expect(results[0].usage.toolName).toBe('search');
      expect(results[0].score).toBe(0.9);
      expect(mockedEmbed.embed).toHaveBeenCalledWith('authentication');
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockedVS.search.mockRejectedValue(err);

      const results = await usageTracker.findSimilarQueries('test', 'query');
      expect(results).toEqual([]);
    });
  });

  describe('getBehaviorPatterns()', () => {
    it('computes peak hours and tool preferences', async () => {
      const usages = [
        { toolName: 'search', timestamp: '2025-06-15T10:00:00Z', durationMs: 100, sessionId: 's1' },
        { toolName: 'search', timestamp: '2025-06-15T10:30:00Z', durationMs: 200, sessionId: 's1' },
        { toolName: 'recall', timestamp: '2025-06-15T14:00:00Z', durationMs: 50, sessionId: 's2' },
      ];

      mockQdrantClient.scroll.mockResolvedValue({
        points: usages.map((u, i) => ({ id: `id-${i}`, payload: u })),
        next_page_offset: undefined,
      });

      const patterns = await usageTracker.getBehaviorPatterns('test');

      expect(patterns.peakHours.length).toBeGreaterThan(0);
      expect(patterns.toolPreferences[0].tool).toBe('search');
      expect(patterns.sessionStats.totalSessions).toBe(2);
    });

    it('detects n-gram workflows', async () => {
      // Two sessions with same tool sequence → workflow detected
      const makeSession = (sid: string) => [
        {
          toolName: 'search',
          timestamp: `2025-06-15T10:00:0${sid === 's1' ? '0' : '5'}Z`,
          durationMs: 10,
          sessionId: sid,
        },
        {
          toolName: 'recall',
          timestamp: `2025-06-15T10:01:0${sid === 's1' ? '0' : '5'}Z`,
          durationMs: 10,
          sessionId: sid,
        },
      ];

      mockQdrantClient.scroll.mockResolvedValue({
        points: [...makeSession('s1'), ...makeSession('s2')].map((u, i) => ({
          id: `id-${i}`,
          payload: u,
        })),
        next_page_offset: undefined,
      });

      const patterns = await usageTracker.getBehaviorPatterns('test');
      expect(patterns.workflows.length).toBeGreaterThan(0);
      expect(patterns.workflows[0].sequence).toEqual(['search', 'recall']);
      expect(patterns.workflows[0].count).toBeGreaterThanOrEqual(2);
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const patterns = await usageTracker.getBehaviorPatterns('test');
      expect(patterns.peakHours).toEqual([]);
      expect(patterns.sessionStats.totalSessions).toBe(0);
    });
  });

  describe('getKnowledgeGaps()', () => {
    it('aggregates low-result queries', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: '1',
            payload: {
              inputSummary: 'missing feature',
              toolName: 'search',
              resultCount: 0,
              success: true,
            },
          },
          {
            id: '2',
            payload: {
              inputSummary: 'missing feature',
              toolName: 'search',
              resultCount: 1,
              success: true,
            },
          },
          {
            id: '3',
            payload: {
              inputSummary: 'another gap',
              toolName: 'search',
              resultCount: 0,
              success: true,
            },
          },
          {
            id: '4',
            payload: {
              inputSummary: 'another gap',
              toolName: 'search',
              resultCount: 0,
              success: true,
            },
          },
        ],
        next_page_offset: undefined,
      });

      const gaps = await usageTracker.getKnowledgeGaps('test');

      expect(gaps).toHaveLength(2);
      expect(gaps[0].count).toBeGreaterThanOrEqual(2);
    });

    it('filters out queries with fewer than 2 occurrences', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: '1',
            payload: {
              inputSummary: 'unique query',
              toolName: 'search',
              resultCount: 0,
              success: true,
            },
          },
        ],
        next_page_offset: undefined,
      });

      const gaps = await usageTracker.getKnowledgeGaps('test');
      expect(gaps).toHaveLength(0);
    });

    it('returns empty on 404', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const gaps = await usageTracker.getKnowledgeGaps('test');
      expect(gaps).toEqual([]);
    });
  });
});
