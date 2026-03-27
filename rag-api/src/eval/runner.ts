/**
 * Eval Runner - Executes golden queries against the RAG API and computes metrics.
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import {
  PerQueryResult,
  EvalReport,
  recallAtK,
  precisionAtK,
  mrrAtK,
  aggregateMetrics,
  computeLatencyStats,
  metricsByCategory,
} from './metrics';

interface GoldenQuery {
  id: string;
  query: string;
  expectedFiles: string[];
  category: string;
  k: number;
}

interface GoldenDataset {
  projectName: string;
  collection: string;
  apiUrl: string;
  queries: GoldenQuery[];
}

export interface RunOptions {
  project?: string;
  hybrid?: boolean;
  apiUrl?: string;
  goldenPath?: string;
}

export async function runEval(options: RunOptions = {}): Promise<EvalReport> {
  const goldenPath = options.goldenPath || path.join(__dirname, 'golden-queries.json');
  const dataset: GoldenDataset = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

  const projectName = options.project || dataset.projectName;
  const apiUrl = options.apiUrl || dataset.apiUrl;
  const collection = `${projectName}_codebase`;
  const mode = options.hybrid ? 'hybrid' : 'semantic';

  const api: AxiosInstance = axios.create({
    baseURL: apiUrl,
    timeout: 120000,
    headers: {
      'X-Project-Name': projectName,
      'X-API-Key': process.env.RAG_API_KEY || '',
    },
  });

  const endpoint = mode === 'hybrid' ? '/api/search-hybrid' : '/api/search';
  const perQuery: PerQueryResult[] = [];

  console.log(
    `\nRunning eval: ${dataset.queries.length} queries | mode: ${mode} | collection: ${collection}\n`
  );

  for (const gq of dataset.queries) {
    const k = gq.k || 10;
    const start = Date.now();

    try {
      const body: Record<string, unknown> = { collection, query: gq.query, limit: k };
      if (mode === 'hybrid') {
        body.semanticWeight = 0.7;
      }

      const response = await api.post(endpoint, body);
      const latencyMs = Date.now() - start;

      const results: Array<{ file: string; score: number }> = response.data.results || [];
      const resultFiles = results.map((r) => r.file);

      const recall = recallAtK(resultFiles, gq.expectedFiles, k);
      const precision = precisionAtK(resultFiles, gq.expectedFiles, k);
      const mrr = mrrAtK(resultFiles, gq.expectedFiles, k);

      perQuery.push({
        id: gq.id,
        query: gq.query,
        category: gq.category,
        expectedFiles: gq.expectedFiles,
        resultFiles: resultFiles.slice(0, k),
        k,
        recallAtK: recall,
        precisionAtK: precision,
        mrr,
        latencyMs,
      });

      const status = recall >= 1 ? 'PASS' : recall > 0 ? 'PARTIAL' : 'MISS';
      console.log(
        `  [${status}] ${gq.id}: recall=${(recall * 100).toFixed(0)}% mrr=${mrr.toFixed(2)} (${latencyMs}ms)`
      );
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      console.log(`  [ERROR] ${gq.id}: ${error.message}`);
      perQuery.push({
        id: gq.id,
        query: gq.query,
        category: gq.category,
        expectedFiles: gq.expectedFiles,
        resultFiles: [],
        k,
        recallAtK: 0,
        precisionAtK: 0,
        mrr: 0,
        latencyMs,
      });
    }
  }

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    projectName,
    collection,
    mode,
    totalQueries: perQuery.length,
    perQuery,
    aggregate: aggregateMetrics(perQuery),
    byCategory: metricsByCategory(perQuery),
    latency: computeLatencyStats(perQuery),
  };

  // Save report
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const reportPath = path.join(resultsDir, `eval-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  printSummary(report);
  console.log(`\nReport saved: ${reportPath}`);

  return report;
}

function printSummary(report: EvalReport): void {
  console.log('\n' + '='.repeat(60));
  console.log(`EVAL SUMMARY — ${report.mode} mode | ${report.totalQueries} queries`);
  console.log('='.repeat(60));

  const agg = report.aggregate;
  console.log(`  Mean Recall@K:    ${(agg.meanRecallAtK * 100).toFixed(1)}%`);
  console.log(`  Mean Precision@K: ${(agg.meanPrecisionAtK * 100).toFixed(1)}%`);
  console.log(`  Mean MRR:         ${agg.meanMRR.toFixed(3)}`);

  console.log('\nBy Category:');
  for (const [cat, metrics] of Object.entries(report.byCategory)) {
    console.log(
      `  ${cat.padEnd(15)} recall=${(metrics.meanRecallAtK * 100).toFixed(1).padStart(5)}%  mrr=${metrics.meanMRR.toFixed(3)}  (n=${metrics.count})`
    );
  }

  console.log('\nLatency:');
  console.log(
    `  Mean: ${report.latency.mean}ms  P50: ${report.latency.p50}ms  P95: ${report.latency.p95}ms  P99: ${report.latency.p99}ms`
  );
}
