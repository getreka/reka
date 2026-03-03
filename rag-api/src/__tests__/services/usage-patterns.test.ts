import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    client: mockQdrantClient,
  },
}));

import { usagePatterns } from '../../services/usage-patterns';

describe('UsagePatternService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('stub methods', () => {
    it('analyzePatterns returns empty data', async () => {
      const result = await usagePatterns.analyzePatterns('test');
      expect(result).toEqual({ patterns: [], workflows: [], insights: [], recommendations: [] });
    });

    it('summarizeContext returns empty data', async () => {
      const result = await usagePatterns.summarizeContext('test');
      expect(result).toEqual({ recentTools: [], recentQueries: [], activeFeatures: [], suggestedNextSteps: [] });
    });

    it('summarizeChanges returns disabled message', async () => {
      const result = await usagePatterns.summarizeChanges('test', 'session-1');
      expect(result.summary).toBe('Summarization disabled');
    });
  });

  describe('buildDeveloperProfile()', () => {
    it('returns empty profile when no usage data', async () => {
      mockQdrantClient.scroll.mockResolvedValue({ points: [], next_page_offset: undefined });

      const profile = await usagePatterns.buildDeveloperProfile('test');

      expect(profile.projectName).toBe('test');
      expect(profile.frequentFiles).toEqual([]);
      expect(profile.preferredTools).toEqual([]);
      expect(profile.peakHours).toEqual([]);
      expect(profile.totalToolCalls).toBe(0);
      expect(profile.totalSessions).toBe(0);
    });

    it('aggregates usage data into profile', async () => {
      const usages = [
        {
          toolName: 'search_codebase',
          timestamp: '2025-06-15T10:00:00Z',
          durationMs: 100,
          sessionId: 's1',
          inputSummary: 'find auth',
          metadata: { file: 'src/auth.ts' },
        },
        {
          toolName: 'search_codebase',
          timestamp: '2025-06-15T10:05:00Z',
          durationMs: 200,
          sessionId: 's1',
          inputSummary: 'find auth',
          metadata: { file: 'src/auth.ts' },
        },
        {
          toolName: 'recall',
          timestamp: '2025-06-15T14:00:00Z',
          durationMs: 50,
          sessionId: 's2',
          inputSummary: 'patterns',
          metadata: { file: 'src/other.ts' },
        },
      ];

      mockQdrantClient.scroll.mockResolvedValue({
        points: usages.map((u, i) => ({ id: `id-${i}`, payload: u })),
        next_page_offset: undefined,
      });

      const profile = await usagePatterns.buildDeveloperProfile('test');

      expect(profile.totalToolCalls).toBe(3);
      expect(profile.totalSessions).toBe(2);
      expect(profile.preferredTools[0].tool).toBe('search_codebase');
      expect(profile.preferredTools[0].count).toBe(2);
      expect(profile.frequentFiles[0].file).toBe('src/auth.ts');
      expect(profile.frequentFiles[0].count).toBe(2);
      expect(profile.lastActive).toBe('2025-06-15T14:00:00Z');
    });

    it('paginates through scroll results', async () => {
      mockQdrantClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: '1', payload: { toolName: 'a', timestamp: '2025-01-01T00:00:00Z', durationMs: 10, sessionId: 's1' } }],
          next_page_offset: 'next',
        })
        .mockResolvedValueOnce({
          points: [{ id: '2', payload: { toolName: 'b', timestamp: '2025-01-01T01:00:00Z', durationMs: 20, sessionId: 's1' } }],
          next_page_offset: undefined,
        });

      const profile = await usagePatterns.buildDeveloperProfile('test');
      expect(profile.totalToolCalls).toBe(2);
      expect(mockQdrantClient.scroll).toHaveBeenCalledTimes(2);
    });

    it('returns empty profile on 404 error', async () => {
      const err = new Error('Not found') as any;
      err.status = 404;
      mockQdrantClient.scroll.mockRejectedValue(err);

      const profile = await usagePatterns.buildDeveloperProfile('test');
      expect(profile.totalToolCalls).toBe(0);
    });

    it('extracts common patterns from repeated queries', async () => {
      const usages = Array.from({ length: 4 }, (_, i) => ({
        toolName: 'search',
        timestamp: '2025-06-15T10:00:00Z',
        durationMs: 10,
        sessionId: 's1',
        inputSummary: 'find authentication flow',
      }));

      mockQdrantClient.scroll.mockResolvedValue({
        points: usages.map((u, i) => ({ id: `id-${i}`, payload: u })),
        next_page_offset: undefined,
      });

      const profile = await usagePatterns.buildDeveloperProfile('test');
      // 4 occurrences of same query prefix >= 3 threshold
      expect(profile.commonPatterns.length).toBeGreaterThan(0);
    });
  });
});
