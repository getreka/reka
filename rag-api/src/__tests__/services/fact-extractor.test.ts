import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/cache', () => ({
  cacheService: { set: vi.fn(), get: vi.fn() },
}));

vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: { ingest: vi.fn() },
}));

vi.mock('../../utils/metrics', () => ({
  agentFactsExtracted: { inc: vi.fn() },
}));

import { cacheService } from '../../services/cache';
import { memoryGovernance } from '../../services/memory-governance';
import { agentFactsExtracted } from '../../utils/metrics';
import { factExtractor } from '../../services/fact-extractor';
import type { AgentTask } from '../../services/agent-runtime';

const mockedCache = vi.mocked(cacheService);
const mockedGovernance = vi.mocked(memoryGovernance);
const mockedMetrics = vi.mocked(agentFactsExtracted);

function buildTask(observations: Array<{ tool: string; result: string }>): AgentTask {
  return {
    id: 'task-1',
    type: 'research',
    task: 'test task',
    status: 'completed',
    steps: observations.map((obs, i) => ({
      iteration: i + 1,
      timestamp: new Date().toISOString(),
      thought: 'thinking...',
      observation: { tool: obs.tool, result: obs.result, truncated: false },
    })),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: { iterations: observations.length, toolCalls: observations.length },
  } as any;
}

describe('FactExtractorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGovernance.ingest.mockResolvedValue({ id: 'mem-1' } as any);
    mockedCache.set.mockResolvedValue(undefined as any);
  });

  describe('extractFacts()', () => {
    it('extracts file references from observation text', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/services/memory.ts (score: 0.92)\nHandles memory storage and recall',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);

      expect(facts).toHaveLength(1);
      expect(facts[0].provenance.file).toBe('src/services/memory.ts');
      expect(facts[0].confidence).toBeCloseTo(0.92, 1);
      expect(facts[0].content).toContain('src/services/memory.ts');
    });

    it('extracts multiple file references from one observation', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/a.ts (score: 0.9)\nFirst file\n[2] src/b.ts (score: 0.8)\nSecond file',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts).toHaveLength(2);
    });

    it('extracts import/dependency patterns', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: "Found: import { vectorStore } from './vector-store'",
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts.some((f) => f.type === 'dependency')).toBe(true);
    });

    it('deduplicates facts by content prefix', async () => {
      const task = buildTask([
        { tool: 'search_codebase', result: '[1] src/a.ts (score: 0.9)\nDuplicate content here' },
        { tool: 'search_codebase', result: '[1] src/a.ts (score: 0.9)\nDuplicate content here' },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts).toHaveLength(1);
    });

    it('skips steps without observations', async () => {
      const task = {
        ...buildTask([]),
        steps: [{ iteration: 1, timestamp: new Date().toISOString(), thought: 'thinking...' }],
      } as any;

      const facts = await factExtractor.extractFacts(task);
      expect(facts).toHaveLength(0);
    });

    it('caps confidence at 1.0', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/a.ts (score: 1.50)\nContent here',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts[0].confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('classifyFact (via extractFacts)', () => {
    it('classifies as pattern when tool is get_patterns', async () => {
      const task = buildTask([
        {
          tool: 'get_patterns',
          result: '[1] src/patterns.ts (score: 0.9)\nService Layer pattern',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts[0].type).toBe('pattern');
    });

    it('classifies as issue when content contains error', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/bug.ts (score: 0.9)\nThis has an error in the logic',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts[0].type).toBe('issue');
    });

    it('defaults to finding when no pattern matches', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/utils.ts (score: 0.9)\nHelper function for formatting',
        },
      ]);

      const facts = await factExtractor.extractFacts(task);
      expect(facts[0].type).toBe('finding');
    });
  });

  describe('saveFacts()', () => {
    it('ingests facts via memoryGovernance and saves audit log', async () => {
      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/a.ts (score: 0.9)\nSome finding',
        },
      ]);

      const result = await factExtractor.saveFacts('test', task);

      expect(result.factsCount).toBe(1);
      expect(result.auditLogKey).toBe('audit:test:task-1');
      expect(mockedGovernance.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test',
          type: 'insight',
          tags: expect.arrayContaining(['agent-extracted', 'research']),
        })
      );
      expect(mockedMetrics.inc).toHaveBeenCalled();
    });

    it('continues on individual fact save failure', async () => {
      mockedGovernance.ingest
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ id: 'mem-2' } as any);

      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/a.ts (score: 0.9)\nFact one\n[2] src/b.ts (score: 0.8)\nFact two',
        },
      ]);

      const result = await factExtractor.saveFacts('test', task);
      expect(result.factsCount).toBe(1); // One failed, one succeeded
    });

    it('handles cache.set failure gracefully', async () => {
      mockedCache.set.mockRejectedValue(new Error('redis down'));

      const task = buildTask([
        {
          tool: 'search_codebase',
          result: '[1] src/a.ts (score: 0.9)\nContent',
        },
      ]);

      // Should not throw
      const result = await factExtractor.saveFacts('test', task);
      expect(result.auditLogKey).toBe('audit:test:task-1');
    });
  });
});
