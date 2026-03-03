/**
 * Eval Reporter - Generate reports from eval runs.
 */

import fs from 'fs';
import path from 'path';
import { EvalRun } from './runner';

export class EvalReporter {
  constructor(private resultsDir: string = path.join(__dirname, 'results')) {
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  /**
   * Save eval run to JSON file and print console report.
   */
  report(run: EvalRun, label?: string): string {
    const filename = `eval_${label || run.model.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
    const filepath = path.join(this.resultsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(run, null, 2));

    this.printConsoleReport(run, label);
    return filepath;
  }

  /**
   * Print human-readable report to console.
   */
  printConsoleReport(run: EvalRun, label?: string): void {
    const { summary, results } = run;

    console.log('\n' + '='.repeat(60));
    console.log(`EVAL REPORT${label ? `: ${label}` : ''}`);
    console.log(`Model: ${run.model}`);
    console.log(`Time: ${run.timestamp}`);
    console.log('='.repeat(60));

    console.log(`\nResults: ${summary.passed}/${summary.total} passed (${summary.failed} failed)`);
    console.log(`Avg Latency: ${summary.avgLatencyMs}ms`);
    console.log(`JSON Parse Rate: ${(summary.jsonParseRate * 100).toFixed(1)}%`);
    console.log(`Thinking Rate: ${(summary.thinkingRate * 100).toFixed(1)}%`);

    // Show failed cases
    const failed = results.filter(r => !r.passed);
    if (failed.length > 0) {
      console.log('\n--- FAILURES ---');
      for (const f of failed) {
        console.log(`\n  ${f.caseId} (${f.endpoint}) [${f.latencyMs}ms]`);
        if (f.error) {
          console.log(`    Error: ${f.error}`);
        }
        for (const a of f.assertions.filter(a => !a.passed)) {
          console.log(`    FAIL: ${a.type} — ${a.detail}`);
        }
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');
  }

  /**
   * Compare two eval runs side by side.
   */
  compareRuns(runA: EvalRun, runB: EvalRun): void {
    console.log('\n' + '='.repeat(70));
    console.log('A/B COMPARISON REPORT');
    console.log('='.repeat(70));

    console.log(`\n  Model A: ${runA.model}`);
    console.log(`  Model B: ${runB.model}`);

    console.log('\n  Metric                  Model A       Model B       Delta');
    console.log('  ' + '-'.repeat(66));

    const metrics: Array<[string, number, number]> = [
      ['Pass Rate (%)', (runA.summary.passed / runA.summary.total) * 100, (runB.summary.passed / runB.summary.total) * 100],
      ['Avg Latency (ms)', runA.summary.avgLatencyMs, runB.summary.avgLatencyMs],
      ['JSON Parse Rate (%)', runA.summary.jsonParseRate * 100, runB.summary.jsonParseRate * 100],
      ['Thinking Rate (%)', runA.summary.thinkingRate * 100, runB.summary.thinkingRate * 100],
    ];

    for (const [name, a, b] of metrics) {
      const delta = b - a;
      const sign = delta > 0 ? '+' : '';
      console.log(`  ${name.padEnd(24)}${a.toFixed(1).padStart(10)}  ${b.toFixed(1).padStart(12)}  ${(sign + delta.toFixed(1)).padStart(10)}`);
    }

    // Per-case comparison
    console.log('\n  Per-case results:');
    const casesA = new Map(runA.results.map(r => [r.caseId, r]));
    const casesB = new Map(runB.results.map(r => [r.caseId, r]));

    const allCases = new Set([...casesA.keys(), ...casesB.keys()]);
    for (const caseId of allCases) {
      const a = casesA.get(caseId);
      const b = casesB.get(caseId);
      const statusA = a ? (a.passed ? 'PASS' : 'FAIL') : 'N/A';
      const statusB = b ? (b.passed ? 'PASS' : 'FAIL') : 'N/A';
      const latA = a ? `${a.latencyMs}ms` : '-';
      const latB = b ? `${b.latencyMs}ms` : '-';

      const changed = statusA !== statusB ? ' <<<' : '';
      console.log(`    ${caseId.padEnd(20)} ${statusA.padEnd(6)} ${latA.padStart(8)}  |  ${statusB.padEnd(6)} ${latB.padStart(8)}${changed}`);
    }

    console.log('\n' + '='.repeat(70) + '\n');
  }
}
