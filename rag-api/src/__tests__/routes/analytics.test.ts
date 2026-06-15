import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  extractEntities: vi.fn(),
  track: vi.fn(),
  getStats: vi.fn(),
  getKnowledgeGaps: vi.fn(),
  findSimilarQueries: vi.fn(),
  getBehaviorPatterns: vi.fn(),
  listCollections: vi.fn(),
  getCollectionInfo: vi.fn(),
  summarize: vi.fn(),
  getToolCallCounts: vi.fn(),
  getDigestStats: vi.fn(),
  scrollCollection: vi.fn(),
  getSourceCounters: vi.fn(),
}));

vi.mock('../../services/conversation-analyzer', () => ({
  conversationAnalyzer: {
    analyze: mocks.analyze,
    extractEntities: mocks.extractEntities,
  },
}));

vi.mock('../../services/usage-tracker', () => ({
  usageTracker: {
    track: mocks.track,
    getStats: mocks.getStats,
    getKnowledgeGaps: mocks.getKnowledgeGaps,
    findSimilarQueries: mocks.findSimilarQueries,
    getBehaviorPatterns: mocks.getBehaviorPatterns,
    getToolCallCounts: mocks.getToolCallCounts,
  },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    listCollections: mocks.listCollections,
    getCollectionInfo: mocks.getCollectionInfo,
    scrollCollection: mocks.scrollCollection,
  },
}));

vi.mock('../../services/retrieval-log', () => ({
  retrievalLog: { getDigestStats: mocks.getDigestStats },
}));

vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: { getSourceCounters: mocks.getSourceCounters },
}));

vi.mock('../../utils/metrics', () => ({
  enrichmentTotal: { inc: vi.fn() },
  enrichmentDuration: { observe: vi.fn() },
  enrichmentRecallCount: { observe: vi.fn() },
  registry: { getSingleMetricAsString: vi.fn().mockResolvedValue('') },
}));

vi.mock('../../services/llm-usage-logger', () => ({
  llmUsageLogger: { summarize: mocks.summarize },
}));

import analyticsRoutes from '../../routes/analytics';

const app = createTestApp({ router: analyticsRoutes });

