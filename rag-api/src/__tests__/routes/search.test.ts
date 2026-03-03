import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embedFull: vi.fn(),
  search: vi.fn(),
  searchHybridNative: vi.fn(),
  searchGroups: vi.fn(),
  expand: vi.fn(),
  findSymbol: vi.fn(),
  getFileExports: vi.fn(),
  complete: vi.fn(),
  build: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mocks.embed, embedFull: mocks.embedFull },
}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    search: mocks.search,
    searchHybridNative: mocks.searchHybridNative,
    searchGroups: mocks.searchGroups,
  },
  SearchResult: {},
}));
vi.mock('../../services/llm', () => ({ llm: { complete: mocks.complete } }));
vi.mock('../../services/graph-store', () => ({ graphStore: { expand: mocks.expand } }));
vi.mock('../../services/symbol-index', () => ({
  symbolIndex: { findSymbol: mocks.findSymbol, getFileExports: mocks.getFileExports },
}));
vi.mock('../../services/context-pack', () => ({ contextPackBuilder: { build: mocks.build } }));
vi.mock('../../services/smart-dispatch', () => ({ smartDispatch: { dispatch: mocks.dispatch } }));

import searchRoutes from '../../routes/search';

const app = createTestApp({ router: searchRoutes });

function setDefaults() {
  mocks.embed.mockResolvedValue(Array(1024).fill(0));
  mocks.search.mockResolvedValue([]);
  mocks.expand.mockResolvedValue([]);
  mocks.complete.mockResolvedValue({ text: 'answer', thinking: null });
}

describe('Search Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setDefaults();
  });

  describe('POST /api/search', () => {
    it('returns search results', async () => {
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.9, payload: { file: 'a.ts', content: 'code', language: 'typescript' } },
      ]);

      const res = await request(app).post('/api/search')
        .set('X-Project-Name', 'test')
        .send({ collection: 'test_codebase', query: 'find function' });

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
    });

    it('returns 400 when collection is missing', async () => {
      const res = await request(app).post('/api/search')
        .send({ query: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/search-hybrid', () => {
    it('returns hybrid results', async () => {
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.8, payload: { file: 'b.ts', content: 'c', language: 'ts' } },
      ]);

      const res = await request(app).post('/api/search-hybrid')
        .set('X-Project-Name', 'test')
        .send({ collection: 'test_codebase', query: 'auth middleware' });

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
    });
  });

  describe('POST /api/ask', () => {
    it('returns an answer', async () => {
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.9, payload: { file: 'a.ts', content: 'export class A {}', language: 'typescript' } },
      ]);
      mocks.complete.mockResolvedValue({ text: 'Class A is defined in a.ts' });

      const res = await request(app).post('/api/ask')
        .send({ collection: 'test_codebase', question: 'What is class A?' });

      expect(res.status).toBe(200);
      expect(res.body.answer).toBe('Class A is defined in a.ts');
    });

    it('returns fallback message when no results', async () => {
      mocks.search.mockResolvedValue([]);

      const res = await request(app).post('/api/ask')
        .send({ collection: 'test_codebase', question: 'anything' });

      expect(res.status).toBe(200);
      expect(res.body.answer).toContain('No relevant code found');
    });
  });

  describe('POST /api/find-feature', () => {
    it('finds feature implementation', async () => {
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.85, payload: { file: 'auth.ts', content: 'auth logic', language: 'ts' } },
      ]);
      mocks.complete.mockResolvedValue({ text: 'Authentication is in auth.ts' });

      const res = await request(app).post('/api/find-feature')
        .send({ collection: 'test_codebase', description: 'authentication' });

      expect(res.status).toBe(200);
      expect(res.body.explanation).toBeDefined();
      expect(res.body.mainFiles).toBeDefined();
    });
  });

  describe('POST /api/find-symbol', () => {
    it('finds symbols', async () => {
      mocks.findSymbol.mockResolvedValue([{ name: 'AuthService', file: 'auth.ts', kind: 'class' }]);

      const res = await request(app).post('/api/find-symbol')
        .send({ projectName: 'test', symbol: 'AuthService' });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
    });

    it('returns 400 when projectName or symbol missing', async () => {
      const res = await request(app).post('/api/find-symbol')
        .send({ projectName: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/context-pack', () => {
    it('builds context pack', async () => {
      mocks.build.mockResolvedValue({
        facets: [], totalTokens: 500,
        guardrails: { relatedADRs: [], testCommands: [], invariants: [] },
        assembled: 'context',
      });

      const res = await request(app).post('/api/context-pack')
        .send({ projectName: 'test', query: 'implement auth' });

      expect(res.status).toBe(200);
      expect(res.body.totalTokens).toBe(500);
    });
  });

  describe('POST /api/smart-dispatch', () => {
    it('dispatches a task', async () => {
      mocks.dispatch.mockResolvedValue({
        plan: ['code_search', 'memory'], reasoning: 'test',
        context: {}, timing: { planMs: 10, executeMs: 20, totalMs: 30 },
      });

      const res = await withProject(request(app).post('/api/smart-dispatch'))
        .send({ task: 'fix auth bug' });

      expect(res.status).toBe(200);
      expect(res.body.plan).toContain('code_search');
    });

    it('returns 400 when no projectName', async () => {
      const res = await request(app).post('/api/smart-dispatch')
        .send({ task: 'test' });
      expect(res.status).toBe(400);
    });
  });
});
