import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    CONSOLIDATION_TIMEOUT_MS: 120000,
    CONSOLIDATION_LLM_TIMEOUT_MS: 30000,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockComplete = vi.hoisted(() => vi.fn());
vi.mock('../../services/llm', () => ({
  llm: { completeWithBestProvider: mockComplete },
}));

const mockWmGetAll = vi.hoisted(() => vi.fn());
vi.mock('../../services/working-memory', () => ({
  workingMemory: { getAll: mockWmGetAll },
}));

const mockSbRead = vi.hoisted(() => vi.fn());
const mockSbAppend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: { read: mockSbRead, append: mockSbAppend },
}));

const mockStoreEpisodic = vi.hoisted(() => vi.fn());
const mockStoreSemantic = vi.hoisted(() => vi.fn());
vi.mock('../../services/memory-ltm', () => ({
  memoryLtm: {
    storeEpisodic: mockStoreEpisodic,
    storeSemantic: mockStoreSemantic,
  },
}));

vi.mock('../../services/relationship-classifier', () => ({
  relationshipClassifier: { classify: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: { search: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../services/graph-store', () => ({
  graphStore: { indexMemoryEdges: vi.fn().mockResolvedValue(undefined) },
}));

import { consolidationAgent, ConsolidationFailedError } from '../../services/consolidation-agent';

// A working-memory slot / sensory event batch large enough to trigger LLM steps.
function busySession() {
  mockWmGetAll.mockResolvedValue([
    { toolName: 'search', content: 'how does auth work', salience: 0.8, files: ['a.ts'] },
    { toolName: 'edit', content: 'fixed auth bug', salience: 0.9, files: ['a.ts'] },
  ]);
  mockSbRead.mockResolvedValue([
    { toolName: 'search', inputSummary: 'auth', durationMs: 10, success: true },
    { toolName: 'edit', inputSummary: 'auth.ts', durationMs: 20, success: true },
    { toolName: 'test', inputSummary: 'run', durationMs: 30, success: true },
  ]);
}

describe('ConsolidationAgentService.consolidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSbAppend.mockResolvedValue(undefined);
  });

  it('returns a successful (no-throw) empty result when there is nothing to consolidate', async () => {
    mockWmGetAll.mockResolvedValue([]);
    mockSbRead.mockResolvedValue([]);

    const result = await consolidationAgent.consolidate('proj', 'sess');

    expect(result.episodic).toHaveLength(0);
    expect(result.semantic).toHaveLength(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('THROWS ConsolidationFailedError when the LLM pattern-detection call fails', async () => {
    busySession();
    mockComplete.mockRejectedValue(new Error('ollama down'));

    await expect(consolidationAgent.consolidate('proj', 'sess')).rejects.toBeInstanceOf(
      ConsolidationFailedError
    );
  });

  it('enforces CONSOLIDATION_LLM_TIMEOUT_MS via a local race (hung LLM → throw)', async () => {
    busySession();
    // LLM never resolves → the local timeout race must reject.
    mockComplete.mockImplementation(() => new Promise(() => {}));

    await expect(
      consolidationAgent.consolidate('proj', 'sess', { timeout: 20 })
    ).rejects.toBeInstanceOf(ConsolidationFailedError);
  });

  describe('episodic vs semantic routing (abstraction step)', () => {
    // Queue the two LLM calls consolidate() makes: pattern detection, then abstraction.
    function mockLlmAbstraction(memories: unknown[]) {
      mockComplete
        .mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) })
        .mockResolvedValueOnce({ text: JSON.stringify({ memories }) });
    }

    beforeEach(() => {
      busySession();
      mockStoreEpisodic.mockImplementation(async (opts: any) => ({
        id: 'ep-1',
        content: opts.content,
        sessionId: opts.sessionId,
      }));
      mockStoreSemantic.mockImplementation(async (opts: any) => ({
        id: 'sem-1',
        content: opts.content,
        subtype: opts.subtype,
      }));
    });

    it('stores isEpisodic:true memories via memoryLtm.storeEpisodic and populates result.episodic', async () => {
      mockLlmAbstraction([
        {
          content:
            'Build failed with ECONNREFUSED to Qdrant; restarting docker-compose fixed it after pruning the network.',
          subtype: 'insight',
          confidence: 0.8,
          tags: ['incident'],
          files: ['docker/docker-compose.yml'],
          isEpisodic: true,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreEpisodic).toHaveBeenCalledTimes(1);
      expect(mockStoreEpisodic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'proj',
          sessionId: 'sess',
          content: expect.stringContaining('ECONNREFUSED'),
        })
      );
      expect(mockStoreSemantic).not.toHaveBeenCalled();
      expect(result.episodic).toHaveLength(1);
      expect(result.episodic[0]).toEqual({
        id: 'ep-1',
        content: expect.stringContaining('ECONNREFUSED'),
      });
      expect(result.semantic).toHaveLength(0);
    });

    it('stores isEpisodic:false memories via memoryLtm.storeSemantic and populates result.semantic', async () => {
      mockLlmAbstraction([
        {
          content: 'The BGE-M3 batch endpoint is /embed/batch, not /embed_batch.',
          subtype: 'insight',
          confidence: 0.9,
          tags: ['api'],
          files: [],
          isEpisodic: false,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(mockStoreSemantic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'proj',
          subtype: 'insight',
          source: 'consolidation',
        })
      );
      expect(mockStoreEpisodic).not.toHaveBeenCalled();
      expect(result.semantic).toHaveLength(1);
      expect(result.semantic[0].id).toBe('sem-1');
      expect(result.episodic).toHaveLength(0);
    });

    it('defaults a missing isEpisodic field to false (semantic path, ?? false fallback)', async () => {
      mockLlmAbstraction([
        {
          content: 'All route validation uses centralized Zod schemas in utils/validation.ts.',
          subtype: 'decision',
          confidence: 0.7,
          tags: [],
          files: [],
          // isEpisodic intentionally omitted
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(mockStoreEpisodic).not.toHaveBeenCalled();
      expect(result.semantic).toHaveLength(1);
      expect(result.episodic).toHaveLength(0);
    });

    it('routes a mixed batch to both stores in one consolidate() run', async () => {
      mockLlmAbstraction([
        {
          content:
            'Deploy hung: tag pushed before lockfile sync; regenerated lockfile and re-tagged.',
          subtype: 'insight',
          confidence: 0.8,
          tags: ['release'],
          files: [],
          isEpisodic: true,
        },
        {
          content: 'Decision: lockfiles must be generated with npm 10 to keep CI npm ci green.',
          subtype: 'decision',
          confidence: 0.9,
          tags: ['ci'],
          files: [],
          isEpisodic: false,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreEpisodic).toHaveBeenCalledTimes(1);
      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(result.episodic).toHaveLength(1);
      expect(result.semantic).toHaveLength(1);
    });
  });
});
