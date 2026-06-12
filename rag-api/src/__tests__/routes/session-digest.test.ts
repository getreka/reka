import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  buildDigest: vi.fn(),
  getSession: vi.fn(),
}));

// routes/index.ts pulls in the whole service layer — stub everything it imports.
vi.mock('../../services/indexer', () => ({
  indexProject: vi.fn(),
  indexFiles: vi.fn(),
  getIndexStatus: vi.fn().mockReturnValue({ status: 'idle' }),
  getProjectStats: vi.fn(),
  getCollectionName: vi.fn((p: string) => `${p}_codebase`),
  reindexWithZeroDowntime: vi.fn(),
  getAliasInfo: vi.fn(),
}));
vi.mock('../../services/event-bus', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    scrollCollection: vi.fn().mockResolvedValue({ points: [] }),
    listCollections: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn(),
    ensureCollection: vi.fn(),
  },
}));
vi.mock('../../services/usage-patterns', () => ({
  usagePatterns: { summarizeContext: vi.fn(), summarizeChanges: vi.fn() },
}));
vi.mock('../../services/session-context', () => ({
  sessionContext: {
    startSession: vi.fn(),
    getSession: mocks.getSession,
    addActivity: vi.fn(),
    endSession: vi.fn(),
    listSessions: vi.fn(),
  },
}));
vi.mock('../../services/cache', () => ({
  cacheService: { getCacheAnalytics: vi.fn(), pruneOldSessions: vi.fn() },
}));
vi.mock('../../services/embedding', () => ({
  embeddingService: { getCacheStats: vi.fn(), warmSessionCache: vi.fn() },
}));
vi.mock('../../services/graph-store', () => ({
  graphStore: { getDependents: vi.fn(), getDependencies: vi.fn(), getBlastRadius: vi.fn() },
}));
vi.mock('../../middleware/project-scope', () => ({
  scopeCollectionParam: (_req: any, _res: any, next: any) => next(),
  scopeProjectParam: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../services/digest-builder', () => ({
  digestBuilder: { build: mocks.buildDigest },
}));

import indexRoutes from '../../routes/index';

const app = createTestApp({ router: indexRoutes });

describe('GET /api/session/digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the digest markdown body with Content-Type text/markdown (no JSON wrapper)', async () => {
    const markdown =
      '# Session Digest — testproject\n\n## Pinned\n- [note] always do X\n\n## Project\n- summary';
    mocks.buildDigest.mockResolvedValue({
      markdown,
      lineCount: 7,
      memoryIds: ['m1'],
      snippets: ['always do X'],
      durationMs: 12,
    });

    const res = await request(app).get(
      '/api/session/digest?projectName=testproject&sessionId=sess-1'
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text).toBe(markdown);
    // BODY is the markdown itself — must not be JSON
    expect(() => JSON.parse(res.text)).toThrow();
    expect(mocks.buildDigest).toHaveBeenCalledWith('testproject', 'sess-1');
  });

  it('works without sessionId (digest still built)', async () => {
    mocks.buildDigest.mockResolvedValue({
      markdown: '# Session Digest — testproject',
      lineCount: 1,
      memoryIds: [],
      snippets: [],
      durationMs: 3,
    });

    const res = await request(app).get('/api/session/digest?projectName=testproject');

    expect(res.status).toBe(200);
    expect(mocks.buildDigest).toHaveBeenCalledWith('testproject', undefined);
  });

  it('still answers 200 with a minimal digest when the builder throws (never block a session start)', async () => {
    mocks.buildDigest.mockRejectedValue(new Error('qdrant exploded'));

    const res = await request(app).get(
      '/api/session/digest?projectName=testproject&sessionId=sess-1'
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text).toBe('# Session Digest — testproject');
  });

  it('requires projectName (existing middleware)', async () => {
    const res = await request(app).get('/api/session/digest');
    expect(res.status).toBe(400);
  });

  it('is not shadowed by GET /session/:sessionId', async () => {
    mocks.buildDigest.mockResolvedValue({
      markdown: '# Session Digest — testproject',
      lineCount: 1,
      memoryIds: [],
      snippets: [],
      durationMs: 1,
    });

    const res = await request(app).get('/api/session/digest?projectName=testproject');

    expect(res.status).toBe(200);
    // The param route would have called sessionContext.getSession('digest')
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
