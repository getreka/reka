/**
 * Eval Metrics - Pure functions for computing retrieval quality metrics.
 */

export interface PerQueryResult {
  id: string;
  query: string;
  category: string;
  expectedFiles: string[];
  resultFiles: string[];
  k: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  latencyMs: number;
}

export interface EvalReport {
  timestamp: string;
  projectName: string;
  collection: string;
  mode: 'semantic' | 'hybrid';
  totalQueries: number;
  perQuery: PerQueryResult[];
  aggregate: AggregateMetrics;
  byCategory: Record<string, AggregateMetrics>;
  latency: LatencyStats;
}

export interface AggregateMetrics {
  meanRecallAtK: number;
  meanPrecisionAtK: number;
  meanMRR: number;
  count: number;
}

export interface LatencyStats {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Recall@K: fraction of expected files found in top-K results.
 */
export function recallAtK(resultFiles: string[], expectedFiles: string[], k: number): number {
  if (expectedFiles.length === 0) return 1;
  const topK = resultFiles.slice(0, k);
  const found = expectedFiles.filter((f) =>
    topK.some((r) => r.endsWith(f) || f.endsWith(r) || r === f)
  );
  return found.length / expectedFiles.length;
}

/**
 * Precision@K: fraction of top-K results that are expected.
 */
export function precisionAtK(resultFiles: string[], expectedFiles: string[], k: number): number {
  const topK = resultFiles.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter((r) =>
    expectedFiles.some((f) => r.endsWith(f) || f.endsWith(r) || r === f)
  );
  return relevant.length / topK.length;
}

/**
 * MRR (Mean Reciprocal Rank): 1/rank of first relevant result.
 */
export function mrrAtK(resultFiles: string[], expectedFiles: string[], k: number): number {
  const topK = resultFiles.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (expectedFiles.some((f) => topK[i].endsWith(f) || f.endsWith(topK[i]) || topK[i] === f)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * NDCG@K (Normalized Discounted Cumulative Gain) with binary relevance.
 *
 * Binary relevance: a result is relevant (gain=1) if it matches any of the
 * expected IDs via the same suffix/prefix match used by the other metrics,
 * irrelevant (gain=0) otherwise.
 *
 * DCG@K  = sum_{i=1}^{K} gain_i / log2(i + 1)
 * IDCG@K = DCG of the ideal ranking (all relevant docs first)
 * NDCG@K = DCG@K / IDCG@K  (returns 1 when IDCG=0, matching recall behaviour)
 */
export function ndcgAtK(resultFiles: string[], expectedFiles: string[], k: number): number {
  if (expectedFiles.length === 0) return 1;

  const topK = resultFiles.slice(0, k);

  const gains: number[] = topK.map((r) =>
    expectedFiles.some((f) => r.endsWith(f) || f.endsWith(r) || r === f) ? 1 : 0
  );

  const dcg = gains.reduce((acc, g, i) => acc + g / Math.log2(i + 2), 0);

  const relevantCount = Math.min(expectedFiles.length, k);
  const idcg = Array.from({ length: relevantCount }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a, b) => a + b,
    0
  );

  if (idcg === 0) return 1;
  return dcg / idcg;
}

/**
 * Aggregate per-query results into mean metrics.
 */
export function aggregateMetrics(results: PerQueryResult[]): AggregateMetrics {
  if (results.length === 0) {
    return { meanRecallAtK: 0, meanPrecisionAtK: 0, meanMRR: 0, count: 0 };
  }
  const sum = results.reduce(
    (acc, r) => ({
      recall: acc.recall + r.recallAtK,
      precision: acc.precision + r.precisionAtK,
      mrr: acc.mrr + r.mrr,
    }),
    { recall: 0, precision: 0, mrr: 0 }
  );
  return {
    meanRecallAtK: sum.recall / results.length,
    meanPrecisionAtK: sum.precision / results.length,
    meanMRR: sum.mrr / results.length,
    count: results.length,
  };
}

/**
 * Compute latency statistics from per-query results.
 */
export function computeLatencyStats(results: PerQueryResult[]): LatencyStats {
  if (results.length === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return {
    mean: Math.round(mean),
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
    p99: latencies[Math.floor(latencies.length * 0.99)],
  };
}

/**
 * Group results by category and compute per-category metrics.
 */
export function metricsByCategory(results: PerQueryResult[]): Record<string, AggregateMetrics> {
  const groups: Record<string, PerQueryResult[]> = {};
  for (const r of results) {
    if (!groups[r.category]) groups[r.category] = [];
    groups[r.category].push(r);
  }
  const byCategory: Record<string, AggregateMetrics> = {};
  for (const [cat, items] of Object.entries(groups)) {
    byCategory[cat] = aggregateMetrics(items);
  }
  return byCategory;
}
