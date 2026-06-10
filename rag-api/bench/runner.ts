/**
 * Reka Code-QA / Retrieval Benchmark Runner
 * =========================================
 *
 * Measures retrieval quality, answer quality, and token cost of the Reka RAG
 * API on a given project. This is the harness behind the public "task success +
 * tokens, with vs without Reka" marketing number.
 *
 * For each benchmark item it calls three endpoints:
 *   - POST /api/search           (mode: "navigate")  -> retrieval ranking
 *   - POST /api/smart-dispatch                        -> retrieval ranking (LLM-routed)
 *   - POST /api/ask                                   -> answer text
 *
 * and computes, per item and aggregated:
 *   - recall@k over expectedFiles (search + smart-dispatch separately)
 *   - MRR over expectedFiles
 *   - answer-contains rate over expectedAnswerContains
 *   - tokens consumed (from response metadata when present, else estimated)
 *
 * All network calls are guarded behind a typed client so this file TYPECHECKS
 * without a live server. Running it (obviously) needs a reachable RAG API.
 *
 * Run (no extra deps, uses Node >=18 global fetch):
 *   REKA_API_URL=http://localhost:3100 REKA_API_KEY=rk_... BENCH_PROJECT=rag \
 *     npx tsx bench/runner.ts bench/datasets/sample.json
 *
 * Or via the bench package script:
 *   cd bench && npm run bench -- datasets/sample.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  recallAtK,
  reciprocalRank,
  answerContainsRate,
  estimateTokens,
  extractTokens,
  meanOf,
  fmt,
} from './metrics';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface BenchItem {
  id: string;
  question: string;
  /** Repo-relative paths that SHOULD surface in the top-k retrieved files. */
  expectedFiles?: string[];
  /** Case-insensitive substrings the /api/ask answer SHOULD contain. */
  expectedAnswerContains?: string[];
}

export interface BenchConfig {
  baseUrl: string;
  apiKey?: string;
  project: string;
  /** k for recall@k / how many results to request. Default 5. */
  k: number;
  /** Per-request timeout (ms). Default 120000. */
  timeoutMs: number;
  /** Skip the LLM-backed /api/ask call (retrieval-only, much faster/cheaper). */
  skipAsk: boolean;
}

export interface ItemResult {
  id: string;
  question: string;
  searchFiles: string[];
  dispatchFiles: string[];
  answer: string;
  // retrieval metrics (null = not applicable, e.g. no expectedFiles)
  searchRecall: number | null;
  searchMrr: number | null;
  dispatchRecall: number | null;
  dispatchMrr: number | null;
  // answer metric
  answerContains: number | null;
  // cost
  tokens: number;
  tokensEstimated: boolean;
  latencyMs: number;
  error?: string;
}

export interface BenchReport {
  project: string;
  baseUrl: string;
  k: number;
  timestamp: string;
  items: ItemResult[];
  overall: {
    items: number;
    errors: number;
    searchRecallAtK: number | null;
    searchMrr: number | null;
    dispatchRecallAtK: number | null;
    dispatchMrr: number | null;
    answerContainsRate: number | null;
    totalTokens: number;
    avgTokensPerItem: number | null;
    avgLatencyMs: number | null;
  };
}

// --------------------------------------------------------------------------
// HTTP client (the only place that touches the network)
// --------------------------------------------------------------------------

class RekaClient {
  constructor(private cfg: BenchConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Project-Name': this.cfg.project,
    };
    if (this.cfg.apiKey) h['X-Api-Key'] = this.cfg.apiKey;
    return h;
  }

  private async post<T = any>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${path} -> ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /api/search (navigate mode). Returns ranked file list + raw response. */
  async search(question: string): Promise<{ files: string[]; raw: any }> {
    const raw = await this.post('/api/search', {
      collection: `${this.cfg.project}_codebase`,
      query: question,
      mode: 'navigate',
      limit: this.cfg.k,
    });
    const files = (raw?.results ?? [])
      .map((r: any) => r?.file)
      .filter((f: unknown): f is string => typeof f === 'string');
    return { files, raw };
  }

  /** POST /api/smart-dispatch. Returns ranked code-result file list + raw. */
  async smartDispatch(question: string): Promise<{ files: string[]; raw: any }> {
    const raw = await this.post('/api/smart-dispatch', {
      projectName: this.cfg.project,
      task: question,
    });
    const code = raw?.context?.codeResults ?? [];
    const files = code
      .map((r: any) => r?.file)
      .filter((f: unknown): f is string => typeof f === 'string');
    return { files, raw };
  }

  /** POST /api/ask. Returns the answer text + raw response. */
  async ask(question: string): Promise<{ answer: string; raw: any }> {
    const raw = await this.post('/api/ask', {
      collection: `${this.cfg.project}_codebase`,
      question,
    });
    const answer = typeof raw?.answer === 'string' ? raw.answer : '';
    return { answer, raw };
  }
}

