/**
 * A/B Benchmark - Compare two models on the same eval fixtures.
 */

import fs from 'fs';
import path from 'path';
import { EvalRunner, EvalCase } from './runner';
import { EvalReporter } from './reporter';

async function loadFixtures(): Promise<EvalCase[]> {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
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
  const args = process.argv.slice(2);
  let modelA = 'qwen2.5:32b';
  let modelB = 'qwen3.5:35b';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model-a' && args[i + 1]) modelA = args[++i];
    if (args[i] === '--model-b' && args[i + 1]) modelB = args[++i];
  }

  const baseUrl = process.env.RAG_API_URL || 'http://localhost:3100';
  const apiKey = process.env.API_KEY;
  const projectName = process.env.PROJECT_NAME || 'rag';

  console.log(`Benchmark: ${modelA} vs ${modelB}`);
  console.log(`API: ${baseUrl}`);

  const cases = await loadFixtures();
  if (cases.length === 0) {
    console.log('No test cases found in fixtures/');
    process.exit(1);
  }

  console.log(`Loaded ${cases.length} test cases\n`);

  const runner = new EvalRunner(baseUrl, projectName, apiKey);
  const reporter = new EvalReporter();

  // Run Model A
  console.log(`Running Model A: ${modelA}...`);
  process.env.OLLAMA_MODEL = modelA;
  const runA = await runner.runAll(cases);
  runA.model = modelA;
  reporter.report(runA, `model-a-${modelA}`);

  // Run Model B
  console.log(`Running Model B: ${modelB}...`);
  process.env.OLLAMA_MODEL = modelB;
  const runB = await runner.runAll(cases);
  runB.model = modelB;
  reporter.report(runB, `model-b-${modelB}`);

  // Compare
  reporter.compareRuns(runA, runB);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
