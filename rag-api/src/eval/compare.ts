/**
 * Eval Compare - Load two eval reports and compute deltas.
 */

import * as fs from 'fs';
import type { EvalReport, PerQueryResult } from './metrics';

export interface CompareResult {
  before: string;
  after: string;
  deltaRecall: number;
  deltaPrecision: number;
  deltaMRR: number;
  deltaLatency: number;
  byCategory: Record<string, { deltaRecall: number; deltaMRR: number }>;
  improved: string[];
  degraded: string[];
}

export function compareReports(beforePath: string, afterPath: string): CompareResult {
  const before: EvalReport = JSON.parse(fs.readFileSync(beforePath, 'utf-8'));
  const after: EvalReport = JSON.parse(fs.readFileSync(afterPath, 'utf-8'));

  const deltaRecall = after.aggregate.meanRecallAtK - before.aggregate.meanRecallAtK;
  const deltaPrecision = after.aggregate.meanPrecisionAtK - before.aggregate.meanPrecisionAtK;
  const deltaMRR = after.aggregate.meanMRR - before.aggregate.meanMRR;
  const deltaLatency = after.latency.mean - before.latency.mean;

  // Per-category deltas
  const allCategories = new Set([
    ...Object.keys(before.byCategory),
    ...Object.keys(after.byCategory),
  ]);
  const byCategory: Record<string, { deltaRecall: number; deltaMRR: number }> = {};
  for (const cat of allCategories) {
    const b = before.byCategory[cat];
    const a = after.byCategory[cat];
    byCategory[cat] = {
      deltaRecall: (a?.meanRecallAtK || 0) - (b?.meanRecallAtK || 0),
      deltaMRR: (a?.meanMRR || 0) - (b?.meanMRR || 0),
    };
  }

  // Per-query comparison
  const beforeMap = new Map<string, PerQueryResult>();
  for (const q of before.perQuery) beforeMap.set(q.id, q);

  const improved: string[] = [];
  const degraded: string[] = [];

  for (const q of after.perQuery) {
    const bq = beforeMap.get(q.id);
    if (!bq) continue;
    const recallDelta = q.recallAtK - bq.recallAtK;
    if (recallDelta > 0.01) improved.push(q.id);
    else if (recallDelta < -0.01) degraded.push(q.id);
  }

  const result: CompareResult = {
    before: beforePath,
    after: afterPath,
    deltaRecall,
    deltaPrecision,
    deltaMRR,
    deltaLatency,
    byCategory,
    improved,
    degraded,
  };

  printCompare(result);
  return result;
}

function printCompare(result: CompareResult): void {
  const sign = (n: number) => (n >= 0 ? '+' : '');

  console.log('\n' + '='.repeat(60));
  console.log('EVAL COMPARISON');
  console.log('='.repeat(60));
  console.log(`  Before: ${result.before}`);
  console.log(`  After:  ${result.after}`);
  console.log('');
  console.log(
    `  Recall@K:    ${sign(result.deltaRecall)}${(result.deltaRecall * 100).toFixed(1)}%`
  );
  console.log(
    `  Precision@K: ${sign(result.deltaPrecision)}${(result.deltaPrecision * 100).toFixed(1)}%`
  );
  console.log(`  MRR:         ${sign(result.deltaMRR)}${result.deltaMRR.toFixed(3)}`);
  console.log(`  Latency:     ${sign(result.deltaLatency)}${result.deltaLatency}ms`);

  console.log('\nBy Category:');
  for (const [cat, delta] of Object.entries(result.byCategory)) {
    console.log(
      `  ${cat.padEnd(15)} recall: ${sign(delta.deltaRecall)}${(delta.deltaRecall * 100).toFixed(1)}%  mrr: ${sign(delta.deltaMRR)}${delta.deltaMRR.toFixed(3)}`
    );
  }

  if (result.improved.length > 0) {
    console.log(`\nImproved (${result.improved.length}): ${result.improved.join(', ')}`);
  }
  if (result.degraded.length > 0) {
    console.log(`\nDegraded (${result.degraded.length}): ${result.degraded.join(', ')}`);
  }
}
