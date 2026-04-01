import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0)),
  embedFull: vi
    .fn()
    .mockResolvedValue({ dense: Array(1024).fill(0), sparse: { indices: [], values: [] } }),
  search: vi.fn().mockResolvedValue([]),
  searchHybridNative: vi.fn().mockResolvedValue([]),
  recall: vi.fn().mockResolvedValue([]),
  expand: vi.fn().mockResolvedValue([]),
  findSymbol: vi.fn().mockResolvedValue([]),
  complete: vi.fn(),
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mocks.embed, embedFull: mocks.embedFull },
  SparseVector: {},
}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: { search: mocks.search, searchHybridNative: mocks.searchHybridNative },
}));
vi.mock('../../services/memory', () => ({
  memoryService: { recall: mocks.recall },
}));
vi.mock('../../services/graph-store', () => ({
  graphStore: { expand: mocks.expand },
}));
vi.mock('../../services/symbol-index', () => ({
  symbolIndex: { findSymbol: mocks.findSymbol },
}));
vi.mock('../../services/llm', () => ({
  llm: { complete: mocks.complete },
}));

import { smartDispatch } from '../../services/smart-dispatch';

describe('SmartDispatchService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.embed.mockResolvedValue(Array(1024).fill(0));
    mocks.search.mockResolvedValue([]);
    mocks.recall.mockResolvedValue([]);
    mocks.expand.mockResolvedValue([]);
    mocks.findSymbol.mockResolvedValue([]);
  });

  describe('dispatch — LLM routing', () => {
    it('uses LLM routing and executes plan', async () => {
      mocks.complete.mockResolvedValue({
        text: JSON.stringify({
          lookups: ['code_search', 'memory'],
          reasoning: 'debug task needs memory',
        }),
      });

      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'fix auth bug',
      });

      expect(result.plan).toContain('code_search');
      expect(result.plan).toContain('memory');
      expect(result.reasoning).toContain('debug');
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('falls back to heuristic on LLM failure', async () => {
      mocks.complete.mockRejectedValue(new Error('LLM down'));

      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'fix broken login bug',
      });

      // Heuristic should match debug patterns
      expect(result.plan).toContain('code_search');
      expect(result.reasoning).toContain('Heuristic');
    });
  });

  describe('heuristic routing', () => {
    beforeEach(() => {
      mocks.complete.mockRejectedValue(new Error('force heuristic'));
    });

    it('debug task includes memory + graph', async () => {
      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'debug error in authentication',
        files: ['src/auth.ts'],
      });

      expect(result.plan).toContain('memory');
      expect(result.plan).toContain('graph');
    });

    it('architecture task includes patterns + adrs', async () => {
      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'refactor the middleware architecture',
      });

      expect(result.plan).toContain('patterns');
      expect(result.plan).toContain('adrs');
    });

    it('new feature includes patterns + adrs', async () => {
      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'implement rate limiting feature',
      });

      expect(result.plan).toContain('patterns');
      expect(result.plan).toContain('adrs');
    });

    it('with files specified includes graph', async () => {
      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'review this code',
        files: ['src/services/auth.ts'],
        intent: 'review',
      });

      expect(result.plan).toContain('graph');
    });
  });

  describe('parallel execution', () => {
    it('individual lookup failure does not crash dispatch', async () => {
      mocks.complete.mockResolvedValue({
        text: JSON.stringify({ lookups: ['code_search', 'memory'], reasoning: 'test' }),
      });
      mocks.recall.mockRejectedValue(new Error('memory service down'));

      const result = await smartDispatch.dispatch({
        projectName: 'test',
        task: 'test task',
      });

      // Should succeed even if memory lookup fails
      expect(result.plan).toContain('memory');
      expect(result.context.memories).toBeUndefined(); // failed, so not set
    });
  });
});
