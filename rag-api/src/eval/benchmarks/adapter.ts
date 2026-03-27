/**
 * BenchmarkAdapter — unified base class for RAG retrieval benchmarks.
 *
 * Concrete adapters extend this class and implement:
 *   - name / level   — human-readable identity (e.g. "BEIR/SciFact", "easy")
 *   - prepare()      — download / extract dataset if needed
 *   - loadCases()    — return BenchmarkCase[]
 *   - indexCorpus()  — optional: push corpus documents into a collection,
 *                      returns the number of documents indexed
 *
 * The shared run() method handles query execution, metric computation,
 * aggregation, and report persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosInstance } from 'axios';
import { recallAtK, precisionAtK, mrrAtK, ndcgAtK } from '../metrics';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BenchmarkCase {
  id: string;
  query: string;
  goldDocIds: string[];
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkResult {
  id: string;
  query: string;
  goldDocIds: string[];
  retrievedDocIds: string[];
  recall10: number;
  precision10: number;
  mrr: number;
  ndcg10: number;
  latencyMs: number;
}

export interface BenchmarkReport {
  name: string;
  level: string;
  timestamp: string;
  config: Record<string, unknown>;
  totalCases: number;
  metrics: {
    meanRecall10: number;
    meanPrecision10: number;
    meanMRR: number;
    meanNDCG10: number;
    latencyP50: number;
  };
  perCategory?: Record<string, { meanNDCG10: number; meanRecall10: number; count: number }>;
  results: BenchmarkResult[];
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class BenchmarkAdapter {
  abstract name: string;
  abstract level: string;

  abstract prepare(): Promise<void>;
  abstract loadCases(): Promise<BenchmarkCase[]>;
  indexCorpus?(collection: string): Promise<number>;

  /**
   * Execute the benchmark end-to-end:
   *   1. Load cases
   *   2. POST /api/search for each case, compute per-result metrics
   *   3. Aggregate into BenchmarkReport
   *   4. Persist JSON to src/eval/results/
   */
  async run(apiUrl: string, apiKey: string, collection: string): Promise<BenchmarkReport> {
    const cases = await this.loadCases();

    const api: AxiosInstance = axios.create({
      baseURL: apiUrl,
      timeout: 120_000,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    const K = 10;
    const results: BenchmarkResult[] = [];

    console.log(
      `\nRunning benchmark "${this.name}" [${this.level}] — ${cases.length} cases | collection: ${collection}\n`
    );

    for (const c of cases) {
      const start = Date.now();
      let retrievedDocIds: string[] = [];

      try {
        const response = await api.post('/api/search', {
          collection,
          query: c.query,
          limit: K,
        });
        retrievedDocIds = (response.data.results ?? []).map(
          (r: { file?: string; id?: string; score?: number }) => r.file ?? r.id ?? ''
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [ERROR] ${c.id}: ${msg}`);
      }

      const latencyMs = Date.now() - start;
      const recall10 = recallAtK(retrievedDocIds, c.goldDocIds, K);
      const precision10 = precisionAtK(retrievedDocIds, c.goldDocIds, K);
      const mrr = mrrAtK(retrievedDocIds, c.goldDocIds, K);
      const ndcg10 = ndcgAtK(retrievedDocIds, c.goldDocIds, K);

      results.push({
        id: c.id,
        query: c.query,
        goldDocIds: c.goldDocIds,
        retrievedDocIds,
        recall10,
        precision10,
        mrr,
        ndcg10,
        latencyMs,
      });

      const status = recall10 >= 1 ? 'PASS' : recall10 > 0 ? 'PARTIAL' : 'MISS';
      console.log(
        `  [${status}] ${c.id}: ndcg10=${ndcg10.toFixed(3)} recall=${(recall10 * 100).toFixed(0)}% mrr=${mrr.toFixed(2)} (${latencyMs}ms)`
      );
    }

    const report = buildReport(this.name, this.level, collection, cases, results);
    persistReport(report);
    printReport(report);

    return report;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

function buildReport(
  name: string,
  level: string,
  collection: string,
  cases: BenchmarkCase[],
  results: BenchmarkResult[]
): BenchmarkReport {
  const sortedLatencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  // Build category → result index using the original case order
  const categoryMap = new Map<string, string>();
  for (const c of cases) {
    if (c.category) categoryMap.set(c.id, c.category);
  }

  const categoryGroups: Record<string, BenchmarkResult[]> = {};
  for (const r of results) {
    const cat = categoryMap.get(r.id);
    if (cat) {
      if (!categoryGroups[cat]) categoryGroups[cat] = [];
      categoryGroups[cat].push(r);
    }
  }

  const perCategory: Record<string, { meanNDCG10: number; meanRecall10: number; count: number }> =
    {};
  for (const [cat, group] of Object.entries(categoryGroups)) {
    perCategory[cat] = {
      meanNDCG10: mean(group.map((r) => r.ndcg10)),
      meanRecall10: mean(group.map((r) => r.recall10)),
      count: group.length,
    };
  }

  return {
    name,
    level,
    timestamp: new Date().toISOString(),
    config: { collection },
    totalCases: results.length,
    metrics: {
      meanRecall10: mean(results.map((r) => r.recall10)),
      meanPrecision10: mean(results.map((r) => r.precision10)),
      meanMRR: mean(results.map((r) => r.mrr)),
      meanNDCG10: mean(results.map((r) => r.ndcg10)),
      latencyP50: percentile(sortedLatencies, 0.5),
    },
    perCategory: Object.keys(perCategory).length > 0 ? perCategory : undefined,
    results,
  };
}

function persistReport(report: BenchmarkReport): void {
  const resultsDir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const slug = report.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const reportPath = path.join(resultsDir, `benchmark-${slug}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);
}

function printReport(report: BenchmarkReport): void {
  const m = report.metrics;
  console.log('\n' + '='.repeat(60));
  console.log(`BENCHMARK SUMMARY — ${report.name} [${report.level}] | ${report.totalCases} cases`);
  console.log('='.repeat(60));
  console.log(`  NDCG@10:       ${m.meanNDCG10.toFixed(4)}`);
  console.log(`  Recall@10:     ${(m.meanRecall10 * 100).toFixed(1)}%`);
  console.log(`  Precision@10:  ${(m.meanPrecision10 * 100).toFixed(1)}%`);
  console.log(`  MRR:           ${m.meanMRR.toFixed(4)}`);
  console.log(`  Latency P50:   ${m.latencyP50}ms`);

  if (report.perCategory) {
    console.log('\nBy Category:');
    for (const [cat, cat_m] of Object.entries(report.perCategory)) {
      console.log(
        `  ${cat.padEnd(18)} ndcg10=${cat_m.meanNDCG10.toFixed(3)}  recall=${(cat_m.meanRecall10 * 100).toFixed(1).padStart(5)}%  (n=${cat_m.count})`
      );
    }
  }
}
