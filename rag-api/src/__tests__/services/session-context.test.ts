import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0)),
  upsert: vi.fn().mockResolvedValue(undefined),
  scroll: vi.fn().mockResolvedValue({ points: [] }),
  recall: vi.fn().mockResolvedValue([]),
  mergeMemories: vi.fn().mockResolvedValue({ totalMerged: 0 }),
  ingest: vi.fn().mockResolvedValue({ id: 'mem-1' }),
  extractEntities: vi.fn().mockResolvedValue({ files: [], functions: [], concepts: [] }),
  analyze: vi.fn().mockResolvedValue({ learnings: [] }),
  summarizeChanges: vi.fn().mockResolvedValue({ toolsUsed: [], filesAffected: [], summary: '' }),
  predict: vi.fn().mockResolvedValue([]),
  prefetch: vi.fn().mockResolvedValue(undefined),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  getCompactSummary: vi.fn().mockResolvedValue(null),
  buildDeveloperProfile: vi.fn().mockResolvedValue({ totalToolCalls: 0 }),
}));

vi.mock('../../services/embedding', () => ({ embeddingService: { embed: mocks.embed } }));
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: mocks.upsert,
    client: { scroll: mocks.scroll },
  },
  VectorPoint: {},
}));
vi.mock('../../services/memory', () => ({
  memoryService: { recall: mocks.recall, mergeMemories: mocks.mergeMemories },
}));
vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: { ingest: mocks.ingest },
}));
vi.mock('../../services/conversation-analyzer', () => ({
  conversationAnalyzer: { extractEntities: mocks.extractEntities, analyze: mocks.analyze },
}));
vi.mock('../../services/usage-patterns', () => ({
  usagePatterns: { summarizeChanges: mocks.summarizeChanges, buildDeveloperProfile: mocks.buildDeveloperProfile },
}));
vi.mock('../../services/predictive-loader', () => ({
  predictiveLoader: { predict: mocks.predict, prefetch: mocks.prefetch },
}));
vi.mock('../../services/cache', () => ({
  cacheService: {
    get: mocks.cacheGet,
    set: mocks.cacheSet,
    delete: mocks.cacheDelete,
  },
}));
vi.mock('../../services/project-profile', () => ({
  projectProfileService: { getCompactSummary: mocks.getCompactSummary },
}));

import { sessionContext } from '../../services/session-context';

describe('SessionContextService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.embed.mockResolvedValue(Array(1024).fill(0));
    mocks.scroll.mockResolvedValue({ points: [] });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.predict.mockResolvedValue([]);
    mocks.mergeMemories.mockResolvedValue({ totalMerged: 0 });
    mocks.buildDeveloperProfile.mockResolvedValue({ totalToolCalls: 0 });
    // Reset auto-merge throttle
    (sessionContext as any).lastMergeTime = new Map();
  });

  describe('startSession', () => {
    it('creates new context with correct fields', async () => {
      const ctx = await sessionContext.startSession({
        projectName: 'test',
        sessionId: 'sess-1',
      });

      expect(ctx.sessionId).toBe('sess-1');
      expect(ctx.projectName).toBe('test');
      expect(ctx.status).toBe('active');
      expect(ctx.currentFiles).toEqual([]);
      expect(ctx.recentQueries).toEqual([]);
      expect(mocks.cacheSet).toHaveBeenCalled();
    });

    it('resumes from previous session when resumeFrom given', async () => {
      const prevContext = {
        sessionId: 'prev',
        projectName: 'test',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        currentFiles: ['a.ts'],
        recentQueries: ['query1'],
        activeFeatures: ['auth'],
        decisions: ['use JWT'],
        toolsUsed: [],
        pendingLearnings: [],
        metadata: {},
        status: 'ended',
      };
      // cacheGet is called: once for getSession(prev) during resume
      // We need to return prevContext when getSession is called with 'prev'
      mocks.cacheGet.mockImplementation(async (key: string) => {
        if (key.includes('prev')) return prevContext;
        return null;
      });

      const ctx = await sessionContext.startSession({
        projectName: 'test',
        sessionId: 'sess-2',
        resumeFrom: 'prev',
      });

      expect(ctx.currentFiles).toEqual(['a.ts']);
      expect(ctx.decisions).toEqual(['use JWT']);
    });

    it('extracts entities from initialContext', async () => {
      mocks.extractEntities.mockResolvedValue({
        files: ['src/auth.ts'],
        functions: ['login'],
        concepts: ['authentication'],
      });

      const ctx = await sessionContext.startSession({
        projectName: 'test',
        sessionId: 'sess-3',
        initialContext: 'Working on auth in src/auth.ts',
      });

      expect(ctx.currentFiles).toContain('src/auth.ts');
      expect(ctx.activeFeatures).toContain('authentication');
    });
  });

  describe('getSession', () => {
    it('returns from cache on hit', async () => {
      const cached = { sessionId: 'sess-1', projectName: 'test', status: 'active' };
      mocks.cacheGet.mockResolvedValue(cached);

      const result = await sessionContext.getSession('test', 'sess-1');
      expect(result).toEqual(cached);
    });

    it('falls back to Qdrant when cache misses', async () => {
      mocks.cacheGet.mockResolvedValue(null);
      mocks.scroll.mockResolvedValue({
        points: [{ payload: { sessionId: 'sess-1', projectName: 'test', status: 'active' } }],
      });

      const result = await sessionContext.getSession('test', 'sess-1');
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('sess-1');
    });

    it('returns null when not found', async () => {
      mocks.cacheGet.mockResolvedValue(null);
      mocks.scroll.mockResolvedValue({ points: [] });

      const result = await sessionContext.getSession('test', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('endSession', () => {
    it('returns summary and clears cache', async () => {
      const sessionData = {
        sessionId: 'sess-1',
        projectName: 'test',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        lastActivityAt: new Date().toISOString(),
        status: 'active',
        currentFiles: ['a.ts'],
        recentQueries: ['q1'],
        activeFeatures: [],
        toolsUsed: ['search'],
        pendingLearnings: [],
        decisions: [],
        metadata: {},
      };
      mocks.cacheGet.mockResolvedValue(sessionData);
      mocks.summarizeChanges.mockResolvedValue({ toolsUsed: [], filesAffected: [], summary: '', keyActions: [] });

      const summary = await sessionContext.endSession({
        projectName: 'test',
        sessionId: 'sess-1',
        summary: 'Worked on auth',
      });

      expect(summary.sessionId).toBe('sess-1');
      expect(summary.duration).toBeGreaterThan(0);
      expect(summary.summary).toBe('Worked on auth');
      expect(mocks.cacheDelete).toHaveBeenCalled();
    });

    it('throws when session not found', async () => {
      mocks.cacheGet.mockResolvedValue(null);
      mocks.scroll.mockResolvedValue({ points: [] });

      await expect(
        sessionContext.endSession({ projectName: 'test', sessionId: 'nonexistent' })
      ).rejects.toThrow('Session not found');
    });
  });
});
