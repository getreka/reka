/**
 * Re-Index Script — Migrate to Qwen3-Embedding-4B
 *
 * Scrolls all points from existing collections, re-embeds content
 * with the new embedding model, and upserts back.
 *
 * Usage:
 *   npx ts-node src/scripts/reindex-embeddings.ts [--collection name] [--dry-run] [--skip-large]
 *   npx ts-node src/scripts/reindex-embeddings.ts --reingest-bench
 *
 * Strategy:
 * - Memory collections: re-embed content field, preserve all payload
 * - Code/codebase/docs: re-embed content field, preserve all payload
 * - Graph/symbols/sessions/tool_usage: skip (no semantic vectors or fixed format)
 * - longmemeval-bench: skip by default (--include-bench to include)
 *
 * --reingest-bench: Re-ingest longmemeval-bench_agent_memory from Anthropic Batch API
 *   results (use when the collection was dropped and needs to be repopulated).
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
const BM25_ENABLED = process.env.QDRANT_BM25_ENABLED === 'true';

const SKIP_PATTERNS = [
  '_graph',
  '_symbols',
  '_sessions',
  '_tool_usage',
  '_tribunals',
  '_llm_usage',
];
const BATCH_SIZE = 32;
const SCROLL_BATCH = 200;

const BENCH_PROJECT = 'longmemeval-bench';
const BENCH_COLLECTION = 'longmemeval-bench_agent_memory';
const RESULTS_DIR = path.join(__dirname, 'batch-results');

interface QdrantPoint {
  id: string;
  payload: Record<string, unknown>;
  vector?: number[] | Record<string, unknown>;
}

async function qdrantGet(path: string): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${path}`);
  if (!res.ok) throw new Error(`Qdrant ${path}: ${res.status}`);
  return res.json();
}

async function qdrantPut(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant PUT ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function qdrantDelete(path: string): Promise<void> {
  const res = await fetch(`${QDRANT_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Qdrant DELETE ${path}: ${res.status}`);
}

async function qdrantPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant POST ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings.map((e) => e.slice(0, VECTOR_SIZE));
}

async function countPoints(collection: string): Promise<number> {
  const info = await qdrantGet(`/collections/${collection}`);
  return info.result.points_count ?? 0;
}

async function* scrollStream(collection: string): AsyncGenerator<QdrantPoint[]> {
  let offset: string | null = null;

  while (true) {
    const body: any = { limit: SCROLL_BATCH, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;

    const res = await qdrantPost(`/collections/${collection}/points/scroll`, body);
    const result = res.result;
    const batch: QdrantPoint[] = result.points || [];

    if (batch.length > 0) yield batch;

    if (!result.next_page_offset) break;
    offset = result.next_page_offset;
  }
}

async function createCollectionBM25(name: string): Promise<void> {
  const body: any = {
    vectors: BM25_ENABLED
      ? { dense: { size: VECTOR_SIZE, distance: 'Cosine' } }
      : { size: VECTOR_SIZE, distance: 'Cosine' },
  };

  if (BM25_ENABLED) {
    body.sparse_vectors = { bm25: { modifier: 'idf' } };
  }

  body.optimizers_config = { default_segment_number: 2 };

  await qdrantPut(`/collections/${name}`, body);
}

async function embedAndUpsertBatch(
  collection: string,
  scrollBatch: QdrantPoint[],
  processedOffset: number
): Promise<number> {
  let upserted = 0;

  // Process the scroll batch in embed-sized sub-batches
  for (let i = 0; i < scrollBatch.length; i += BATCH_SIZE) {
    const chunk = scrollBatch.slice(i, i + BATCH_SIZE);

    const texts = chunk.map((p) =>
      String(p.payload?.content || p.payload?.text || '').slice(0, 8000)
    );
    const validIndices = texts.map((t, j) => (t.length > 0 ? j : -1)).filter((j) => j >= 0);

    if (validIndices.length === 0) continue;

    try {
      const embeddings = await embedBatch(validIndices.map((j) => texts[j]));

      const newPoints = validIndices.map((j, k) => {
        const point = chunk[j];
        const embedding = embeddings[k];
        const newPoint: any = { id: point.id, payload: point.payload };

        if (BM25_ENABLED) {
          newPoint.vector = {
            dense: embedding,
            bm25: { text: texts[j], model: 'Qdrant/bm25' },
          };
        } else {
          newPoint.vector = embedding;
        }

        return newPoint;
      });

      await qdrantPut(`/collections/${collection}/points`, { points: newPoints });
      upserted += newPoints.length;
    } catch (err: any) {
      console.log(`  EMBED ERROR at offset ${processedOffset + i}: ${err.message?.slice(0, 80)}`);
    }
  }

  return upserted;
}

async function reindexCollection(
  collection: string,
  dryRun: boolean
): Promise<{ points: number; duration: number }> {
  const startTime = Date.now();

  // 1. Check total count (for progress display only — no data loaded into memory)
  const totalEstimate = await countPoints(collection);
  if (totalEstimate === 0) {
    console.log(`  Empty collection, skipping`);
    return { points: 0, duration: 0 };
  }
  console.log(`  ${totalEstimate.toLocaleString()} points to process (streaming)`);

  if (dryRun) {
    console.log(`  [DRY RUN] Would re-embed ${totalEstimate.toLocaleString()} points`);
    return { points: totalEstimate, duration: Date.now() - startTime };
  }

  // 2. Snapshot points via scrollStream BEFORE dropping the collection.
  //    We scroll from the OLD collection and write into the NEW (temp) collection,
  //    then rename. But Qdrant has no rename — so we stream old → temp, then
  //    drop old, then create new, then stream temp → new. That doubles work.
  //
  //    Simpler: scroll old, accumulate into a temp name, then swap.
  //    Even simpler for memory safety: scroll old → write to a *temp* collection
  //    in the same loop, then drop old and rename temp.
  //
  //    Use temp collection name to avoid losing data if process crashes.

  const tempCollection = `${collection}_reindex_tmp`;

  // Clean up any previous failed temp collection
  try {
    await qdrantDelete(`/collections/${tempCollection}`);
  } catch {
    // Ignore — doesn't exist
  }

  // 3. Create temp collection
  console.log(`  Creating temp collection${BM25_ENABLED ? ' (BM25)' : ''}...`);
  await createCollectionBM25(tempCollection);
  await new Promise((r) => setTimeout(r, 500));

  // 4. Stream scroll → embed → upsert into temp collection
  let processed = 0;
  let upserted = 0;

  for await (const scrollBatch of scrollStream(collection)) {
    const batchUpserted = await embedAndUpsertBatch(tempCollection, scrollBatch, processed);
    upserted += batchUpserted;
    processed += scrollBatch.length;

    if (processed % (SCROLL_BATCH * 5) === 0 || processed >= totalEstimate) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const eta = (totalEstimate - processed) / Math.max(rate, 0.1);
      console.log(
        `  ${processed.toLocaleString()}/${totalEstimate.toLocaleString()} scrolled, ${upserted.toLocaleString()} upserted (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`
      );
    }
  }

  // 5. Drop old collection, recreate with final name, stream from temp (with vectors)
  console.log(`  Swapping: dropping old collection and promoting temp...`);
  await qdrantDelete(`/collections/${collection}`);
  await createCollectionBM25(collection);
  await new Promise((r) => setTimeout(r, 500));

  let finalUpserted = 0;
  let tempOffset: string | null = null;

  while (true) {
    const scrollBody: any = {
      limit: SCROLL_BATCH,
      with_payload: true,
      with_vector: true,
    };
    if (tempOffset) scrollBody.offset = tempOffset;

    const scrollRes = await qdrantPost(`/collections/${tempCollection}/points/scroll`, scrollBody);
    const scrollResult = scrollRes.result;
    const batch: Array<{ id: string; vector: any; payload: Record<string, unknown> }> =
      scrollResult.points || [];

    if (batch.length > 0) {
      await qdrantPut(`/collections/${collection}/points`, { points: batch });
      finalUpserted += batch.length;

      if (finalUpserted % (SCROLL_BATCH * 5) === 0) {
        console.log(`  Finalizing: ${finalUpserted.toLocaleString()} points copied`);
      }
    }

    if (!scrollResult.next_page_offset) break;
    tempOffset = scrollResult.next_page_offset;
  }

  // 6. Drop temp collection
  await qdrantDelete(`/collections/${tempCollection}`);

  const duration = Date.now() - startTime;
  console.log(`  Done: ${finalUpserted.toLocaleString()} points, ${(duration / 1000).toFixed(0)}s`);
  return { points: finalUpserted, duration };
}

/**
 * Re-ingest longmemeval-bench_agent_memory from Anthropic Batch API results.
 * Use this when the collection was dropped (0 points) and needs to be repopulated
 * from the original batch extraction results.
 */
