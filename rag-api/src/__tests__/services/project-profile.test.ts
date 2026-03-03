import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    aggregateStats: vi.fn(),
  },
}));

vi.mock('../../services/memory', () => ({
  memoryService: {
    recall: vi.fn(),
  },
}));

vi.mock('../../services/llm', () => ({
  llm: {
    complete: vi.fn(),
  },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import { vectorStore } from '../../services/vector-store';
import { memoryService } from '../../services/memory';
import { llm } from '../../services/llm';
import { cacheService } from '../../services/cache';
import { projectProfileService } from '../../services/project-profile';

const mockedVS = vi.mocked(vectorStore);
const mockedMemory = vi.mocked(memoryService);
const mockedLLM = vi.mocked(llm);
const mockedCache = vi.mocked(cacheService);

describe('ProjectProfileService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedVS.aggregateStats.mockResolvedValue({
      totalFiles: 50,
      totalVectors: 200,
      languages: { typescript: 30, javascript: 10, python: 5 },
    });
    mockedMemory.recall.mockResolvedValue([]);
    mockedLLM.complete.mockResolvedValue({ text: 'A TypeScript RAG infrastructure project.', usage: {} as any });
    mockedCache.get.mockResolvedValue(null);
    mockedCache.set.mockResolvedValue(undefined as any);
  });

  describe('getProfile()', () => {
    it('returns cached profile on cache hit', async () => {
      const cached = {
        projectName: 'test',
        techStack: { languages: { typescript: 30 }, frameworks: ['Node.js'] },
        conventions: { patterns: [], adrs: [] },
        summary: 'cached summary',
        lastUpdated: '2025-01-01T00:00:00Z',
      };
      mockedCache.get.mockResolvedValue(cached);

      const profile = await projectProfileService.getProfile('test');

      expect(profile.summary).toBe('cached summary');
      expect(mockedVS.aggregateStats).not.toHaveBeenCalled();
    });

    it('builds fresh profile on cache miss', async () => {
      const profile = await projectProfileService.getProfile('test');

      expect(profile.projectName).toBe('test');
      expect(profile.techStack.languages.typescript).toBe(30);
      expect(profile.techStack.frameworks).toContain('Node.js');
      expect(profile.summary).toBeTruthy();
      expect(mockedCache.set).toHaveBeenCalled();
    });
  });

  describe('refreshProfile()', () => {
    it('bypasses cache and rebuilds', async () => {
      mockedCache.get.mockResolvedValue({ summary: 'stale' } as any);

      const profile = await projectProfileService.refreshProfile('test');

      // Should NOT call cache.get, but SHOULD call set
      expect(mockedVS.aggregateStats).toHaveBeenCalled();
      expect(mockedCache.set).toHaveBeenCalled();
      expect(profile.techStack.languages.typescript).toBe(30);
    });
  });

  describe('getCompactSummary()', () => {
    it('returns formatted compact string', async () => {
      const summary = await projectProfileService.getCompactSummary('test');

      expect(summary).toContain('Project: test');
      expect(summary).toContain('typescript');
    });

    it('returns null when summary is empty', async () => {
      mockedLLM.complete.mockResolvedValue({ text: '', usage: {} as any });

      const summary = await projectProfileService.getCompactSummary('test');
      expect(summary).toBeNull();
    });

    it('returns null on error', async () => {
      mockedCache.get.mockRejectedValue(new Error('redis down'));

      const summary = await projectProfileService.getCompactSummary('test');
      expect(summary).toBeNull();
    });
  });

  describe('buildTechStack (via getProfile)', () => {
    it('detects Node.js from typescript/javascript', async () => {
      const profile = await projectProfileService.getProfile('test');
      expect(profile.techStack.frameworks).toContain('Node.js');
    });

    it('detects Vue.js from vue language', async () => {
      mockedVS.aggregateStats.mockResolvedValue({
        totalFiles: 10, totalVectors: 50,
        languages: { vue: 10, typescript: 5 },
      });

      const profile = await projectProfileService.getProfile('test');
      expect(profile.techStack.frameworks).toContain('Vue.js');
    });

    it('handles aggregateStats failure gracefully', async () => {
      mockedVS.aggregateStats.mockRejectedValue(new Error('not indexed'));

      const profile = await projectProfileService.getProfile('test');
      expect(profile.techStack.languages).toEqual({});
    });
  });

  describe('buildConventions (via getProfile)', () => {
    it('includes patterns from memory recall', async () => {
      mockedMemory.recall.mockResolvedValueOnce([
        { memory: { content: 'Service Layer pattern', relatedTo: 'architecture' }, score: 0.8 },
      ] as any).mockResolvedValueOnce([]); // ADR call

      const profile = await projectProfileService.getProfile('test');
      expect(profile.conventions.patterns).toHaveLength(1);
      expect(profile.conventions.patterns[0].name).toBe('architecture');
    });

    it('filters out low-score patterns', async () => {
      mockedMemory.recall.mockResolvedValueOnce([
        { memory: { content: 'Weak match', relatedTo: 'weak' }, score: 0.3 },
      ] as any).mockResolvedValueOnce([]);

      const profile = await projectProfileService.getProfile('test');
      expect(profile.conventions.patterns).toHaveLength(0);
    });
  });

  describe('generateSummary (via getProfile)', () => {
    it('calls LLM and returns summary text', async () => {
      const profile = await projectProfileService.getProfile('test');
      expect(mockedLLM.complete).toHaveBeenCalledWith(
        expect.stringContaining('Summarize this project'),
        expect.objectContaining({ maxTokens: 200, think: false })
      );
      expect(profile.summary).toBe('A TypeScript RAG infrastructure project.');
    });

    it('falls back to simple summary on LLM error', async () => {
      mockedLLM.complete.mockRejectedValue(new Error('LLM timeout'));

      const profile = await projectProfileService.getProfile('test');
      expect(profile.summary).toContain('test project with');
      expect(profile.summary).toContain('languages');
    });
  });
});
