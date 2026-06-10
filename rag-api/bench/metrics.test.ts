/**
 * Unit tests for the benchmark metric functions.
 *
 * These use hand-made inputs only (no network, no server). They are deliberately
 * placed under bench/ which is OUTSIDE the main vitest `include` glob
 * (src/**\/*.test.ts), so they do NOT run as part of — and cannot break — the
 * main rag-api suite. Run them explicitly:
 *
 *   cd rag-api && npx vitest run bench/metrics.test.ts
 *   # or, with no extra config:
 *   npx tsx --test bench/metrics.test.ts   (after `npm i -D tsx` if desired)
 *
 * The file uses vitest's globals (describe/it/expect) which are available when
 * invoked through vitest.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  pathMatches,
  recallAtK,
  reciprocalRank,
  answerContainsRate,
  estimateTokens,
  extractTokens,
  meanOf,
} from './metrics';

describe('normalizePath', () => {
  it('converts backslashes and strips ./ and leading slashes', () => {
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizePath('/abs/src/a.ts')).toBe('abs/src/a.ts');
    expect(normalizePath('./a.ts')).toBe('a.ts');
  });
});

describe('pathMatches', () => {
  it('matches identical paths', () => {
    expect(pathMatches('src/a.ts', 'src/a.ts')).toBe(true);
  });
  it('matches on a path-segment boundary suffix', () => {
    expect(
      pathMatches(
        '/repo/rag-api/src/middleware/rate-limit.ts',
        'rag-api/src/middleware/rate-limit.ts'
      )
    ).toBe(true);
    expect(pathMatches('rag-api/src/middleware/rate-limit.ts', 'rate-limit.ts')).toBe(true);
  });
  it('does NOT match a partial filename (no boundary)', () => {
    expect(pathMatches('src/my-rate-limit.ts', 'rate-limit.ts')).toBe(false);
  });
  it('does not match unrelated files', () => {
    expect(pathMatches('src/auth.ts', 'src/rate-limit.ts')).toBe(false);
  });
});

describe('recallAtK', () => {
  it('is 1.0 when all expected files are in top-k', () => {
    const retrieved = ['x/a.ts', 'x/b.ts', 'x/c.ts'];
    expect(recallAtK(retrieved, ['a.ts', 'b.ts'], 5)).toBe(1);
  });
  it('is a fraction when only some expected files surface', () => {
    const retrieved = ['x/a.ts', 'x/z.ts'];
    expect(recallAtK(retrieved, ['a.ts', 'b.ts'], 5)).toBe(0.5);
  });
  it('honours the k cutoff', () => {
    const retrieved = ['x/z.ts', 'x/y.ts', 'x/a.ts'];
    // a.ts is at rank 3, so recall@2 misses it.
    expect(recallAtK(retrieved, ['a.ts'], 2)).toBe(0);
    expect(recallAtK(retrieved, ['a.ts'], 3)).toBe(1);
  });
  it('returns null when there are no expected files', () => {
    expect(recallAtK(['a.ts'], [], 5)).toBeNull();
  });
});

describe('reciprocalRank', () => {
  it('is 1 when the first result matches', () => {
    expect(reciprocalRank(['x/a.ts', 'x/b.ts'], ['a.ts'])).toBe(1);
  });
  it('is 1/2 when the second result matches', () => {
    expect(reciprocalRank(['x/z.ts', 'x/a.ts'], ['a.ts'])).toBe(0.5);
  });
  it('is 1/3 when the third result matches', () => {
    expect(reciprocalRank(['z.ts', 'y.ts', 'a.ts'], ['a.ts'])).toBeCloseTo(1 / 3, 6);
  });
  it('is 0 when no result matches', () => {
    expect(reciprocalRank(['z.ts', 'y.ts'], ['a.ts'])).toBe(0);
  });
  it('returns null when there are no expected files', () => {
    expect(reciprocalRank(['a.ts'], [])).toBeNull();
  });
});

describe('answerContainsRate', () => {
  it('is 1.0 when all substrings present (case-insensitive)', () => {
    expect(answerContainsRate('The Sliding Window rate limiter', ['sliding window', 'rate'])).toBe(
      1
    );
  });
  it('is a fraction when some substrings are missing', () => {
    expect(answerContainsRate('rate limiter', ['rate', 'qdrant'])).toBe(0.5);
  });
  it('is 0 when none are present', () => {
    expect(answerContainsRate('hello world', ['rate', 'qdrant'])).toBe(0);
  });
  it('returns null when no expected substrings provided', () => {
    expect(answerContainsRate('anything', [])).toBeNull();
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token over collapsed whitespace', () => {
    // "abcd efgh" -> collapsed length 9 -> ceil(9/4) = 3
    expect(estimateTokens('abcd efgh')).toBe(3);
  });
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('extractTokens', () => {
  it('reads a top-level tokens field', () => {
    expect(extractTokens({ tokens: 123 })).toBe(123);
  });
  it('sums anthropic-style usage', () => {
    expect(extractTokens({ usage: { input_tokens: 100, output_tokens: 50 } })).toBe(150);
  });
  it('sums openai-style usage', () => {
    expect(extractTokens({ usage: { prompt_tokens: 30, completion_tokens: 20 } })).toBe(50);
  });
  it('returns null when no usage info present', () => {
    expect(extractTokens({ answer: 'hi' })).toBeNull();
    expect(extractTokens(null)).toBeNull();
  });
});

describe('meanOf', () => {
  it('averages non-null values and ignores nulls', () => {
    expect(meanOf([1, null, 3])).toBe(2);
  });
  it('returns null when everything is null', () => {
    expect(meanOf([null, null])).toBeNull();
  });
});
