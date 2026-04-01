/**
 * Tribunal Eval Runner
 *
 * Runs tribunal debates against eval cases and scores them with LLM-as-judge.
 *
 * Usage:
 *   npx ts-node src/eval/tribunal-eval.ts [--cases=all|arch|code|tech] [--rounds=1]
 *   npx ts-node src/eval/tribunal-eval.ts --cases=arch-01  # single case
 */

import * as fs from 'fs';
import * as path from 'path';
import { EVAL_CASES, TribunalEvalCase } from './tribunal-cases';
import {
  buildJudgeRubricPrompt,
  parseJudgeResponse,
  METRIC_THRESHOLDS,
  EvalScorecard,
} from './tribunal-judge-rubric';
import { tribunalService, TribunalResult } from '../services/tribunal';
import { llm } from '../services/llm';
import { logger } from '../utils/logger';

// ── Interfaces ──────────────────────────────────────────────

interface EvalResult {
  caseId: string;
  category: string;
  topic: string;
  scorecard: EvalScorecard;
  cost: number;
  latencyMs: number;
  converged: boolean;
  verdict: string;
  confidence: string;
  totalTokens: number;
}

interface EvalSummary {
  timestamp: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  avgMetrics: Record<string, number>;
  totalCost: number;
  avgLatencyMs: number;
  convergenceRate: number;
  failedCases: string[];
  results: EvalResult[];
}

// ── CLI Args ────────────────────────────────────────────────

function parseArgs(): { filter: string; rounds: number; projectName: string } {
  const args = process.argv.slice(2);
  let filter = 'all';
  let rounds = 1;
  let projectName = 'eval-test';

  for (const arg of args) {
    if (arg.startsWith('--cases=')) filter = arg.split('=')[1];
    if (arg.startsWith('--rounds=')) rounds = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--project=')) projectName = arg.split('=')[1];
  }

  return { filter, rounds, projectName };
}

function filterCases(filter: string): TribunalEvalCase[] {
  if (filter === 'all') return EVAL_CASES;
  if (filter === 'arch') return EVAL_CASES.filter((c) => c.category === 'architecture');
  if (filter === 'code') return EVAL_CASES.filter((c) => c.category === 'code-approach');
  if (filter === 'tech') return EVAL_CASES.filter((c) => c.category === 'tech-choice');
  if (filter === 'rag') return EVAL_CASES.filter((c) => c.category === 'rag-aware');
  // Single case by ID
  return EVAL_CASES.filter((c) => c.id === filter);
}

// ── Eval Runner ─────────────────────────────────────────────

async function evaluateCase(
  evalCase: TribunalEvalCase,
  projectName: string,
  rounds: number
): Promise<EvalResult> {
  console.log(`\n  Running: ${evalCase.id} — ${evalCase.topic}`);

  // Run the debate
  const useCodeContext = evalCase.useCodeContext ?? false;
  const debateProjectName = evalCase.projectName ?? projectName;

  if (useCodeContext) {
    console.log(`    RAG context: ON (project: ${debateProjectName})`);
  }

  const debateResult: TribunalResult = await tribunalService.debate({
    projectName: debateProjectName,
    topic: evalCase.topic,
    positions: evalCase.positions,
    context: evalCase.context,
    maxRounds: rounds,
    useCodeContext,
    autoRecord: false,
    maxBudget: 1.0, // higher budget for eval
  });

  console.log(
    `    Status: ${debateResult.status} | ${Math.round(debateResult.durationMs / 1000)}s | ~$${debateResult.cost.estimatedUsd.toFixed(3)}`
  );

  // Get verdict text for scoring
  const verdictPhase = debateResult.phases.find((p) => p.name === 'verdict');
  const verdictText = verdictPhase?.content || debateResult.verdict.reasoning;

  // Score with LLM-as-judge
  const rubricPrompt = buildJudgeRubricPrompt({
    topic: evalCase.topic,
    positions: evalCase.positions,
    arguments: debateResult.arguments,
    verdictText,
    knownBestPosition: evalCase.knownBestPosition,
  });

  const judgeResponse = await llm.completeWithBestProvider(rubricPrompt, {
    complexity: 'complex',
    maxTokens: 2048,
    temperature: 0.1,
    think: false,
    format: 'json',
  });

  const scorecard = parseJudgeResponse(evalCase.id, judgeResponse.text);

  console.log(`    Score: ${scorecard.averageScore}/10 | Pass: ${scorecard.pass ? 'YES' : 'NO'}`);
  for (const s of scorecard.scores) {
    const threshold = METRIC_THRESHOLDS[s.metric] || 6;
    const status = s.score >= threshold ? '✓' : '✗';
    console.log(`      ${status} ${s.metric}: ${s.score}/10`);
  }

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    topic: evalCase.topic,
    scorecard,
    cost: debateResult.cost.estimatedUsd,
    latencyMs: debateResult.durationMs,
    converged: debateResult.status === 'completed',
    verdict: debateResult.verdict.recommendation,
    confidence: debateResult.verdict.confidence,
    totalTokens: debateResult.cost.totalTokens,
  };
}