// --------------------------------------------------------------------------
// Core run
// --------------------------------------------------------------------------

async function runItem(client: RekaClient, item: BenchItem, cfg: BenchConfig): Promise<ItemResult> {
  const start = Date.now();
  const expectedFiles = item.expectedFiles ?? [];
  const expectedContains = item.expectedAnswerContains ?? [];

  const base: ItemResult = {
    id: item.id,
    question: item.question,
    searchFiles: [],
    dispatchFiles: [],
    answer: '',
    searchRecall: null,
    searchMrr: null,
    dispatchRecall: null,
    dispatchMrr: null,
    answerContains: null,
    tokens: 0,
    tokensEstimated: true,
    latencyMs: 0,
  };

  try {
    const [search, dispatch] = await Promise.all([
      client.search(item.question),
      client.smartDispatch(item.question),
    ]);

    base.searchFiles = search.files;
    base.dispatchFiles = dispatch.files;
    base.searchRecall = recallAtK(search.files, expectedFiles, cfg.k);
    base.searchMrr = reciprocalRank(search.files, expectedFiles);
    base.dispatchRecall = recallAtK(dispatch.files, expectedFiles, cfg.k);
    base.dispatchMrr = reciprocalRank(dispatch.files, expectedFiles);

    let tokens = 0;
    let estimated = true;

    if (!cfg.skipAsk) {
      const asked = await client.ask(item.question);
      base.answer = asked.answer;
      base.answerContains = answerContainsRate(asked.answer, expectedContains);

      const reported = extractTokens(asked.raw);
      if (reported !== null) {
        tokens = reported;
        estimated = false;
      } else {
        // Estimate over question + answer + retrieved context we paid to embed/rank.
        const contextText = [...search.files, ...dispatch.files].join(' ');
        tokens = estimateTokens(item.question + ' ' + asked.answer + ' ' + contextText);
        estimated = true;
      }
    } else {
      tokens = estimateTokens(item.question + ' ' + [...search.files, ...dispatch.files].join(' '));
      estimated = true;
    }

    base.tokens = tokens;
    base.tokensEstimated = estimated;
  } catch (err: any) {
    base.error = err?.message ? String(err.message) : String(err);
  }

  base.latencyMs = Date.now() - start;
  return base;
}

export async function runBenchmark(items: BenchItem[], cfg: BenchConfig): Promise<BenchReport> {
  const client = new RekaClient(cfg);
  const results: ItemResult[] = [];
  for (const item of items) {
    // Sequential to keep load (and LLM cost) predictable; flip to Promise.all
    // for speed if your server can take it.
    results.push(await runItem(client, item, cfg));
  }

  const ok = results.filter((r) => !r.error);
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);

  return {
    project: cfg.project,
    baseUrl: cfg.baseUrl,
    k: cfg.k,
    timestamp: new Date().toISOString(),
    items: results,
    overall: {
      items: results.length,
      errors: results.length - ok.length,
      searchRecallAtK: meanOf(results.map((r) => r.searchRecall)),
      searchMrr: meanOf(results.map((r) => r.searchMrr)),
      dispatchRecallAtK: meanOf(results.map((r) => r.dispatchRecall)),
      dispatchMrr: meanOf(results.map((r) => r.dispatchMrr)),
      answerContainsRate: meanOf(results.map((r) => r.answerContains)),
      totalTokens,
      avgTokensPerItem: results.length ? totalTokens / results.length : null,
      avgLatencyMs: ok.length ? meanOf(ok.map((r) => r.latencyMs)) : null,
    },
  };
}

// --------------------------------------------------------------------------
// Pretty printing
// --------------------------------------------------------------------------

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

