/**
 * LongMemEval Benchmark Adapter
 *
 * Evaluates 5 core long-term memory abilities:
 * 1. Information Extraction (single-session-user/assistant/preference)
 * 2. Multi-Session Reasoning (multi-session)
 * 3. Temporal Reasoning (temporal-reasoning)
 * 4. Knowledge Updates (knowledge-update)
 * 5. Abstention (implicit — correct "I don't know" when info not in history)
 *
 * Uses S file (full haystack, ~53 sessions per question) for realistic evaluation.
 * All 500 questions, all sessions ingested.
 *
 * 3-Phase pipeline (avoids Ollama model-loading conflicts):
 *   Phase 1 — Recall: embedding model only, direct Qdrant for all questions
 *   Phase 2 — Batch API: submit answer+judge requests via Anthropic Batch API
 *   Phase 3 — Score: parse results, compute per-category accuracy, save report
 *
 * Usage:
 *   npx ts-node src/scripts/longmemeval-benchmark.ts [--mode durable|ltm|graph] [--limit 50] [--skip-ingest]
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── Config ────────────────────────────────────────────────

const RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:3100';
const RAG_API_KEY = process.env.RAG_API_KEY || process.env.API_KEY || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROJECT_NAME = 'longmemeval-bench';
const ANSWER_MODEL = 'claude-sonnet-4-20250514';
const POLL_INTERVAL_MS = 30_000;

// Map question_type → ability
const ABILITY_MAP: Record<string, string> = {
  'single-session-user': 'extraction',
  'single-session-assistant': 'extraction',
  'single-session-preference': 'extraction',
  'multi-session': 'multi-session-reasoning',
  'temporal-reasoning': 'temporal-reasoning',
  'knowledge-update': 'knowledge-updates',
};

// ── Types ─────────────────────────────────────────────────

interface Turn {
  role: string;
  content: string;
}

interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

interface RecallResult {
  questionId: string;
  question: string;
  questionDate: string;
  questionType: string;
  expectedAnswer: string;
  context: string;
}

interface AbilityScore {
  correct: number;
  total: number;
  accuracy: number;
}

interface BenchmarkResult {
  mode: string;
  totalQuestions: number;
  totalSessions: number;
  totalFacts: number;
  abilities: Record<string, AbilityScore>;
  overallAccuracy: number;
  durationMs: number;
  details: Array<{
    questionId: string;
    questionType: string;
    ability: string;
    question: string;
    expected: string;
    answer: string;
    score: number;
  }>;
}

// ── Retry helper ──────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, delayMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status || err?.response?.status;
      if (
        (status === 404 || status === 529 || status === 429 || status >= 500) &&
        attempt < maxRetries
      ) {
        const wait = delayMs * attempt;
        console.log(
          `    Retry ${attempt}/${maxRetries} after ${wait}ms (${err.message?.slice(0, 60)})`
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ── HTTP helpers ──────────────────────────────────────────

async function ragPost(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${RAG_API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Project-Name': PROJECT_NAME,
      'X-API-Key': RAG_API_KEY,
    },
    body: JSON.stringify({ ...body, projectName: PROJECT_NAME }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RAG API ${endpoint} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Ingest: extract facts via Ollama ─────────────────────

async function extractFacts(sessionText: string, date: string): Promise<string[]> {
  const text = await ollamaChat(
    `Extract all factual information from this conversation as standalone facts.

Conversation (${date}):
${sessionText.slice(0, 4000)}

Rules:
- One fact per line
- Include temporal context (dates) when available
- Include who said what and about whom
- Be specific and self-contained
- Extract every claim, preference, event, plan, emotion
- For assistant responses, extract what information was provided

Facts:`,
    2000
  );
  return text
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 10);
}

async function ingestAllSessions(
  data: Question[]
): Promise<{ totalSessions: number; totalFacts: number }> {
  // Collect ALL unique sessions across all questions
  const sessionMap = new Map<string, { turns: Turn[]; date: string }>();

  for (const q of data) {
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      const sid = q.haystack_session_ids[i];
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, {
          turns: q.haystack_sessions[i],
          date: q.haystack_dates[i] || '',
        });
      }
    }
  }

  console.log(`  Unique sessions to ingest: ${sessionMap.size}`);

  // Check how many facts already exist (resume support)
  let existingFacts = 0;
  try {
    const stats = await fetch(`${RAG_API_URL}/api/memory/stats?projectName=${PROJECT_NAME}`, {
      headers: { 'X-API-Key': RAG_API_KEY },
    }).then((r) => r.json());
    existingFacts = (stats as any)?.stats?.total || 0;
    if (existingFacts > 0) {
      console.log(`  Found ${existingFacts} existing facts — resuming ingestion`);
    }
  } catch {
    /* ignore */
  }

  let totalFacts = existingFacts;
  let processed = 0;
  const entries = [...sessionMap.entries()];

  // Process in batches of 3 sessions for parallel fact extraction (avoid API overload)
  for (let i = 0; i < entries.length; i += 3) {
    const batch = entries.slice(i, i + 3);

    const batchResults = await Promise.all(
      batch.map(async ([sid, session]) => {
        const dialogText = session.turns.map((t) => `${t.role}: ${t.content}`).join('\n');

        const facts = await extractFacts(dialogText, session.date);
        return { sid, facts, date: session.date };
      })
    );

    // Batch store all facts
    const items: Array<{ content: string; type: string; tags: string[] }> = [];
    for (const { sid, facts, date } of batchResults) {
      for (const fact of facts) {
        items.push({
          content: `[${date}] ${fact}`,
          type: 'insight',
          tags: [sid, 'extracted-fact'],
        });
      }
      totalFacts += facts.length;
    }

    if (items.length > 0) {
      // Sub-batch into groups of 10 for API limits
      for (let j = 0; j < items.length; j += 10) {
        await ragPost('/api/memory/batch', { items: items.slice(j, j + 10) });
      }
    }

    processed += batch.length;
    if (processed % 50 === 0 || processed === entries.length) {
      console.log(`  Ingested ${processed}/${entries.length} sessions, ${totalFacts} facts so far`);
    }
  }

  return { totalSessions: sessionMap.size, totalFacts };
}

