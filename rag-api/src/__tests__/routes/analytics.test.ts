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
  },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    listCollections: mocks.listCollections,
    getCollectionInfo: mocks.getCollectionInfo,
  },
}));

vi.mock('../../utils/metrics', () => ({
  enrichmentTotal: { inc: vi.fn() },
  enrichmentDuration: { observe: vi.fn() },
  enrichmentRecallCount: { observe: vi.fn() },
  registry: { getSingleMetricAsString: vi.fn().mockResolvedValue('') },
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
});
