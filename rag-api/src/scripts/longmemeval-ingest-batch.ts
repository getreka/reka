/**
 * LongMemEval Batch Ingester — Anthropic Batch API
 *
 * Submits all sessions to Anthropic Batch API (Haiku, 50% off),
 * polls for completion, then ingests extracted facts into RAG.
 *
 * Usage: npx ts-node src/scripts/longmemeval-ingest-batch.ts [--submit | --poll <batchId> | --ingest <batchId>]
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:3100';
const RAG_API_KEY = process.env.RAG_API_KEY || '';
const PROJECT_NAME = 'longmemeval-bench';
const RESULTS_DIR = path.join(__dirname, 'batch-results');
const META_FILE = process.env.BATCH_META_FILE || 'batch-meta.json';

const client = new Anthropic();

interface Turn {
  role: string;
  content: string;
}
interface Question {
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
}

function loadSessions(): Map<string, { text: string; date: string }> {
  const dataPath = path.join(__dirname, 'longmemeval_s.json');
  const data: Question[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const sessionMap = new Map<string, { text: string; date: string }>();
  for (const q of data) {
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      const sid = q.haystack_session_ids[i];
      if (!sessionMap.has(sid)) {
        const text = q.haystack_sessions[i].map((t) => `${t.role}: ${t.content}`).join('\n');
        sessionMap.set(sid, { text, date: q.haystack_dates[i] || '' });
      }
    }
  }
  return sessionMap;
}

function buildPrompt(sessionText: string, date: string): string {
  const datePrefix = date ? `Conversation date: ${date}\n\n` : '';
  return `${datePrefix}You are a precise memory-extraction assistant. Extract every factual claim from the conversation below into structured JSON facts grouped by category.

Categories:
- personal_info: Name, job title, role, location, age, ethnicity, family members, relationships
- preference: Likes, dislikes, hobbies, habits, favorites (food, music, books, sports, etc.)
- event: Something that happened — what occurred, with whom, where, outcome
- temporal: Dates, durations, sequences ("first", "last", "before", "after"), deadlines
- update: Something that changed — moved, changed jobs, ended a relationship, updated a preference
- plan: Future events, goals, intentions, scheduled activities

Rules:
- Extract EVERY fact, even minor ones
- Each fact must be self-contained and standalone
- entities: list every named person, place, organization, or thing in the fact
- date: ISO date string (YYYY-MM-DD) if a specific date is mentioned, else omit
- supersedes: short description of an older fact this replaces, or null

Conversation:
${sessionText.slice(0, 5000)}

Return ONLY valid JSON (no markdown, no prose):
{
  "facts": [
    {
      "category": "<category>",
      "content": "<standalone fact>",
      "entities": ["<entity>", ...],
      "date": "<YYYY-MM-DD or null>",
      "supersedes": "<older fact description or null>"
    }
  ]
}`;
}

async function submit() {
  const sessions = loadSessions();
  const allSids = [...sessions.keys()].sort();
  console.log(`Total sessions: ${allSids.length}`);

  // Batch API limit: 10,000 requests per batch
  const BATCH_SIZE = 10000;
  const batches: string[][] = [];
  for (let i = 0; i < allSids.length; i += BATCH_SIZE) {
    batches.push(allSids.slice(i, i + BATCH_SIZE));
  }
  console.log(`Will create ${batches.length} batch(es)`);

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const batchIds: string[] = [];
  for (let b = 0; b < batches.length; b++) {
    const sids = batches[b];
    console.log(`\nSubmitting batch ${b + 1}/${batches.length} (${sids.length} requests)...`);

    const requests = sids.map((sid) => {
      const session = sessions.get(sid)!;
      return {
        custom_id: sid,
        params: {
          model: 'claude-haiku-4-5-20251001' as const,
          max_tokens: 3000,
          messages: [{ role: 'user' as const, content: buildPrompt(session.text, session.date) }],
        },
      };
    });

    const batch = await client.messages.batches.create({ requests });
    console.log(`Batch ${b + 1} created: ${batch.id} (status: ${batch.processing_status})`);
    batchIds.push(batch.id);
  }

  // Save batch IDs for polling
  const metaPath = path.join(RESULTS_DIR, META_FILE);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      { batchIds, totalSessions: allSids.length, createdAt: new Date().toISOString() },
      null,
      2
    )
  );
  console.log(`\nBatch IDs saved to ${metaPath}`);
  console.log(`Batch IDs: ${batchIds.join(', ')}`);
  console.log(
    `\nPoll with: BATCH_META_FILE=${META_FILE} npx ts-node src/scripts/longmemeval-ingest-batch.ts --poll`
  );
}

async function poll(specificId?: string) {
  const metaPath = path.join(RESULTS_DIR, 'batch-meta.json');
  let batchIds: string[];

  if (specificId) {
    batchIds = [specificId];
  } else {
    const pollMetaPath = path.join(RESULTS_DIR, META_FILE);
    const meta = JSON.parse(fs.readFileSync(pollMetaPath, 'utf-8'));
    batchIds = meta.batchIds;
  }

  for (const id of batchIds) {
    const batch = await client.messages.batches.retrieve(id);
    const counts = batch.request_counts;
    const total =
      counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired;
    const pct = total > 0 ? (((counts.succeeded + counts.errored) / total) * 100).toFixed(1) : '0';
    console.log(
      `Batch ${id}: ${batch.processing_status} — ${counts.succeeded} ok, ${counts.errored} err, ${counts.processing} pending (${pct}%)`
    );

    if (batch.processing_status === 'ended') {
      console.log(`  → Ready for ingest!`);
    }
  }
}

interface StructuredFact {
  category: string;
  content: string;
  entities?: string[];
  date?: string | null;
  supersedes?: string | null;
}

function parseStructuredFacts(text: string): StructuredFact[] {
  // Strip markdown fences if present
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

async function ingest(specificId?: string) {
  const metaPath = path.join(RESULTS_DIR, 'batch-meta.json');
  let batchIds: string[];

  if (specificId) {
    batchIds = [specificId];
  } else {
    const ingestMetaPath = path.join(RESULTS_DIR, META_FILE);
    const meta = JSON.parse(fs.readFileSync(ingestMetaPath, 'utf-8'));
    batchIds = meta.batchIds;
  }

  const sessions = loadSessions();

  let totalFacts = 0;
  let totalSessions = 0;
  let parseErrors = 0;
  let errors = 0;

  for (const batchId of batchIds) {
    console.log(`\nProcessing batch ${batchId}...`);

    const results = await client.messages.batches.results(batchId);
    const items: Array<{
      content: string;
      type: string;
      tags: string[];
      metadata?: Record<string, unknown>;
      factCategory?: string;
      factEntities?: string[];
      factDateTs?: number;
    }> = [];

    for await (const result of results) {
      totalSessions++;

      if (result.result.type === 'succeeded') {
        const text = result.result.message.content[0];
        if (text.type === 'text') {
          const facts = parseStructuredFacts(text.text);

          if (facts.length === 0) {
            parseErrors++;
          }

          // Look up the session date so we can prepend it to content for temporal search
          const sessionDate = sessions.get(result.custom_id)?.date || '';

          for (const fact of facts) {
            const effectiveDate = fact.date || sessionDate || null;
            const factDateTs = isoDateToTs(effectiveDate);
            const contentWithDate = effectiveDate
              ? `[${effectiveDate}] ${fact.content}`
              : fact.content;
            items.push({
              content: contentWithDate,
              type: 'insight',
              tags: [result.custom_id, 'extracted-fact', fact.category],
              metadata: {
                sessionId: result.custom_id,
                supersedes: fact.supersedes ?? null,
              },
              factCategory: fact.category,
              factEntities: fact.entities && fact.entities.length > 0 ? fact.entities : undefined,
              factDateTs,
            });
          }
          totalFacts += facts.length;
        }
      } else {
        errors++;
        if (errors <= 5) console.log(`  Error for ${result.custom_id}: ${result.result.type}`);
      }

      // Batch insert every 200 items
      if (items.length >= 200) {
        await flushToRAG(items.splice(0, 200));
      }

      if (totalSessions % 1000 === 0) {
        console.log(
          `  ${totalSessions} sessions, ${totalFacts} facts, ${errors} errors, ${parseErrors} parse-errors`
        );
      }
    }

    // Flush remaining
    if (items.length > 0) {
      await flushToRAG(items);
    }
  }

  console.log(
    `\nDONE: ${totalSessions} sessions, ${totalFacts} facts, ${errors} errors, ${parseErrors} parse-errors`
  );

  // Save summary
  const summaryPath = path.join(RESULTS_DIR, 'ingest-summary.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        totalSessions,
        totalFacts,
        errors,
        parseErrors,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

let ragInFlight = 0;
const MAX_CONCURRENT_RAG = 3;

async function flushToRAG(
  items: Array<{
    content: string;
    type: string;
    tags: string[];
    metadata?: Record<string, unknown>;
    factCategory?: string;
    factEntities?: string[];
    factDateTs?: number;
  }>
) {
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);

    // Throttle concurrent RAG requests
    while (ragInFlight >= MAX_CONCURRENT_RAG) {
      await new Promise((r) => setTimeout(r, 200));
    }

    ragInFlight++;
    (async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(`${RAG_API_URL}/api/memory/batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Project-Name': PROJECT_NAME,
              'X-API-Key': RAG_API_KEY,
            },
            body: JSON.stringify({ items: chunk, projectName: PROJECT_NAME }),
          });
          if (res.ok) break;
          if (res.status === 429 && attempt < 5) {
            await new Promise((r) => setTimeout(r, 1000 * attempt + Math.random() * 1000));
            continue;
          }
          console.log(`  RAG error: ${res.status} (attempt ${attempt})`);
        } catch (err: any) {
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            continue;
          }
          console.log(`  RAG error: ${err.message?.slice(0, 50)}`);
        }
      }
      ragInFlight--;
    })();
  }

  // Wait for all in-flight to finish
  while (ragInFlight > 0) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || '--submit';

  if (cmd === '--submit') {
    await submit();
  } else if (cmd === '--poll') {
    await poll(args[1]);
  } else if (cmd === '--ingest') {
    await ingest(args[1]);
  } else {
    console.log('Usage: --submit | --poll [batchId] | --ingest [batchId]');
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