describe('Analytics Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/analyze-conversation', () => {
    it('returns analysis results', async () => {
      mocks.analyze.mockResolvedValue({
        learnings: [{ content: 'learned' }],
        entities: { files: [] },
        summary: 'summary',
      });

      const res = await withProject(
        request(app).post('/api/analyze-conversation').send({
          projectName: 'test',
          conversation: 'user: hello\nassistant: hi',
        })
      );

      expect(res.status).toBe(200);
      expect(res.body.learnings).toHaveLength(1);
      expect(res.body.summary).toBe('summary');
    });

    it('returns 400 without projectName', async () => {
      const res = await request(app)
        .post('/api/analyze-conversation')
        .send({ conversation: 'hello' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/extract-entities', () => {
    it('returns entities from text', async () => {
      mocks.extractEntities.mockResolvedValue({ files: ['src/a.ts'], functions: [] });

      const res = await request(app)
        .post('/api/extract-entities')
        .send({ text: 'modified src/a.ts' });

      expect(res.status).toBe(200);
      expect(res.body.files).toContain('src/a.ts');
    });

    it('returns 400 without text', async () => {
      const res = await request(app).post('/api/extract-entities').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/track-usage', () => {
    it('tracks tool usage', async () => {
      mocks.track.mockResolvedValue({ id: 'usage-1' });

      const res = await withProject(
        request(app).post('/api/track-usage').send({
          projectName: 'test',
          toolName: 'search_codebase',
          success: true,
        })
      );

      expect(res.status).toBe(200);
      expect(res.body.tracked).toBe(true);
    });

    it('forwards metadata.command from the memory tool to the tracker', async () => {
      // The upgraded mcp emitter sends metadata.command on memory-tool rows;
      // the route must thread it through so getToolCallCounts can attribute
      // the channel precisely instead of re-parsing inputSummary.
      mocks.track.mockResolvedValue({ id: 'usage-2' });

      const res = await withProject(
        request(app)
          .post('/api/track-usage')
          .send({
            projectName: 'test',
            toolName: 'memory',
            inputSummary: 'create /memories/a.md',
            success: true,
            metadata: { command: 'create' },
          })
      );

      expect(res.status).toBe(200);
      expect(mocks.track).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'memory',
          metadata: { command: 'create' },
        })
      );
    });
  });

  describe('GET /api/tool-analytics', () => {
    it('returns usage stats', async () => {
      mocks.getStats.mockResolvedValue({
        totalCalls: 10,
        successRate: 0.9,
        topTools: [],
      });

      const res = await withProject(request(app).get('/api/tool-analytics'));

      expect(res.status).toBe(200);
      expect(res.body.totalCalls).toBe(10);
    });
  });

  describe('GET /api/knowledge-gaps', () => {
    it('returns gaps', async () => {
      mocks.getKnowledgeGaps.mockResolvedValue([
        { query: 'missing', toolName: 'search', count: 3, avgResultCount: 0.5 },
      ]);

      const res = await withProject(request(app).get('/api/knowledge-gaps'));

      expect(res.status).toBe(200);
      expect(res.body.gaps).toHaveLength(1);
    });
  });

  describe('POST /api/similar-queries', () => {
    it('returns similar queries', async () => {
      mocks.findSimilarQueries.mockResolvedValue([
        {
          usage: { toolName: 'search', inputSummary: 'auth', resultCount: 5, success: true },
          score: 0.9,
        },
      ]);

      const res = await withProject(
        request(app).post('/api/similar-queries').send({
          projectName: 'test',
          query: 'authentication',
        })
      );

      expect(res.status).toBe(200);
      expect(res.body.similar).toHaveLength(1);
    });

    it('returns 400 without query', async () => {
      const res = await withProject(
        request(app).post('/api/similar-queries').send({
          projectName: 'test',
        })
      );

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/behavior-patterns', () => {
    it('returns behavior patterns', async () => {
      mocks.getBehaviorPatterns.mockResolvedValue({
        peakHours: [{ hour: 10, count: 5 }],
        toolPreferences: [],
        workflows: [],
        sessionStats: { totalSessions: 1 },
      });

      const res = await withProject(request(app).get('/api/behavior-patterns'));

      expect(res.status).toBe(200);
      expect(res.body.peakHours).toHaveLength(1);
    });
  });

  describe('POST /api/track-enrichment', () => {
    it('tracks enrichment event', async () => {
      const res = await request(app).post('/api/track-enrichment').send({
        projectName: 'test',
        tool: 'recall',
        result: 'hit',
        durationMs: 50,
        recallCount: 3,
      });

      expect(res.status).toBe(200);
      expect(res.body.tracked).toBe(true);
    });
  });

  describe('GET /api/platform/stats', () => {
    it('returns platform stats', async () => {
      mocks.listCollections.mockResolvedValue(['proj_codebase', 'proj_memory']);
      mocks.getCollectionInfo.mockResolvedValue({ vectorsCount: 100 });

      const res = await request(app).get('/api/platform/stats');

      expect(res.status).toBe(200);
      expect(res.body.totalProjects).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/analytics/llm-usage', () => {
    const summary = {
      project: 'test',
      failures: 0,
      totals: {
        requests: 2,
        promptTokens: 100,
        completionTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUsd: 0.001,
      },
      byModel: { 'claude-opus-4-8': { requests: 2 } },
    };

    it('returns usage summary for the project', async () => {
      mocks.summarize.mockResolvedValue(summary);

      const res = await withProject(request(app).get('/api/analytics/llm-usage'));

      expect(res.status).toBe(200);
      expect(res.body.totals.requests).toBe(2);
      expect(res.body.byModel['claude-opus-4-8']).toBeDefined();
      expect(mocks.summarize).toHaveBeenCalledWith('test', { from: undefined, to: undefined });
    });

    it('passes the from/to date range through', async () => {
      mocks.summarize.mockResolvedValue(summary);

      const res = await withProject(
        request(app).get(
          '/api/analytics/llm-usage?from=2026-06-01T00:00:00Z&to=2026-06-10T00:00:00Z'
        )
      );

      expect(res.status).toBe(200);
      expect(mocks.summarize).toHaveBeenCalledWith('test', {
        from: '2026-06-01T00:00:00Z',
        to: '2026-06-10T00:00:00Z',
      });
    });

    it('returns 400 without projectName', async () => {
      const res = await request(app).get('/api/analytics/llm-usage');

      expect(res.status).toBe(400);
      expect(mocks.summarize).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed date', async () => {
      const res = await withProject(request(app).get('/api/analytics/llm-usage?from=not-a-date'));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
      expect(mocks.summarize).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/analytics/memory-roi', () => {
    const recentIso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    beforeEach(() => {
      // Capture-funnel counters default to zeros — individual tests override.
      mocks.getSourceCounters.mockResolvedValue({
        auto_memory_tool: { ingested: 0, promoted: 0, rejected: 0 },
        auto_transcript: { ingested: 0, promoted: 0, rejected: 0 },
      });
    });

    /** Seeded fixture: tool counts per the PINNED channel mapping. */
    const seededCounts = {
      // remember-side, channel manual
      remember: 3,
      batch_remember: 1,
      record_adr: 2,
      record_pattern: 1,
      // remember-side, channel memory_tool (adapter writes)
      'memory:create': 4,
      'memory:insert': 1,
      'memory:str_replace': 2,
      // recall-side, channel manual
      recall: 5,
      get_adrs: 1,
      get_patterns: 1,
      // recall-side, channel memory_tool
      'memory:view': 3,
      // not counted on either side
      'memory:delete': 9,
      hybrid_search: 42,
      start_session: 4,
    };

    function seedSessionsAndEpisodic() {
      mocks.scrollCollection.mockImplementation(async (collection: string) => {
        if (collection.endsWith('_sessions')) {
          return {
            points: [
              {
                id: 's1',
                payload: {
                  sessionId: 's1',
                  status: 'ended',
                  startedAt: recentIso(2),
                  metadata: {},
                },
              },
              {
                id: 's2',
                payload: {
                  sessionId: 's2',
                  status: 'ended',
                  startedAt: recentIso(3),
                  metadata: { endReason: 'stale_cleanup' },
                },
              },
              {
                id: 's3',
                payload: { sessionId: 's3', status: 'active', startedAt: recentIso(1) },
              },
              {
                id: 's-old',
                payload: { sessionId: 's-old', status: 'ended', startedAt: recentIso(99) },
              },
            ],
          };
        }
        if (collection.endsWith('_memory_episodic')) {
          return {
            points: [
              { id: 'e1', payload: { sessionId: 's1' } },
              { id: 'e2', payload: { sessionId: 's1' } }, // same session, counted once
              { id: 'e3', payload: { sessionId: 's-old' } }, // outside window
            ],
          };
        }
        return { points: [] };
      });
    }

    it('returns per-channel counts with memory-tool writes in the strict-ratio denominator', async () => {
      mocks.getToolCallCounts.mockResolvedValue(seededCounts);
      mocks.getDigestStats.mockResolvedValue({
        deliveries: 4,
        nonEmptyDeliveries: 3,
        sessionsWithDigest: 3,
      });
      seedSessionsAndEpisodic();

      const res = await withProject(request(app).get('/api/analytics/memory-roi?days=30'));

      expect(res.status).toBe(200);
      expect(mocks.getToolCallCounts).toHaveBeenCalledWith('test', 30);

      // Per-channel remember counts (manual 7 + memory_tool 7 = 14)
      expect(res.body.remembers.byChannel.manual).toEqual({
        remember: 3,
        batch_remember: 1,
        record_adr: 2,
        record_pattern: 1,
        total: 7,
      });
      expect(res.body.remembers.byChannel.memory_tool).toEqual({
        create: 4,
        insert: 1,
        str_replace: 2,
        total: 7,
      });
      expect(res.body.remembers.total).toBe(14);

      // Per-channel recall counts (manual 7 + memory_tool 3 = 10)
      expect(res.body.recalls.byChannel.manual).toEqual({
        recall: 5,
        get_adrs: 1,
        get_patterns: 1,
        total: 7,
      });
      expect(res.body.recalls.byChannel.memory_tool).toEqual({ view: 3, total: 3 });
      expect(res.body.recalls.total).toBe(10);

      // Strict ratio includes adapter-channel writes in the denominator:
      // 10 recalls / 14 remembers — NOT 10/7.
      expect(res.body.ratios.strict).toBeCloseTo(10 / 14, 3);
      // Assisted ratio adds non-empty digest deliveries: (10 + 3) / 14
      expect(res.body.ratios.assisted).toBeCloseTo(13 / 14, 3);

      // Digest coverage from the audit log over started sessions (3 in window)
      expect(res.body.digest).toMatchObject({
        deliveries: 4,
        nonEmptyDeliveries: 3,
        sessionsWithDigest: 3,
      });
      expect(res.body.digest.coverage).toBeCloseTo(1, 3);

      // Hook reliability: 3 started in window; 2 ended; stale_cleanup not an
      // explicit end → trigger rate 1/3. Consolidation evidence: s1 only, /2 ended.
      expect(res.body.sessions).toMatchObject({
        started: 3,
        ended: 2,
        endedExplicit: 1,
        staleAutoEnded: 1,
      });
      expect(res.body.sessions.endSessionTriggerRate).toBeCloseTo(1 / 3, 3);
      expect(res.body.sessions.consolidatedWithLtmEvidence).toBe(1);
      expect(res.body.sessions.consolidationCompletionRate).toBeCloseTo(0.5, 3);
    });

    it('reports null ratios when there are no remembers (no division by zero)', async () => {
      mocks.getToolCallCounts.mockResolvedValue({ hybrid_search: 5 });
      mocks.getDigestStats.mockResolvedValue({
        deliveries: 0,
        nonEmptyDeliveries: 0,
        sessionsWithDigest: 0,
      });
      mocks.scrollCollection.mockResolvedValue({ points: [] });

      const res = await withProject(request(app).get('/api/analytics/memory-roi'));

      expect(res.status).toBe(200);
      expect(res.body.remembers.total).toBe(0);
      expect(res.body.ratios.strict).toBeNull();
      expect(res.body.ratios.assisted).toBeNull();
      expect(res.body.sessions.endSessionTriggerRate).toBeNull();
    });

    it('returns 400 without projectName', async () => {
      const res = await request(app).get('/api/analytics/memory-roi');
      expect(res.status).toBe(400);
    });

    describe('capture section (M5 per-source funnel)', () => {
      it('reports per-source cumulative counters + windowed quarantine backlog', async () => {
        mocks.getToolCallCounts.mockResolvedValue({});
        mocks.getDigestStats.mockResolvedValue({
          deliveries: 0,
          nonEmptyDeliveries: 0,
          sessionsWithDigest: 0,
        });
        mocks.getSourceCounters.mockResolvedValue({
          auto_memory_tool: { ingested: 5, promoted: 4, rejected: 0 },
          auto_transcript: { ingested: 10, promoted: 3, rejected: 1 },
        });
        mocks.scrollCollection.mockImplementation(async (collection: string) => {
          if (collection.endsWith('_memory_pending')) {
            return {
              points: [
                // in-window transcript entries
                {
                  id: 'p1',
                  payload: { source: 'auto_transcript', createdAt: recentIso(2) },
                },
                {
                  id: 'p2',
                  payload: { source: 'auto_transcript', createdAt: recentIso(5) },
                },
                // out-of-window transcript entry
                {
                  id: 'p3',
                  payload: { source: 'auto_transcript', createdAt: recentIso(99) },
                },
                // in-window memory-tool entry
                {
                  id: 'p4',
                  payload: { source: 'auto_memory_tool', createdAt: recentIso(1) },
                },
                // other sources / missing fields don't count
                { id: 'p5', payload: { source: 'auto_conversation', createdAt: recentIso(1) } },
                { id: 'p6', payload: { createdAt: recentIso(1) } },
              ],
            };
          }
          return { points: [] };
        });

        const res = await withProject(request(app).get('/api/analytics/memory-roi?days=30'));

        expect(res.status).toBe(200);
        expect(mocks.getSourceCounters).toHaveBeenCalledWith('test', [
          'auto_memory_tool',
          'auto_transcript',
        ]);
        expect(res.body.capture.bySource.auto_transcript).toEqual({
          ingested: 10,
          promoted: 3,
          rejected: 1,
          promotionRate: 0.75, // 3 / (3 + 1)
          pendingInWindow: 2,
        });
        expect(res.body.capture.bySource.auto_memory_tool).toEqual({
          ingested: 5,
          promoted: 4,
          rejected: 0,
          promotionRate: 1,
          pendingInWindow: 1,
        });
        // The pre-existing response shapes stay intact (dashboard + tests rely on them).
        expect(res.body.remembers.byChannel).toHaveProperty('manual');
        expect(res.body.recalls.byChannel).toHaveProperty('memory_tool');
        expect(res.body.ratios).toHaveProperty('strict');
        expect(res.body.sessions).toHaveProperty('endSessionTriggerRate');
      });

      it('reports a null promotionRate when a source has zero reviews', async () => {
        mocks.getToolCallCounts.mockResolvedValue({});
        mocks.getDigestStats.mockResolvedValue({
          deliveries: 0,
          nonEmptyDeliveries: 0,
          sessionsWithDigest: 0,
        });
        mocks.getSourceCounters.mockResolvedValue({
          auto_memory_tool: { ingested: 0, promoted: 0, rejected: 0 },
          auto_transcript: { ingested: 4, promoted: 0, rejected: 0 },
        });
        mocks.scrollCollection.mockResolvedValue({ points: [] });

        const res = await withProject(request(app).get('/api/analytics/memory-roi'));

        expect(res.status).toBe(200);
        expect(res.body.capture.bySource.auto_transcript.promotionRate).toBeNull();
        expect(res.body.capture.bySource.auto_transcript.ingested).toBe(4);
        expect(res.body.capture.bySource.auto_transcript.pendingInWindow).toBe(0);
      });
    });
  });
});
