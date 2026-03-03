import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  search: vi.fn(),
  complete: vi.fn(),
  recall: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({ vectorStore: { search: mocks.search } }));
vi.mock('../../services/embedding', () => ({ embeddingService: { embed: mocks.embed } }));
vi.mock('../../services/llm', () => ({ llm: { complete: mocks.complete } }));
vi.mock('../../services/memory', () => ({ memoryService: { recall: mocks.recall } }));

import reviewRoutes from '../../routes/review';

const app = createTestApp({ router: reviewRoutes });

function setDefaults() {
  mocks.embed.mockResolvedValue(Array(1024).fill(0));
  mocks.search.mockResolvedValue([]);
  mocks.recall.mockResolvedValue([]);
  mocks.complete.mockResolvedValue({
    text: '{"summary":"good","issues":[],"suggestions":[],"score":8}',
  });
}

describe('Review Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setDefaults();
  });

  describe('POST /api/review', () => {
    it('reviews code', async () => {
      const res = await withProject(request(app).post('/api/review'))
        .send({ code: 'function foo() { return 1; }' });

      expect(res.status).toBe(200);
      expect(res.body.review).toBeDefined();
      expect(res.body.review.summary).toBe('good');
    });

    it('reviews a diff', async () => {
      const res = await withProject(request(app).post('/api/review'))
        .send({ diff: '+ added line\n- removed line' });

      expect(res.status).toBe(200);
      expect(res.body.review).toBeDefined();
    });

    it('returns 400 when both code and diff are missing', async () => {
      const res = await withProject(request(app).post('/api/review'))
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when projectName is missing', async () => {
      const res = await request(app).post('/api/review')
        .send({ code: 'function foo() {}' });
      expect(res.status).toBe(400);
    });

    it('includes patterns and ADR context', async () => {
      mocks.recall.mockResolvedValue([
        { memory: { type: 'context', content: 'Use camelCase naming' }, score: 0.8 },
      ]);

      const res = await withProject(request(app).post('/api/review'))
        .send({ code: 'function foo() {}' });

      expect(res.status).toBe(200);
      // recall is called twice: once for patterns, once for ADRs
      expect(mocks.recall).toHaveBeenCalledTimes(2);
    });

    it('handles non-JSON LLM response gracefully', async () => {
      mocks.complete.mockResolvedValue({ text: 'Just a text review, not JSON' });

      const res = await withProject(request(app).post('/api/review'))
        .send({ code: 'function foo() {}' });

      expect(res.status).toBe(200);
      expect(res.body.review.summary).toBe('Just a text review, not JSON');
    });
  });

  describe('POST /api/review/security', () => {
    it('analyzes security', async () => {
      mocks.complete.mockResolvedValue({
        text: '{"riskLevel":"low","vulnerabilities":[],"summary":"safe"}',
      });

      const res = await request(app).post('/api/review/security')
        .send({ code: 'const x = sanitize(input);' });

      expect(res.status).toBe(200);
      expect(res.body.analysis.riskLevel).toBe('low');
    });

    it('returns 400 when code is missing', async () => {
      const res = await request(app).post('/api/review/security')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/review/complexity', () => {
    it('analyzes complexity', async () => {
      mocks.complete.mockResolvedValue({
        text: '{"complexity":"medium","metrics":{},"suggestions":[],"summary":"ok"}',
      });

      const res = await request(app).post('/api/review/complexity')
        .send({ code: 'function complex() { if (a) { if (b) { } } }' });

      expect(res.status).toBe(200);
      expect(res.body.analysis.complexity).toBe('medium');
    });
  });
});