// ── Ollama helper ─────────────────────────────────────────

async function ollamaChat(prompt: string, maxTokens = 300): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { num_predict: maxTokens, temperature: 0.1 },
      }),
    });
    if (!res.ok) {
      const err: any = new Error(`Ollama ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as any;
    return (data.message?.content || '').trim();
  });
}

// ── Phase 1: Recall (embedding model only, direct Qdrant) ─

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'was',
  'are',
  'were',
  'do',
  'did',
  'does',
  'what',
  'where',
  'when',
  'how',
  'who',
  'which',
  'my',
  'i',
  'me',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'that',
  'this',
  'it',
  'and',
  'or',
  'but',
  'not',
  'have',
  'has',
  'had',
]);

interface RankedResult {
  id: string;
  content: string;
  score: number;
}

function reciprocalRankFusion(
  lists: Array<Array<RankedResult>>,
  k = 60
): Array<{ score: number; content: string }> {
  const scores = new Map<string, { score: number; content: string }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(item.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(item.id, { score: rrfScore, content: item.content });
      }
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

async function queryMemory(question: string, questionDate: string, _mode: string): Promise<string> {
  const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
  const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b';
  const collection = `${PROJECT_NAME}_agent_memory`;
  const query = `${question} (as of ${questionDate})`;

  const qdrantHeaders = { 'Content-Type': 'application/json' };

  try {
    // Strategy 1: Semantic search via Ollama embed + Qdrant vector search
    const semanticResults: RankedResult[] = await (async () => {
      const embedRes = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: qdrantHeaders,
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: query }),
      });
      if (!embedRes.ok) return [];
      const embedData = (await embedRes.json()) as { embeddings: number[][] };
      const vector = embedData.embeddings[0].slice(0, 1024);

      const searchRes = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders,
        body: JSON.stringify({ vector, limit: 15, with_payload: true }),
      });
      if (!searchRes.ok) return [];

      const searchData = (await searchRes.json()) as {
        result: Array<{ id: string | number; payload: any; score: number }>;
      };
      return (searchData.result || []).map((r) => ({
        id: String(r.id),
        content: String(r.payload?.content || ''),
        score: r.score,
      }));
    })();

    // Strategy 2: Keyword search via Qdrant scroll with text match filter
    const keywordResults: RankedResult[] = await (async () => {
      const keywords = query
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
      if (keywords.length === 0) return [];

      const scrollRes = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders,
        body: JSON.stringify({
          filter: {
            should: keywords.map((kw) => ({ key: 'content', match: { text: kw } })),
          },
          limit: 15,
          with_payload: true,
        }),
      });
      if (!scrollRes.ok) return [];

      const scrollData = (await scrollRes.json()) as {
        result: { points: Array<{ id: string | number; payload: any }> };
      };
      const points = scrollData.result?.points || [];
      return points.map((p, idx) => ({
        id: String(p.id),
        content: String(p.payload?.content || ''),
        score: 1 / (idx + 1),
      }));
    })();

    // Strategy 3: Temporal-boosted scroll — filter by date substring if query contains a date
    const temporalResults: RankedResult[] = await (async () => {
      const dateMatch = query.match(/(\d{4})\/(\d{2})/);
      if (!dateMatch) return [];

      const datePrefix = `${dateMatch[1]}/${dateMatch[2]}`;

      const scrollRes = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: qdrantHeaders,
        body: JSON.stringify({
          filter: {
            must: [{ key: 'content', match: { text: datePrefix } }],
          },
          limit: 15,
          with_payload: true,
        }),
      });
      if (!scrollRes.ok) return [];

      const scrollData = (await scrollRes.json()) as {
        result: { points: Array<{ id: string | number; payload: any }> };
      };
      const points = scrollData.result?.points || [];
      return points.map((p, idx) => ({
        id: String(p.id),
        content: String(p.payload?.content || ''),
        score: 1 / (idx + 1),
      }));
    })();

    // RRF merge all non-empty strategy result lists
    const allLists = [semanticResults, keywordResults, temporalResults].filter((l) => l.length > 0);
    if (allLists.length === 0) return '';

    const merged = reciprocalRankFusion(allLists);
    if (merged.length === 0) return '';

    return merged
      .slice(0, 15)
      .map((r) => r.content.slice(0, 300))
      .join('\n---\n');
  } catch {
    return '';
  }
}

async function runRecallPhase(questions: Question[], mode: string): Promise<RecallResult[]> {
  console.log(`\n  Phase 1: Recalling context for ${questions.length} questions...`);
  const results: RecallResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const context = await queryMemory(q.question, q.question_date, mode);
    results.push({
      questionId: q.question_id,
      question: q.question,
      questionDate: q.question_date,
      questionType: q.question_type,
      expectedAnswer: q.answer,
      context,
    });

    if ((i + 1) % 50 === 0 || i + 1 === questions.length) {
      console.log(`  Recalled ${i + 1}/${questions.length}`);
    }
  }

  return results;
}

// ── Phase 2: Batch API ────────────────────────────────────

function buildAnswerPrompt(context: string, question: string): string {
  return `Based on the following memory excerpts, answer the question concisely.

Context:
${context.slice(0, 5000)}

Question: ${question}

Answer concisely (1-2 sentences). If the information is not in the context, say "I don't know."`;
}

function buildJudgePrompt(
  question: string,
  expectedAnswer: string,
  predictedAnswer: string
): string {
  return `Compare the predicted answer against the gold answer.

Question: ${question}
Gold Answer: ${expectedAnswer}
Predicted Answer: ${predictedAnswer}

Are they semantically equivalent? Minor wording/format differences are OK.
Respond ONLY "1" if equivalent, "0" if not.`;
}

async function submitAnswerBatch(client: Anthropic, recalls: RecallResult[]): Promise<string> {
  console.log(`\n  Phase 2a: Submitting ${recalls.length} answer requests to Batch API...`);

  const requests = recalls.map((r) => ({
    custom_id: r.questionId,
    params: {
      model: ANSWER_MODEL as 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [
        {
          role: 'user' as const,
          content: buildAnswerPrompt(r.context, r.question),
        },
      ],
    },
  }));

  const batch = await client.messages.batches.create({ requests });
  console.log(`  Answer batch created: ${batch.id} (status: ${batch.processing_status})`);
  return batch.id;
}

async function submitJudgeBatch(
  client: Anthropic,
  recalls: RecallResult[],
  answers: Map<string, string>
): Promise<string> {
  console.log(`\n  Phase 2c: Submitting ${recalls.length} judge requests to Batch API...`);

  const requests = recalls.map((r) => {
    const predicted = answers.get(r.questionId) ?? "I don't know.";
    return {
      custom_id: r.questionId,
      params: {
        model: ANSWER_MODEL as 'claude-sonnet-4-20250514',
        max_tokens: 5,
        messages: [
          {
            role: 'user' as const,
            content: buildJudgePrompt(r.question, r.expectedAnswer, predicted),
          },
        ],
      },
    };
  });

  const batch = await client.messages.batches.create({ requests });
  console.log(`  Judge batch created: ${batch.id} (status: ${batch.processing_status})`);
  return batch.id;
}

async function pollBatch(client: Anthropic, batchId: string, label: string): Promise<void> {
  console.log(`  Polling ${label} batch ${batchId} (every ${POLL_INTERVAL_MS / 1000}s)...`);

  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);
    const c = batch.request_counts;
    const done = c.succeeded + c.errored + c.canceled + c.expired;
    const total = done + c.processing;
    const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '0.0';
    console.log(
      `  ${label}: ${batch.processing_status} — ${c.succeeded} ok, ${c.errored} err, ${c.processing} pending (${pct}%)`
    );

    if (batch.processing_status === 'ended') {
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function extractBatchAnswers(
  client: Anthropic,
  batchId: string
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  const results = await client.messages.batches.results(batchId);

  for await (const result of results) {
    if (result.result.type === 'succeeded') {
      const block = result.result.message.content[0];
      if (block.type === 'text') {
        answers.set(result.custom_id, block.text.trim());
      }
    } else {
      answers.set(result.custom_id, "I don't know.");
    }
  }

  return answers;
}

async function extractBatchScores(
  client: Anthropic,
  batchId: string
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const results = await client.messages.batches.results(batchId);

  for await (const result of results) {
    if (result.result.type === 'succeeded') {
      const block = result.result.message.content[0];
      if (block.type === 'text') {
        scores.set(result.custom_id, block.text.trim().startsWith('1') ? 1 : 0);
      } else {
        scores.set(result.custom_id, 0);
      }
    } else {
      scores.set(result.custom_id, 0);
    }
  }

  return scores;
}

// ── Phase 3: Score ────────────────────────────────────────

function processResults(
  recalls: RecallResult[],
  answers: Map<string, string>,
  scores: Map<string, number>
): {
  abilities: Record<string, AbilityScore>;
  details: BenchmarkResult['details'];
  totalCorrect: number;
} {
  const abilities: Record<string, AbilityScore> = {};
  const details: BenchmarkResult['details'] = [];
  let totalCorrect = 0;

  for (const r of recalls) {
    const ability = ABILITY_MAP[r.questionType] || r.questionType;
    const answer = answers.get(r.questionId) ?? "I don't know.";
    const score = scores.get(r.questionId) ?? 0;

    if (!abilities[ability]) {
      abilities[ability] = { correct: 0, total: 0, accuracy: 0 };
    }
    abilities[ability].total++;
    abilities[ability].correct += score;
    totalCorrect += score;

    details.push({
      questionId: r.questionId,
      questionType: r.questionType,
      ability,
      question: r.question,
      expected: r.expectedAnswer,
      answer,
      score,
    });
  }

  for (const a of Object.values(abilities)) {
    a.accuracy = a.total > 0 ? a.correct / a.total : 0;
  }

  return { abilities, details, totalCorrect };
}

// ── Main ──────────────────────────────────────────────────

async function runBenchmark(opts: {
  mode: string;
  limit?: number;
  skipIngest?: boolean;
}): Promise<BenchmarkResult> {
  const startTime = Date.now();
  const dataPath = path.join(__dirname, 'longmemeval_s.json');
  console.log('  Loading dataset...');
  const data: Question[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const questions = opts.limit ? data.slice(0, opts.limit) : data;

  console.log(`  Questions: ${questions.length}/${data.length}`);

  // Ingest
  let totalSessions = 0;
  let totalFacts = 0;
  if (!opts.skipIngest) {
    console.log('\n  Ingest: Ingesting sessions with fact extraction...');
    const ingestResult = await ingestAllSessions(questions);
    totalSessions = ingestResult.totalSessions;
    totalFacts = ingestResult.totalFacts;
  }

  // Phase 1: Recall context for all questions (embedding model only)
  const recalls = await runRecallPhase(questions, opts.mode);

  // Phase 2: Submit answer + judge requests via Anthropic Batch API
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // 2a: Submit answer batch
  const answerBatchId = await submitAnswerBatch(client, recalls);

  // 2b: Poll until answers are ready
  await pollBatch(client, answerBatchId, 'answers');

  // 2c: Extract answers, then submit judge batch
  console.log('\n  Phase 2b: Extracting answers from batch results...');
  const answers = await extractBatchAnswers(client, answerBatchId);
  console.log(`  Extracted ${answers.size} answers`);

  const judgeBatchId = await submitJudgeBatch(client, recalls, answers);

  // 2d: Poll until judgements are ready
  await pollBatch(client, judgeBatchId, 'judges');

  // Phase 3: Extract scores and compute final metrics
  console.log('\n  Phase 3: Processing results...');
  const scores = await extractBatchScores(client, judgeBatchId);

  const { abilities, details, totalCorrect } = processResults(recalls, answers, scores);
  const overallAccuracy = questions.length > 0 ? totalCorrect / questions.length : 0;

  const result: BenchmarkResult = {
    mode: opts.mode,
    totalQuestions: questions.length,
    totalSessions,
    totalFacts,
    abilities,
    overallAccuracy,
    durationMs: Date.now() - startTime,
    details,
  };

  // Print results
  console.log(`\n${'='.repeat(60)}`);
  console.log(`LONGMEMEVAL RESULTS (mode: ${opts.mode})`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Sessions ingested: ${totalSessions}`);
  console.log(`  Facts extracted: ${totalFacts}`);
  console.log(`  Questions answered: ${questions.length}`);
  console.log();

  for (const [ability, s] of Object.entries(abilities).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${ability}: ${s.correct}/${s.total} = ${(s.accuracy * 100).toFixed(1)}%`);
  }
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Overall: ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(0)}s`);

  // Save
  const outPath = path.join(__dirname, `longmemeval-results-${opts.mode}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n  Results saved to ${outPath}`);

  return result;
}

// ── CLI ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith('--mode='))?.split('=')[1] || 'durable';
  const limit = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const skipIngest = args.includes('--skip-ingest');

  console.log(`LongMemEval Benchmark`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Limit: ${limit || 'all 500'}`);
  console.log(`  API: ${RAG_API_URL}`);
  console.log(`  Answer/Judge model: ${ANSWER_MODEL} (Anthropic Batch API)`);

  await runBenchmark({
    mode,
    limit: limit ? parseInt(limit) : undefined,
    skipIngest,
  });
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
