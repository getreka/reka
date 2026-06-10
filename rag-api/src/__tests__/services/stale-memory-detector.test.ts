import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    CONSOLIDATION_ENABLED: true,
    EPISODIC_BASE_STABILITY_DAYS: 7,
    SEMANTIC_BASE_STABILITY_DAYS: 90,
    PROCEDURAL_BASE_STABILITY_DAYS: 180,
    RECALL_STRENGTHENING_FACTOR: 1.5,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockScroll = vi.hoisted(() => vi.fn());
vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    client: { scroll: mockScroll },
  },
}));

// Keep transitive imports (via memory-ltm's computeRetention) light.
vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: vi.fn().mockResolvedValue([]) },
}));

import { staleMemoryDetector } from '../../services/stale-memory-detector';

function notFound() {
  const e = new Error('Not found') as any;
  e.status = 404;
  return e;
}

describe('StaleMemoryDetector.detectStaleMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scans the _agent_memory durable collection (not _memory)', async () => {
    mockScroll.mockResolvedValue({ points: [], next_page_offset: undefined });

    await staleMemoryDetector.detectStaleMemories('proj');

    const scannedCollections = mockScroll.mock.calls.map((c) => c[0]);
    expect(scannedCollections).toContain('proj_agent_memory');
    expect(scannedCollections).not.toContain('proj_memory');
  });

  it('still runs the LTM (Ebbinghaus) scan when the durable collection 404s', async () => {
    // 200 days old, stability 7d, never accessed → retention well below 0.1
    const oldCreatedAt = new Date(Date.now() - 200 * 86_400_000).toISOString();

    mockScroll.mockImplementation(async (collection: string) => {
      if (collection === 'proj_agent_memory') {
        throw notFound(); // durable collection does not exist
      }
      if (collection === 'proj_memory_episodic') {
        return {
          points: [
            {
              id: 'ep-1',
              payload: {
                content: 'an old never-accessed episodic memory',
                createdAt: oldCreatedAt,
                stability: 7,
                accessCount: 0,
                tags: [],
              },
            },
          ],
          next_page_offset: undefined,
        };
      }
      return { points: [], next_page_offset: undefined };
    });

    const result = await staleMemoryDetector.detectStaleMemories('proj');

    // The LTM scan ran despite the durable 404 and surfaced the decaying memory.
    expect(result.staleMemories.some((m) => m.id === 'ep-1')).toBe(true);
    expect(result.staleMemories[0].reason).toMatch(/Ebbinghaus/);
  });
});
