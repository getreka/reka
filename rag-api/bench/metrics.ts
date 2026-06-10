/**
 * Pure metric functions for the Reka code-QA / retrieval benchmark.
 *
 * These have NO network or filesystem dependencies, so they can be unit-tested
 * in isolation (see metrics.test.ts) and reused by the runner.
 *
 * Path matching is intentionally suffix-based: the benchmark dataset stores
 * repo-relative paths (e.g. "rag-api/src/middleware/rate-limit.ts") while the
 * RAG API may return project-relative or absolute paths. A retrieved file is
 * considered a match for an expected file if either path ends with the other
 * (after normalising separators). This avoids false negatives from differing
 * path roots while still requiring the meaningful tail to line up.
 */

/** Normalise a path for comparison: backslashes -> slashes, strip leading "./". */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * True if a retrieved path matches an expected (repo-relative) path.
 * Match = one normalised path ends with the other on a path-segment boundary.
 */
export function pathMatches(retrieved: string, expected: string): boolean {
  const r = normalizePath(retrieved);
  const e = normalizePath(expected);
  if (r === e) return true;
  // Boundary-aware suffix match in either direction so the longer path may be
  // either the retrieved one (repo-relative dataset) or the expected one.
  return endsWithOnBoundary(r, e) || endsWithOnBoundary(e, r);
}

function endsWithOnBoundary(longer: string, suffix: string): boolean {
  if (!longer.endsWith(suffix)) return false;
  if (longer.length === suffix.length) return true;
  // The character immediately before the suffix must be a path separator,
  // so "src/rate-limit.ts" matches "rate-limit.ts" but "my-rate-limit.ts" does not.
  return longer[longer.length - suffix.length - 1] === '/';
}

/**
 * recall@k: fraction of EXPECTED files that appear anywhere in the top-k
 * retrieved files. 1.0 means every expected file surfaced.
 * Returns null when there are no expected files (metric undefined).
 */
export function recallAtK(retrieved: string[], expected: string[], k: number): number | null {
  if (expected.length === 0) return null;
  const topK = retrieved.slice(0, k);
  const found = expected.filter((e) => topK.some((r) => pathMatches(r, e)));
  return found.length / expected.length;
}

/**
 * Mean Reciprocal Rank for a single query: 1 / (rank of the first retrieved
 * file that matches ANY expected file). Rank is 1-based. Returns 0 if no
 * expected file is found in the retrieved list, and null if no expected files
 * were provided (metric undefined for this item).
 */
export function reciprocalRank(retrieved: string[], expected: string[]): number | null {
  if (expected.length === 0) return null;
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.some((e) => pathMatches(retrieved[i], e))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * answer-contains rate for one item: fraction of the expected substrings that
 * are present (case-insensitive) in the produced answer. Returns null when no
 * expected substrings were provided.
 */
export function answerContainsRate(answer: string, expectedContains: string[]): number | null {
  if (expectedContains.length === 0) return null;
  const hay = answer.toLowerCase();
  const hits = expectedContains.filter((s) => hay.includes(s.toLowerCase()));
  return hits.length / expectedContains.length;
}

/**
 * Rough token estimate (~4 chars/token, the OpenAI/Anthropic rule of thumb).
 * Used only when the API response carries no usage metadata. Whitespace-collapsed
 * so indentation-heavy code is not over-counted.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return Math.ceil(collapsed.length / 4);
}

/**
 * Pull a token count out of a heterogeneous API response. Looks at the common
 * shapes Reka / the underlying LLM providers emit; returns null if none found
 * (the caller then falls back to estimateTokens over the text).
 */
export function extractTokens(resp: unknown): number | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as Record<string, any>;
  const candidates: Array<number | undefined> = [
    r.tokens,
    r.totalTokens,
    r.tokenCount,
    r.usage?.total_tokens,
    r.usage?.totalTokens,
    r.usage
      ? (r.usage.input_tokens ?? r.usage.prompt_tokens ?? 0) +
        (r.usage.output_tokens ?? r.usage.completion_tokens ?? 0)
      : undefined,
    r.metadata?.tokens,
    r.metadata?.usage?.total_tokens,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return c;
  }
  return null;
}

/** Average of the non-null values, or null if there are none. */
export function meanOf(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/** Format a metric for display: "n/a" for null, else fixed-precision. */
export function fmt(v: number | null, digits = 3): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}