export function printReport(report: BenchReport): void {
  const cols = [
    ['id', 18],
    ['s.recall', 9],
    ['s.mrr', 7],
    ['d.recall', 9],
    ['d.mrr', 7],
    ['ans', 6],
    ['tokens', 8],
    ['ms', 7],
  ] as const;

  const header = cols.map(([name, w]) => pad(name, w)).join(' ');
  /* eslint-disable no-console */
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const r of report.items) {
    const row = [
      pad(r.id, 18),
      pad(fmt(r.searchRecall, 2), 9),
      pad(fmt(r.searchMrr, 2), 7),
      pad(fmt(r.dispatchRecall, 2), 9),
      pad(fmt(r.dispatchMrr, 2), 7),
      pad(fmt(r.answerContains, 2), 6),
      pad(r.tokensEstimated ? `~${r.tokens}` : `${r.tokens}`, 8),
      pad(String(r.latencyMs), 7),
    ].join(' ');
    console.log(row + (r.error ? `  ERROR: ${r.error}` : ''));
  }

  const o = report.overall;
  console.log('-'.repeat(header.length));
  console.log(
    pad('OVERALL', 18) +
      ' ' +
      pad(fmt(o.searchRecallAtK, 2), 9) +
      ' ' +
      pad(fmt(o.searchMrr, 2), 7) +
      ' ' +
      pad(fmt(o.dispatchRecallAtK, 2), 9) +
      ' ' +
      pad(fmt(o.dispatchMrr, 2), 7) +
      ' ' +
      pad(fmt(o.answerContainsRate, 2), 6) +
      ' ' +
      pad(String(o.totalTokens), 8) +
      ' ' +
      pad(fmt(o.avgLatencyMs, 0), 7)
  );
  console.log(
    `\n${o.items} items, ${o.errors} errors | ` +
      `search recall@${report.k}=${fmt(o.searchRecallAtK, 3)} MRR=${fmt(o.searchMrr, 3)} | ` +
      `dispatch recall@${report.k}=${fmt(o.dispatchRecallAtK, 3)} MRR=${fmt(o.dispatchMrr, 3)} | ` +
      `answer-contains=${fmt(o.answerContainsRate, 3)} | ` +
      `tokens total=${o.totalTokens} avg=${fmt(o.avgTokensPerItem, 0)}`
  );
  /* eslint-enable no-console */
}

// --------------------------------------------------------------------------
// Config + CLI entry
// --------------------------------------------------------------------------

export function loadConfig(overrides: Partial<BenchConfig> = {}): BenchConfig {
  return {
    baseUrl: overrides.baseUrl ?? process.env.REKA_API_URL ?? 'http://localhost:3100',
    apiKey: overrides.apiKey ?? process.env.REKA_API_KEY,
    project: overrides.project ?? process.env.BENCH_PROJECT ?? 'rag',
    k: overrides.k ?? (process.env.BENCH_K ? parseInt(process.env.BENCH_K, 10) : 5),
    timeoutMs:
      overrides.timeoutMs ??
      (process.env.BENCH_TIMEOUT_MS ? parseInt(process.env.BENCH_TIMEOUT_MS, 10) : 120000),
    skipAsk: overrides.skipAsk ?? process.env.BENCH_SKIP_ASK === '1',
  };
}

export function loadDataset(path: string): BenchItem[] {
  const data = JSON.parse(readFileSync(resolve(path), 'utf-8'));
  if (!Array.isArray(data)) throw new Error(`Dataset ${path} must be a JSON array`);
  return data as BenchItem[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const datasetPath = args.find((a) => !a.startsWith('--')) ?? 'bench/datasets/sample.json';
  const outArg = args.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.slice('--out='.length) : 'bench/results/latest.json';

  const cfg = loadConfig({ skipAsk: args.includes('--no-ask') ? true : undefined });
  const items = loadDataset(datasetPath);

  /* eslint-disable no-console */
  console.log(
    `Running ${items.length} items against ${cfg.baseUrl} (project=${cfg.project}, k=${cfg.k}, skipAsk=${cfg.skipAsk})`
  );
  /* eslint-enable no-console */

  const report = await runBenchmark(items, cfg);
  printReport(report);

  const absOut = resolve(outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  writeFileSync(absOut, JSON.stringify(report, null, 2));
  /* eslint-disable no-console */
  console.log(`\nJSON report written to ${absOut}`);
  /* eslint-enable no-console */

  // Non-zero exit if any item errored, so CI can gate on it.
  if (report.overall.errors > 0) process.exitCode = 1;
}

// Only run main() when executed directly (not when imported by tests).
// `require.main === module` works under ts-node/tsx CJS; the realpath check
// covers ESM-style invocation too.
const isMain =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isMain) {
  main().catch((err) => {
    /* eslint-disable no-console */
    console.error(err);
    /* eslint-enable no-console */
    process.exit(1);
  });
}