async function reingestBench(): Promise<void> {
  const metaPath = path.join(RESULTS_DIR, 'batch-meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(
      `batch-meta.json not found at ${metaPath}. Run longmemeval-ingest-batch.ts --submit first.`
    );
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const batchIds: string[] = meta.batchIds;
  console.log(`Re-ingesting from ${batchIds.length} batch(es) (${meta.totalSessions} sessions)`);

  // Ensure collection exists (it may be empty after a failed reindex run)
  const info = await qdrantGet(`/collections/${BENCH_COLLECTION}`).catch(() => null);
  if (!info) {
    console.log(`  Creating collection ${BENCH_COLLECTION}...`);
    await createCollectionBM25(BENCH_COLLECTION);
    await new Promise((r) => setTimeout(r, 500));
  } else {
    const existingPoints = info.result?.points_count ?? 0;
    if (existingPoints > 0) {
      console.log(`  Collection already has ${existingPoints.toLocaleString()} points.`);
      console.log(`  If you want to re-ingest, drop the collection first.`);
      return;
    }
    console.log(`  Collection exists but is empty — proceeding with re-ingest.`);
  }

  const client = new Anthropic();
  const startTime = Date.now();

  // Buffer facts and flush in batches of 200 to embed+upsert
  type FactItem = { content: string; payload: Record<string, unknown> };
  const buffer: FactItem[] = [];
  let totalFacts = 0;
  let totalSessions = 0;
  let errors = 0;

  async function flushBuffer(force = false) {
    while (buffer.length >= SCROLL_BATCH || (force && buffer.length > 0)) {
      const chunk = buffer.splice(0, SCROLL_BATCH);
      const texts = chunk.map((f) => f.content.slice(0, 8000));

      try {
        const embeddings = await embedBatch(texts);
        const points = chunk.map((f, k) => {
          const newPoint: any = { id: crypto.randomUUID(), payload: f.payload };
          if (BM25_ENABLED) {
            newPoint.vector = {
              dense: embeddings[k],
              bm25: { text: texts[k], model: 'Qdrant/bm25' },
            };
          } else {
            newPoint.vector = embeddings[k];
          }
          return newPoint;
        });

        await qdrantPut(`/collections/${BENCH_COLLECTION}/points`, { points });
      } catch (err: any) {
        console.log(`  EMBED/UPSERT ERROR: ${err.message?.slice(0, 80)}`);
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
          const facts = block.text
            .split('\n')
            .map((l: string) => l.replace(/^\d+[\.\)]\s*/, '').trim())
            .filter((l: string) => l.length > 10 && !l.startsWith('Here'));

          for (const fact of facts) {
            buffer.push({
              content: fact,
              payload: {
                content: fact,
                type: 'insight',
                tags: [result.custom_id, 'extracted-fact'],
                projectName: BENCH_PROJECT,
                createdAt: new Date().toISOString(),
              },
            });
          }
          totalFacts += facts.length;
        }
      } else {
        errors++;
        if (errors <= 5) console.log(`  Error for ${result.custom_id}: ${result.result.type}`);
      }

      if (buffer.length >= SCROLL_BATCH) {
        await flushBuffer();
      }

      if (totalSessions % 1000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = totalFacts / elapsed;
        console.log(
          `  ${totalSessions} sessions, ${totalFacts.toLocaleString()} facts (${rate.toFixed(0)} facts/s)`
        );
      }
    }
  }

  // Final flush
  await flushBuffer(true);

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\nRe-ingest complete:`);
  console.log(`  Sessions: ${totalSessions.toLocaleString()}`);
  console.log(`  Facts: ${totalFacts.toLocaleString()}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Duration: ${duration.toFixed(0)}s`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipLarge = args.includes('--skip-large');
  const includeBench = args.includes('--include-bench');
  const reingestBenchFlag = args.includes('--reingest-bench');
  const targetCollection = args.find((a) => a.startsWith('--collection='))?.split('=')[1];

  console.log(`Re-Index Script`);
  console.log(`  Model: ${OLLAMA_MODEL}`);
  console.log(`  Vector size: ${VECTOR_SIZE}`);
  console.log(`  BM25: ${BM25_ENABLED}`);
  console.log(`  Dry run: ${dryRun}`);

  // Short-circuit: re-ingest bench collection from Anthropic Batch API results
  if (reingestBenchFlag) {
    await reingestBench();
    return;
  }

  // List all collections
  const collectionsRes = await qdrantGet('/collections');
  const allCollections: string[] = collectionsRes.result.collections.map((c: any) => c.name);

  // Filter collections
  let collections = allCollections.filter((name) => {
    // Skip utility collections
    if (SKIP_PATTERNS.some((p) => name.endsWith(p) || name.startsWith('_'))) return false;
    // Skip benchmark unless --include-bench
    if (!includeBench && (name.includes('longmemeval') || name.includes('locomo'))) return false;
    // Skip large collections if --skip-large (>50K points)
    return true;
  });

  if (targetCollection) {
    collections = collections.filter((c) => c === targetCollection);
  }

  // Sort: smaller collections first
  const collectionInfos = await Promise.all(
    collections.map(async (name) => {
      const info = await qdrantGet(`/collections/${name}`);
      return { name, points: info.result.points_count };
    })
  );
  collectionInfos.sort((a, b) => a.points - b.points);

  if (skipLarge) {
    const before = collectionInfos.length;
    const filtered = collectionInfos.filter((c) => c.points <= 50000);
    console.log(`  Skipping ${before - filtered.length} large collections (>50K points)`);
    collectionInfos.splice(0, collectionInfos.length, ...filtered);
  }

  const totalPoints = collectionInfos.reduce((s, c) => s + c.points, 0);
  console.log(`\n  Collections to re-index: ${collectionInfos.length}`);
  console.log(`  Total points: ${totalPoints.toLocaleString()}`);
  console.log();

  let totalReindexed = 0;
  let totalDuration = 0;

  for (const { name, points } of collectionInfos) {
    console.log(`\n[${name}] (${points} points)`);
    try {
      const result = await reindexCollection(name, dryRun);
      totalReindexed += result.points;
      totalDuration += result.duration;
    } catch (err: any) {
      console.error(`  FAILED: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Re-index complete:`);
  console.log(`  Collections: ${collectionInfos.length}`);
  console.log(`  Points re-embedded: ${totalReindexed.toLocaleString()}`);
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error(`Re-index failed: ${err.message}`);
  process.exit(1);
});
