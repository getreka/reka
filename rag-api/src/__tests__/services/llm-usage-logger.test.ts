import { describe, it, expect } from 'vitest';

// Keep the Qdrant client out of the module graph — modelCostUsd is pure and never
// touches it, but importing llm-usage-logger pulls vector-store in transitively.
import { vi } from 'vitest';
vi.mock('../../services/vector-store', () => ({
  vectorStore: { ensureCollection: vi.fn(), upsert: vi.fn() },
}));

import { modelCostUsd } from '../../services/llm-usage-logger';

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
