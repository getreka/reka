/**
 * LongMemEval Direct Ingest — bypasses RAG API entirely
 *
 * Reads Anthropic Batch API results, embeds via Ollama, upserts directly to Qdrant.
 * Avoids rate limiting on /api/memory/batch.
 *
 * Usage: npx ts-node src/scripts/longmemeval-direct-ingest.ts
 * Env: ANTHROPIC_API_KEY, OLLAMA_URL, QDRANT_URL, OLLAMA_EMBEDDING_MODEL
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '1024', 10);

const COLLECTION = 'longmemeval-bench_agent_memory';
const PROJECT_NAME = 'longmemeval-bench';
const RESULTS_DIR = path.join(__dirname, 'batch-results');
const META_FILE = path.join(RESULTS_DIR, 'batch-meta-v2.json');
const SESSIONS_FILE = path.join(__dirname, 'longmemeval_s.json');

const EMBED_BATCH = 32;
const UPSERT_BATCH = 100;

// ── Qdrant helpers ──────────────────────────────────────────────────────────

async function qdrantGet(p: string): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${p}`);
  if (!res.ok) throw new Error(`Qdrant GET ${p}: ${res.status}`);
  return res.json();
}

async function qdrantPut(p: string, body: unknown): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${p}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant PUT ${p}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function qdrantDelete(p: string): Promise<void> {
  const res = await fetch(`${QDRANT_URL}${p}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`Qdrant DELETE ${p}: ${res.status}`);
}

// ── Ollama embed ────────────────────────────────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embed: ${res.status}`);
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings.map((e) => e.slice(0, VECTOR_SIZE));
    } catch (err: any) {
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('embedBatch: unreachable');
}

// ── Session date loader ─────────────────────────────────────────────────────

interface Turn {
  role: string;
  content: string;
}
interface Question {
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
}

function loadSessions(): Map<string, string> {
  const data: Question[] = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  const dateMap = new Map<string, string>();
  for (const q of data) {
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      const sid = q.haystack_session_ids[i];
      if (!dateMap.has(sid)) {
        dateMap.set(sid, q.haystack_dates[i] || '');
      }
    }
  }
  return dateMap;
}

// ── Structured fact parsing (same as ingest-batch.ts) ──────────────────────

interface StructuredFact {
  category: string;
  content: string;
  entities?: string[];
  date?: string | null;
  supersedes?: string | null;
}

function parseStructuredFacts(text: string): StructuredFact[] {
  const trimmed = text.trim();
  const jsonStr = trimmed.startsWith('```')
    ? (trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1] ?? trimmed)
    : trimmed;

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(jsonStr.slice(start, end + 1));
    const facts: StructuredFact[] = parsed?.facts ?? [];
    return facts.filter((f) => typeof f.content === 'string' && f.content.trim().length > 5);
  } catch {
    return [];
  }
}

function isoDateToTs(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// ── Upsert buffer ───────────────────────────────────────────────────────────

interface FactItem {
  content: string;
  payload: Record<string, unknown>;
}

async function flushToQdrant(items: FactItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += EMBED_BATCH) {
    const chunk = items.slice(i, i + EMBED_BATCH);
    const texts = chunk.map((f) => f.content.slice(0, 8000));

    const embeddings = await embedBatch(texts);

    const points = chunk.map((f, k) => ({
      id: crypto.randomUUID(),
      vector: embeddings[k],
      payload: f.payload,
    }));

    for (let j = 0; j < points.length; j += UPSERT_BATCH) {
      await qdrantPut(`/collections/${COLLECTION}/points`, {
        points: points.slice(j, j + UPSERT_BATCH),
      });
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`LongMemEval Direct Ingest`);
  console.log(`  Collection : ${COLLECTION}`);
  console.log(`  Qdrant     : ${QDRANT_URL}`);
  console.log(`  Ollama     : ${OLLAMA_URL}`);
  console.log(`  Model      : ${OLLAMA_MODEL}`);
  console.log(`  Vector size: ${VECTOR_SIZE}`);
  console.log();

  // 1. Load batch IDs
  if (!fs.existsSync(META_FILE)) {
    throw new Error(`batch-meta-v2.json not found at ${META_FILE}`);
  }
  const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  const batchIds: string[] = meta.batchIds;
  console.log(`Batch IDs: ${batchIds.join(', ')}`);
  console.log(`Total sessions in meta: ${meta.totalSessions}`);

  // 2. Load session dates
  console.log(`Loading session dates from ${SESSIONS_FILE}...`);
  const sessionDates = loadSessions();
  console.log(`  Loaded ${sessionDates.size} session date entries`);

  // 3. Delete existing collection and recreate
  console.log(`\nDropping collection ${COLLECTION}...`);
  await qdrantDelete(`/collections/${COLLECTION}`);

  console.log(`Creating collection ${COLLECTION} (${VECTOR_SIZE}d cosine)...`);
  await qdrantPut(`/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    optimizers_config: { default_segment_number: 4 },
  });
  await new Promise((r) => setTimeout(r, 500));
  console.log(`  Collection created`);

  // 4. Stream batch results and ingest
  const client = new Anthropic();
  const startTime = Date.now();

  let totalFacts = 0;
  let totalSessions = 0;
  let parseErrors = 0;
  let apiErrors = 0;

  const buffer: FactItem[] = [];

  async function flush(force = false) {
    while (buffer.length >= EMBED_BATCH || (force && buffer.length > 0)) {
      const chunk = buffer.splice(0, EMBED_BATCH);
      try {
        await flushToQdrant(chunk);
      } catch (err: any) {
        console.error(`  FLUSH ERROR: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  for (const batchId of batchIds) {
    console.log(`\nProcessing batch ${batchId}...`);
    const results = await client.messages.batches.results(batchId);

    for await (const result of results) {
      totalSessions++;

      if (result.result.type === 'succeeded') {
        const block = result.result.message.content[0];
        if (block.type === 'text') {
          const facts = parseStructuredFacts(block.text);

          if (facts.length === 0) {
            parseErrors++;
          }

          const sessionDate = sessionDates.get(result.custom_id) || '';

          for (const fact of facts) {
            const effectiveDate = fact.date || sessionDate || null;
            const factDateTs = isoDateToTs(effectiveDate);
            const contentWithDate = effectiveDate
              ? `[${effectiveDate}] ${fact.content}`
              : fact.content;

            const payload: Record<string, unknown> = {
              content: contentWithDate,
              type: 'insight',
              tags: [result.custom_id, 'extracted-fact', fact.category],
              projectName: PROJECT_NAME,
              factCategory: fact.category,
              createdAt: new Date().toISOString(),
              sessionId: result.custom_id,
            };

            if (fact.entities && fact.entities.length > 0) {
              payload.factEntities = fact.entities;
            }
            if (factDateTs !== undefined) {
              payload.factDateTs = factDateTs;
            }
            if (fact.supersedes) {
              payload.supersedes = fact.supersedes;
            }

            buffer.push({ content: contentWithDate, payload });
          }

          totalFacts += facts.length;
        }
      } else {
        apiErrors++;
        if (apiErrors <= 5) {
          console.log(`  Error for ${result.custom_id}: ${result.result.type}`);
        }
      }

      if (buffer.length >= EMBED_BATCH * 4) {
        await flush();
      }

      if (totalSessions % 1000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = totalFacts / elapsed;
        const eta =
          rate > 0
            ? ((meta.totalSessions - totalSessions) * (totalFacts / totalSessions)) / rate
            : 0;
        console.log(
          `  ${totalSessions}/${meta.totalSessions} sessions, ${totalFacts.toLocaleString()} facts` +
            ` (${rate.toFixed(0)} facts/s, ETA ${(eta / 60).toFixed(1)} min)`
        );
      }
    }
  }

  // Final flush
  await flush(true);

  const duration = (Date.now() - startTime) / 1000;

  // 5. Report final point count
  const info = await qdrantGet(`/collections/${COLLECTION}`);
  const finalPoints = info.result?.points_count ?? 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Direct ingest complete:`);
  console.log(`  Sessions processed : ${totalSessions.toLocaleString()}`);
  console.log(`  Facts extracted    : ${totalFacts.toLocaleString()}`);
  console.log(`  Parse errors       : ${parseErrors}`);
  console.log(`  API errors         : ${apiErrors}`);
  console.log(`  Duration           : ${(duration / 60).toFixed(1)} min`);
  console.log(`  Rate               : ${(totalFacts / duration).toFixed(0)} facts/s`);
  console.log(`  Final point count  : ${finalPoints.toLocaleString()}`);

  // Save summary
  const summaryPath = path.join(RESULTS_DIR, 'direct-ingest-summary.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        totalSessions,
        totalFacts,
        finalPoints,
        parseErrors,
        apiErrors,
        durationSeconds: duration,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`  Summary saved to   : ${summaryPath}`);
}

main().catch((err) => {
  console.error(`Direct ingest failed: ${err.message}`);
  process.exit(1);
});
