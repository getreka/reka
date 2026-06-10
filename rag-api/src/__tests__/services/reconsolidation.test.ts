import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    CORECALL_TTL_DAYS: 30,
    CORECALL_THRESHOLD: 3,
    RECALL_STRENGTHENING_FACTOR: 1.5,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// No Redis client in unit tests → co-recall tracking is a no-op.
vi.mock('../../services/cache', () => ({
  cacheService: { getClient: vi.fn(() => null) },
}));

const mockStrengthenOnRecall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/memory-ltm', () => ({
  memoryLtm: { strengthenOnRecall: mockStrengthenOnRecall },
}));

vi.mock('../../services/relationship-classifier', () => ({
  relationshipClassifier: { classify: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: { client: {} },
}));

import { reconsolidation } from '../../services/reconsolidation';

describe('ReconsolidationService.onRecall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strengthens episodic + semantic recalls (spaced repetition fires)', async () => {
    await reconsolidation.onRecall(
      'test',
      [
        { id: 'ep-1', content: 'episodic fact', collection: 'episodic' },
        { id: 'sem-1', content: 'semantic fact', collection: 'semantic' },
      ],
      'some query'
    );

    expect(mockStrengthenOnRecall).toHaveBeenCalledTimes(2);
    expect(mockStrengthenOnRecall).toHaveBeenCalledWith('test', 'ep-1', 'episodic');
    expect(mockStrengthenOnRecall).toHaveBeenCalledWith('test', 'sem-1', 'semantic');
  });

  it('does NOT strengthen durable recalls (durable has no Ebbinghaus stability)', async () => {
    await reconsolidation.onRecall(
      'test',
      [{ id: 'dur-1', content: 'durable fact', collection: 'durable' }],
      'q'
    );

    expect(mockStrengthenOnRecall).not.toHaveBeenCalled();
  });

  it('is a no-op for empty results', async () => {
    await reconsolidation.onRecall('test', [], 'q');
    expect(mockStrengthenOnRecall).not.toHaveBeenCalled();
  });
});
