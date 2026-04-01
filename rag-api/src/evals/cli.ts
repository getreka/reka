/**
 * Eval CLI - Run eval suite from command line.
 *
 * Usage:
 *   npm run eval              — Run all eval cases
 *   npm run eval:benchmark    — A/B model comparison
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { EvalRunner, EvalCase } from './runner';
import { EvalReporter } from './reporter';

function loadFixtures(): EvalCase[] {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
  const cases: EvalCase[] = [];

  for (const file of files) {
    const content = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf-8'));
    if (Array.isArray(content)) {
      cases.push(...content);
    }
  }

  return cases;
}

async function main() {
  const baseUrl = process.env.RAG_API_URL || 'http://localhost:3100';
  const apiKey = process.env.API_KEY;
  const projectName = process.env.PROJECT_NAME || 'rag';
  const model = process.env.OLLAMA_MODEL || 'qwen3.5:35b';

  console.log(`Eval Runner — Model: ${model}, API: ${baseUrl}`);

  const cases = loadFixtures();
  if (cases.length === 0) {
    console.log('No test cases found in fixtures/');
    process.exit(1);
  }

  console.log(`Loaded ${cases.length} test cases\n`);

  const runner = new EvalRunner(baseUrl, projectName, apiKey);
  const reporter = new EvalReporter();

  const run = await runner.runAll(cases);
  run.model = model;

  const filepath = reporter.report(run, model.replace(/[^a-z0-9]/gi, '_'));
  console.log(`Results saved to: ${filepath}`);

  process.exit(run.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
