import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the Qdrant client out of the module graph — modelCostUsd is pure and never
// touches it, but importing llm-usage-logger pulls vector-store in transitively.
const storeMocks = vi.hoisted(() => ({
  ensureCollection: vi.fn(),
  upsert: vi.fn(),
  scrollCollection: vi.fn(),
}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: storeMocks,
}));

import { modelCostUsd, llmUsageLogger } from '../../services/llm-usage-logger';

describe('modelCostUsd', () => {
  it('prices input + output tokens at the per-model rate', () => {
    // claude-opus-4-8: $5/1M input, $25/1M output
    const cost = modelCostUsd('claude-opus-4-8', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25, 6);
  });

  it('falls back to Sonnet pricing for unknown models', () => {
    // claude-sonnet-4-6: $3/1M input, $15/1M output
    const cost = modelCostUsd('some-unknown-model', {
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(cost).toBeCloseTo(3, 6);
  });

  it('prices cache-creation tokens at ~1.25x the input rate', () => {
    // Sonnet input = $3/1M → 1M cache-creation tokens = 3 * 1.25 = $3.75
    const cost = modelCostUsd('claude-sonnet-4-6', {
      promptTokens: 0,
      completionTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 * 1.25, 6);
  });

  it('prices cache-read tokens at ~0.1x the input rate', () => {
    // Sonnet input = $3/1M → 1M cache-read tokens = 3 * 0.1 = $0.30
    const cost = modelCostUsd('claude-sonnet-4-6', {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 * 0.1, 6);
  });

  it('sums input, output, and both cache token classes', () => {
    // Opus: input $5, output $25
    // 0.5M prompt (2.5) + 0.4M completion (10) + 0.2M cache-write (5*1.25*0.2=1.25)
    //   + 1M cache-read (5*0.1=0.5) = 14.25
    const cost = modelCostUsd('claude-opus-4-8', {
      promptTokens: 500_000,
      completionTokens: 400_000,
      cacheCreationTokens: 200_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.5 + 10 + 1.25 + 0.5, 6);
  });

  it('applies the 50% Batches API discount to all token classes (M1 acceptance)', () => {
    // claude-opus-4-8: $5/1M input, $25/1M output → (5 + 25) × 0.5 = 15.0
    const cost = modelCostUsd(
      'claude-opus-4-8',
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      { batch: true }
    );
    expect(cost).toBe(15.0);
  });

  it('applies the batch discount to cache token classes too', () => {
    // Sonnet input $3/1M: 1M cache-write = 3×1.25 = 3.75; 1M cache-read = 3×0.1 = 0.30
    // → (3.75 + 0.30) × 0.5 = 2.025
    const cost = modelCostUsd(
      'claude-sonnet-4-6',
      {
        promptTokens: 0,
        completionTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
      { batch: true }
    );
    expect(cost).toBeCloseTo((3 * 1.25 + 3 * 0.1) * 0.5, 9);
  });

  it('charges full price when batch is false or omitted', () => {
    const tokens = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    expect(modelCostUsd('claude-opus-4-8', tokens, { batch: false })).toBe(30.0);
    expect(modelCostUsd('claude-opus-4-8', tokens)).toBe(30.0);
  });

  it('treats omitted cache token counts as zero', () => {
    const withCache = modelCostUsd('claude-sonnet-4-6', {
      promptTokens: 100_000,
      completionTokens: 100_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    const withoutCache = modelCostUsd('claude-sonnet-4-6', {
      promptTokens: 100_000,
      completionTokens: 100_000,
    });
    expect(withCache).toBeCloseTo(withoutCache, 9);
  });
});

describe('llmUsageLogger.summarize', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 100,
    caller: 'complete',
    timestamp: '2026-06-10T12:00:00.000Z',
    thinking: false,
    success: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.scrollCollection.mockResolvedValue({ points: [] });
  });

  it('aggregates totals and a per-model breakdown from {project}_llm_usage', async () => {
    storeMocks.scrollCollection.mockResolvedValue({
      points: [
        { id: 1, payload: entry({ cacheReadTokens: 2000 }) },
        { id: 2, payload: entry({ provider: 'ollama', model: 'qwen3.5:9b' }) },
        { id: 3, payload: entry({ success: false, error: 'boom' }) },
      ],
    });

    const summary = await llmUsageLogger.summarize('myproj');

    expect(storeMocks.scrollCollection).toHaveBeenCalledWith('myproj_llm_usage', 1000, undefined);
    expect(summary.project).toBe('myproj');
    expect(summary.totals.requests).toBe(3);
    expect(summary.failures).toBe(1);
    expect(summary.totals.promptTokens).toBe(3000);
    expect(summary.totals.completionTokens).toBe(1500);
    expect(summary.totals.cacheReadTokens).toBe(2000);
    expect(summary.byModel['claude-opus-4-8'].requests).toBe(2);
    expect(summary.byModel['qwen3.5:9b'].requests).toBe(1);
    // Cost: only the two anthropic entries are priced; ollama is $0.
    // Opus: 2 × (1000×$5/1M + 500×$25/1M) + 2000 cache-read × $5×0.1/1M = 0.036
    expect(summary.totals.costUsd).toBeCloseTo(0.036, 6);
    expect(summary.byModel['qwen3.5:9b'].costUsd).toBe(0);
  });

  it('filters entries outside the requested date range', async () => {
    storeMocks.scrollCollection.mockResolvedValue({
      points: [
        { id: 1, payload: entry({ timestamp: '2026-06-01T00:00:00.000Z' }) },
        { id: 2, payload: entry({ timestamp: '2026-06-10T00:00:00.000Z' }) },
        { id: 3, payload: entry({ timestamp: '2026-06-20T00:00:00.000Z' }) },
      ],
    });

    const summary = await llmUsageLogger.summarize('myproj', {
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
    });

    expect(summary.totals.requests).toBe(1);
    expect(summary.from).toBe('2026-06-05T00:00:00.000Z');
    expect(summary.to).toBe('2026-06-15T00:00:00.000Z');
  });

  it('follows scroll pagination via nextOffset', async () => {
    storeMocks.scrollCollection
      .mockResolvedValueOnce({ points: [{ id: 1, payload: entry() }], nextOffset: 'page2' })
      .mockResolvedValueOnce({ points: [{ id: 2, payload: entry() }] });

    const summary = await llmUsageLogger.summarize('myproj');

    expect(storeMocks.scrollCollection).toHaveBeenCalledTimes(2);
    expect(storeMocks.scrollCollection).toHaveBeenLastCalledWith('myproj_llm_usage', 1000, 'page2');
    expect(summary.totals.requests).toBe(2);
  });

  it('prices batch-flagged entries at 50%', async () => {
    storeMocks.scrollCollection.mockResolvedValue({
      points: [
        { id: 1, payload: entry() },
        { id: 2, payload: entry({ batch: true }) },
      ],
    });

    const summary = await llmUsageLogger.summarize('myproj');

    // Per call: 1000×$5/1M + 500×$25/1M = 0.0175; batch twin = 0.00875
    expect(summary.totals.costUsd).toBeCloseTo(0.0175 + 0.00875, 6);
  });

  it('returns zeroed summary for a project with no usage', async () => {
    const summary = await llmUsageLogger.summarize('emptyproj');

    expect(summary.totals.requests).toBe(0);
    expect(summary.totals.costUsd).toBe(0);
    expect(summary.byModel).toEqual({});
    expect(summary.failures).toBe(0);
  });
});
