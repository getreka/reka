/**
 * Eval CLI - Entry point for running evaluations and comparing reports.
 *
 * Usage:
 *   npx ts-node src/eval/cli.ts run [--project NAME] [--hybrid] [--api-url URL]
 *   npx ts-node src/eval/cli.ts compare <before.json> <after.json>
 *   npx ts-node src/eval/cli.ts benchmark run <adapter-module> [options]
 *   npx ts-node src/eval/cli.ts benchmark list
 */

import * as path from 'path';
import { runEval } from './runner';
import { compareReports } from './compare';
import type { BenchmarkAdapter } from './benchmarks/adapter';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === 'run') {
    const project = getFlag(args, '--project');
    const hybrid = args.includes('--hybrid');
    const apiUrl = getFlag(args, '--api-url');
    const goldenPath = getFlag(args, '--golden');

    await runEval({ project, hybrid, apiUrl, goldenPath });
  } else if (command === 'compare') {
    const beforePath = args[1];
    const afterPath = args[2];

    if (!beforePath || !afterPath) {
      console.error('Usage: compare <before.json> <after.json>');
      process.exit(1);
    }

    compareReports(beforePath, afterPath);
  } else if (command === 'benchmark') {
    await handleBenchmark(args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

async function handleBenchmark(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printBenchmarkHelp();
    process.exit(0);
  }

  if (sub === 'list') {
    console.log(`
Built-in benchmark adapters
----------------------------
  (none bundled — implement BenchmarkAdapter and pass the module path to "benchmark run")

To create an adapter:
  1. Extend BenchmarkAdapter from src/eval/benchmarks/adapter.ts
  2. Implement: name, level, prepare(), loadCases(), optionally indexCorpus()
  3. Export a default instance: export default new MyAdapter()
  4. Run: npx ts-node src/eval/cli.ts benchmark run ./my-adapter.ts [options]
    `);
    return;
  }

  if (sub === 'run') {
    const modulePath = args[1];
    if (!modulePath) {
      console.error('Usage: benchmark run <adapter-module> [options]');
      process.exit(1);
    }

    const apiUrl = getFlag(args, '--api-url') || process.env.RAG_API_URL || 'http://localhost:3100';
    const apiKey =
      getFlag(args, '--api-key') || process.env.RAG_API_KEY || process.env.API_KEY || '';
    const collection = getFlag(args, '--collection') || '';
    const skipIndex = args.includes('--skip-index');
    const skipPrepare = args.includes('--skip-prepare');

    const resolved = path.resolve(process.cwd(), modulePath);
    let adapter: BenchmarkAdapter;

    try {
      const mod = await import(resolved);
      adapter = mod.default as BenchmarkAdapter;
      if (!adapter || typeof adapter.run !== 'function') {
        throw new Error('Module must export a default BenchmarkAdapter instance');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load adapter from "${resolved}": ${msg}`);
      process.exit(1);
    }

    if (!skipPrepare) {
      console.log('Preparing benchmark dataset...');
      await adapter.prepare();
    }

    const targetCollection =
      collection || `benchmark_${adapter.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;

    if (!skipIndex && typeof adapter.indexCorpus === 'function') {
      console.log(`Indexing corpus into "${targetCollection}"...`);
      const count = await adapter.indexCorpus(targetCollection);
      console.log(`Indexed ${count} documents.`);
    }

    await adapter.run(apiUrl, apiKey, targetCollection);
    return;
  }

  console.error(`Unknown benchmark subcommand: ${sub}`);
  printBenchmarkHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`
RAG Eval CLI

Usage:
  npx ts-node src/eval/cli.ts run [options]                         Run eval against golden queries
  npx ts-node src/eval/cli.ts compare <before.json> <after.json>   Compare two eval reports
  npx ts-node src/eval/cli.ts benchmark <subcommand> [options]      Run a benchmark adapter

Run options:
  --project NAME     Project name (default: from golden-queries.json)
  --hybrid           Use hybrid search instead of semantic
  --api-url URL      RAG API base URL (default: http://localhost:3100)
  --golden PATH      Path to golden queries JSON file

Benchmark subcommands:
  list               List available adapters
  run <module>       Run a benchmark adapter (see "benchmark --help")
  `);
}

function printBenchmarkHelp(): void {
  console.log(`
RAG Eval CLI — benchmark subcommand

Usage:
  npx ts-node src/eval/cli.ts benchmark list
  npx ts-node src/eval/cli.ts benchmark run <adapter-module> [options]

Run options:
  --api-url URL        RAG API base URL (default: RAG_API_URL env or http://localhost:3100)
  --api-key KEY        API key (default: RAG_API_KEY or API_KEY env)
  --collection NAME    Qdrant collection to query (default: auto-derived from adapter name)
  --skip-prepare       Skip adapter.prepare() (dataset already downloaded)
  --skip-index         Skip adapter.indexCorpus() (corpus already indexed)
  `);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

main().catch((err) => {
  console.error('Eval failed:', err.message);
  process.exit(1);
});
