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

vi.mock('../../services/memory-ltm', () => ({
  memoryLtm: {
    storeEpisodic: vi.fn(),
    storeSemantic: vi.fn(),
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
});