async function runEval(): Promise<void> {
  const { filter, rounds, projectName } = parseArgs();
  const cases = filterCases(filter);

  if (cases.length === 0) {
    console.error(`No cases found for filter: ${filter}`);
    process.exit(1);
  }

  console.log(`\n═══ Tribunal Eval ═══`);
  console.log(`Cases: ${cases.length} | Rounds: ${rounds} | Project: ${projectName}`);
  console.log(`Filter: ${filter}`);

  const results: EvalResult[] = [];

  for (const evalCase of cases) {
    try {
      const result = await evaluateCase(evalCase, projectName, rounds);
      results.push(result);
    } catch (error: any) {
      console.error(`  FAILED: ${evalCase.id} — ${error.message}`);
      results.push({
        caseId: evalCase.id,
        category: evalCase.category,
        topic: evalCase.topic,
        scorecard: {
          caseId: evalCase.id,
          scores: [],
          averageScore: 0,
          pass: false,
          details: error.message,
        },
        cost: 0,
        latencyMs: 0,
        converged: false,
        verdict: '',
        confidence: '',
        totalTokens: 0,
      });
    }
  }

  // ── Summary ─────────────────────────────────────────────

  const passedCases = results.filter((r) => r.scorecard.pass).length;
  const avgMetrics: Record<string, number> = {};
  const metricSums: Record<string, { sum: number; count: number }> = {};

  for (const r of results) {
    for (const s of r.scorecard.scores) {
      if (!metricSums[s.metric]) metricSums[s.metric] = { sum: 0, count: 0 };
      metricSums[s.metric].sum += s.score;
      metricSums[s.metric].count++;
    }
  }

  for (const [metric, data] of Object.entries(metricSums)) {
    avgMetrics[metric] = Math.round((data.sum / data.count) * 100) / 100;
  }

  const summary: EvalSummary = {
    timestamp: new Date().toISOString(),
    totalCases: cases.length,
    passedCases,
    passRate: Math.round((passedCases / cases.length) * 100),
    avgMetrics,
    totalCost: results.reduce((s, r) => s + r.cost, 0),
    avgLatencyMs: Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length),
    convergenceRate: Math.round((results.filter((r) => r.converged).length / results.length) * 100),
    failedCases: results.filter((r) => !r.scorecard.pass).map((r) => r.caseId),
    results,
  };

  // Print summary
  console.log(`\n═══ Results ═══`);
  console.log(`Pass rate: ${summary.passRate}% (${passedCases}/${cases.length})`);
  console.log(`Total cost: $${summary.totalCost.toFixed(3)}`);
  console.log(`Avg latency: ${Math.round(summary.avgLatencyMs / 1000)}s`);
  console.log(`Convergence: ${summary.convergenceRate}%`);
  console.log(`\nAvg Metrics:`);
  for (const [metric, avg] of Object.entries(avgMetrics)) {
    const threshold = METRIC_THRESHOLDS[metric] || 6;
    const status = avg >= threshold ? '✓' : '✗';
    console.log(`  ${status} ${metric}: ${avg}/10 (threshold: ${threshold})`);
  }

  if (summary.failedCases.length > 0) {
    console.log(`\nFailed cases: ${summary.failedCases.join(', ')}`);
  }

  // Save results
  const outPath = path.join(__dirname, 'results', `eval-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nResults saved: ${outPath}`);
}

// ── Entry Point ─────────────────────────────────────────────

runEval().catch((error) => {
  console.error('Eval failed:', error);
  process.exit(1);
});
