import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  search: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mocks.embed },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: { search: mocks.search },
}));

vi.mock('../../services/llm', () => ({
  llm: { complete: mocks.complete },
}));

import testingRoutes from '../../routes/testing';

const app = createTestApp({ router: testingRoutes });

describe('Testing Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embed.mockResolvedValue([0.1, 0.2]);
    mocks.search.mockResolvedValue([]);
    mocks.complete.mockResolvedValue({
      text: '```typescript\ndescribe("test", () => { it("works", () => { expect(true).toBe(true); }); });\n```',
      usage: {},
    });
  });

  describe('POST /api/generate-tests', () => {
    it('generates tests from code', async () => {
      const res = await withProject(
        request(app).post('/api/generate-tests').send({
          projectName: 'test',
          code: 'function add(a: number, b: number) { return a + b; }',
          framework: 'vitest',
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.tests).toBeTruthy();
      expect(res.body.framework).toBe('vitest');
      expect(res.body.analysis).toBeDefined();
      expect(res.body.analysis.estimatedComplexity).toBe('low');
    });

    it('includes existing test patterns in context', async () => {
      mocks.search.mockResolvedValue([
        { id: 't1', score: 0.9, payload: { content: 'describe("existing", () => {})' } },
      ]);

      const res = await withProject(
        request(app).post('/api/generate-tests').send({
          projectName: 'test',
          code: 'const x = 1;',
          framework: 'vitest',
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.existingPatternsFound).toBe(1);
    });

    it('returns 400 without projectName', async () => {
      const res = await request(app)
        .post('/api/generate-tests')
        .send({ code: 'const x = 1;', framework: 'vitest' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/generate-test-cases', () => {
    it('generates test cases from code', async () => {
      mocks.complete.mockResolvedValue({
        text: JSON.stringify({ testCases: [{ id: 'TC001', name: 'test' }] }),
        usage: {},
      });

      const res = await request(app)
        .post('/api/generate-test-cases')
        .send({ code: 'function add(a, b) { return a + b; }' });

      expect(res.status).toBe(200);
      expect(res.body.testCases).toHaveLength(1);
    });

    it('generates test cases from requirements', async () => {
      mocks.complete.mockResolvedValue({
        text: JSON.stringify({ testCases: [{ id: 'TC001' }] }),
        usage: {},
      });

      const res = await request(app)
        .post('/api/generate-test-cases')
        .send({ requirements: 'User should be able to login' });

      expect(res.status).toBe(200);
      expect(res.body.testCases).toBeDefined();
    });

    it('returns 400 without code or requirements', async () => {
      const res = await request(app)
        .post('/api/generate-test-cases')
        .send({});

      expect(res.status).toBe(400);
    });

    it('handles non-JSON LLM response gracefully', async () => {
      mocks.complete.mockResolvedValue({ text: 'This is not JSON', usage: {} });

      const res = await request(app)
        .post('/api/generate-test-cases')
        .send({ code: 'const x = 1;' });

      expect(res.status).toBe(200);
      expect(res.body.summary).toBe('This is not JSON');
    });
  });

  describe('POST /api/analyze-tests', () => {
    it('analyzes test code', async () => {
      mocks.complete.mockResolvedValue({
        text: JSON.stringify({ quality: 'good', score: 8, suggestions: [] }),
        usage: {},
      });

      const res = await request(app)
        .post('/api/analyze-tests')
        .send({ testCode: 'describe("test", () => {})' });

      expect(res.status).toBe(200);
      expect(res.body.analysis.quality).toBe('good');
    });

    it('returns 400 without testCode', async () => {
      const res = await request(app)
        .post('/api/analyze-tests')
        .send({});

      expect(res.status).toBe(400);
    });

    it('handles JSON parse failure', async () => {
      mocks.complete.mockResolvedValue({ text: 'invalid json', usage: {} });

      const res = await request(app)
        .post('/api/analyze-tests')
        .send({ testCode: 'it("works", () => {})' });

      expect(res.status).toBe(200);
      expect(res.body.analysis.quality).toBe('unknown');
      expect(res.body.analysis.summary).toBe('invalid json');
    });
  });
});
