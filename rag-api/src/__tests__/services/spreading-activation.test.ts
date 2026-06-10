import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    SPREADING_ACTIVATION_MAX_HOPS: 2,
    SPREADING_ACTIVATION_THRESHOLD: 0.3,
    SPREADING_ACTIVATION_HOP_DECAY: 0.7,
    SPREADING_ACTIVATION_CACHE_TTL: 300,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockGetNodes = vi.hoisted(() => vi.fn());
const mockGetNode = vi.hoisted(() => vi.fn());

vi.mock('../../services/memory-graph', () => ({
  memoryGraph: {
    getNodes: mockGetNodes,
    getNode: mockGetNode,
  },
}));

import { spreadingActivation } from '../../services/spreading-activation';

describe('SpreadingActivationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
  });

  it('returns seeds when no relationships exist', async () => {
    mockGetNodes.mockResolvedValue([
      { id: 'a', content: 'fact A', type: 'insight', relationships: [] },
    ]);

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 0.8 }]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
    expect(result[0].activation).toBe(0.8);
    expect(result[0].hop).toBe(0);
  });

  it('propagates activation along edges with correct weights', async () => {
    mockGetNodes.mockResolvedValue([
      {
        id: 'a',
        content: 'root',
        type: 'decision',
        relationships: [{ targetId: 'b', type: 'supersedes', reason: 'newer' }],
      },
    ]);
    mockGetNode.mockResolvedValue({
      id: 'b',
      content: 'neighbor',
      type: 'insight',
      relationships: [],
    });

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 1.0 }]);

    expect(result).toHaveLength(2);
    // Seed
    expect(result[0].id).toBe('a');
    expect(result[0].activation).toBe(1.0);
    // Neighbor: 1.0 * 0.9 (supersedes weight) * 0.7 (hop decay) = 0.63
    const b = result.find((r) => r.id === 'b')!;
    expect(b.activation).toBeCloseTo(0.63, 2);
    expect(b.hop).toBe(1);
    expect(b.activatedVia).toBe('supersedes');
  });

  it('respects max hops limit', async () => {
    // Chain: a → b → c → d (3 hops)
    mockGetNodes.mockResolvedValue([
      {
        id: 'a',
        content: 'root',
        type: 'decision',
        relationships: [{ targetId: 'b', type: 'follow_up' }],
      },
    ]);
    mockGetNode
      .mockResolvedValueOnce({
        id: 'b',
        content: 'hop1',
        type: 'insight',
        relationships: [{ targetId: 'c', type: 'follow_up' }],
      })
      .mockResolvedValueOnce({
        id: 'c',
        content: 'hop2',
        type: 'insight',
        relationships: [{ targetId: 'd', type: 'follow_up' }],
      })
      .mockResolvedValueOnce({
        id: 'd',
        content: 'hop3',
        type: 'insight',
        relationships: [],
      });

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 1.0 }], {
      maxHops: 2,
      threshold: 0.1,
    }); // low threshold to allow 2-hop propagation

    const ids = result.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids).not.toContain('d'); // beyond max 2 hops
  });

  it('cuts off below activation threshold', async () => {
    // relates_to has low weight (0.3), so propagation dies quickly
    mockGetNodes.mockResolvedValue([
      {
        id: 'a',
        content: 'root',
        type: 'note',
        relationships: [{ targetId: 'b', type: 'relates_to' }],
      },
    ]);
    mockGetNode.mockResolvedValue({
      id: 'b',
      content: 'weak',
      type: 'note',
      relationships: [],
    });

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 0.5 }], {
      threshold: 0.3,
    });

    // b activation = 0.5 * 0.3 * 0.7 = 0.105 → below 0.3 threshold
    expect(result).toHaveLength(1); // only seed
    expect(result[0].id).toBe('a');
  });

  it('uses correct edge weights for different types', async () => {
    mockGetNodes.mockResolvedValue([
      {
        id: 'a',
        content: 'root',
        type: 'decision',
        relationships: [
          { targetId: 'b', type: 'caused_by' }, // weight 0.8
          { targetId: 'c', type: 'relates_to' }, // weight 0.3
        ],
      },
    ]);
    mockGetNode
      .mockResolvedValueOnce({ id: 'b', content: 'cause', type: 'insight', relationships: [] })
      .mockResolvedValueOnce({ id: 'c', content: 'related', type: 'note', relationships: [] });

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 1.0 }], {
      threshold: 0.1,
    });

    const b = result.find((r) => r.id === 'b')!;
    const c = result.find((r) => r.id === 'c')!;

    // b: 1.0 * 0.8 * 0.7 = 0.56
    // c: 1.0 * 0.3 * 0.7 = 0.21
    expect(b.activation).toBeCloseTo(0.56, 2);
    expect(c.activation).toBeCloseTo(0.21, 2);
    expect(b.activation).toBeGreaterThan(c.activation);
  });

  it('returns empty for empty seeds', async () => {
    const result = await spreadingActivation.activate('proj', []);
    expect(result).toHaveLength(0);
  });

  it('results sorted by activation descending', async () => {
    mockGetNodes.mockResolvedValue([
      {
        id: 'a',
        content: 'root',
        type: 'decision',
        relationships: [{ targetId: 'b', type: 'supersedes' }],
      },
    ]);
    mockGetNode.mockResolvedValue({
      id: 'b',
      content: 'neighbor',
      type: 'insight',
      relationships: [],
    });

    const result = await spreadingActivation.activate('proj', [{ id: 'a', activation: 1.0 }]);

    expect(result[0].activation).toBeGreaterThanOrEqual(result[1].activation);
  });
});
