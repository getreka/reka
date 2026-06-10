/**
 * CoIR Benchmark Adapter
 *
 * Evaluates code retrieval quality against three CoIR datasets from HuggingFace:
 *   - CosQA:         ~500 queries,  ~21K docs  (natural language → code search)
 *   - APPS:          ~3.8K queries, ~9K docs   (programming problem retrieval)
 *   - StackOverflow: ~2K queries,   ~20K docs  (Q&A retrieval)
 *
 * Each dataset uses BEIR format (queries / corpus / qrels).
 * Embeddings are generated directly via Ollama to avoid RAG API rate limits.
 * Corpus points are upserted into a temporary Qdrant collection per dataset.
 *
 * Metrics computed: NDCG@10, Recall@10, MRR
 *
 * Usage:
 *   npx ts-node src/eval/benchmarks/coir-adapter.ts [--dataset cosqa|apps|stackoverflow] [--skip-index]
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-embedding:4b';
const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '1024', 10);

const EMBED_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 100;
const SEARCH_TOP_K = 10;

const DATA_DIR = path.join(__dirname, '..', 'data', 'coir');
const RESULTS_DIR = path.join(__dirname, '..', 'results');

// ── BenchmarkAdapter interface ─────────────────────────────────────────────
// Defined here until adapter.ts is created by the parallel agent.

export interface BenchmarkCase {
  id: string;
  query: string;
  relevantIds: string[];
  category?: string;
}

export abstract class BenchmarkAdapter {
  abstract name: string;
  abstract level: string;
  abstract prepare(): Promise<void>;
  abstract loadCases(): Promise<BenchmarkCase[]>;
}

// ── BEIR types ─────────────────────────────────────────────────────────────

interface BeirQuery {
  _id: string;
  text: string;
}

interface BeirDoc {
  _id: string;
  text: string;
  title?: string;
}

interface BeirQrel {
  query_id: string;
  corpus_id: string;
  score: number;
}

interface DatasetSpec {
  name: string;
  /** HuggingFace dataset repo that contains both the queries and corpus splits */
  hfQueriesCorpusRepo: string;
  /** HuggingFace dataset repo that contains qrels splits */
  hfQrelsRepo: string;
  /** Split name for qrels (usually "test") */
  qrelsSplit: string;
  collectionName: string;
}

// ── Dataset specs ──────────────────────────────────────────────────────────

const DATASETS: Record<string, DatasetSpec> = {
  cosqa: {
    name: 'cosqa',
    hfQueriesCorpusRepo: 'CoIR-Retrieval/cosqa-queries-corpus',
    hfQrelsRepo: 'CoIR-Retrieval/cosqa-qrels',
    qrelsSplit: 'test',
    collectionName: 'coir-cosqa_codebase',
  },
  apps: {
    name: 'apps',
    hfQueriesCorpusRepo: 'CoIR-Retrieval/apps-queries-corpus',
    hfQrelsRepo: 'CoIR-Retrieval/apps-qrels',
    qrelsSplit: 'test',
    collectionName: 'coir-apps_codebase',
  },
  stackoverflow: {
    name: 'stackoverflow',
    hfQueriesCorpusRepo: 'CoIR-Retrieval/stackoverflow-qa-queries-corpus',
    hfQrelsRepo: 'CoIR-Retrieval/stackoverflow-qa-qrels',
    qrelsSplit: 'test',
    collectionName: 'coir-stackoverflow_codebase',
  },
};

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function httpPostJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function httpPutJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── HuggingFace datasets-server API ───────────────────────────────────────

const HF_ROWS_API = 'https://datasets-server.huggingface.co/rows';
const HF_PAGE_SIZE = 100; // datasets-server max per request

interface HfRowsResponse<T> {
  rows: Array<{ row_idx: number; row: T }>;
  num_rows_total: number;
}

/**
 * Fetch all rows from a HuggingFace dataset split using the rows API.
 * Paginates automatically until all rows are retrieved.
 */
async function fetchHfSplitRows<T>(
  dataset: string,
  split: string,
  cacheFile: string
): Promise<T[]> {
  if (fs.existsSync(cacheFile)) {
    console.log(`  Cache hit: ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as T[];
  }

  const allRows: T[] = [];
  let offset = 0;
  let total: number | null = null;

  console.log(`  Fetching ${dataset} / ${split} ...`);

  while (total === null || offset < total) {
    const url =
      `${HF_ROWS_API}?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${HF_PAGE_SIZE}`;

    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const headers: Record<string, string> = { 'User-Agent': 'rag-eval-coir/1.0' };
      if (process.env.HF_TOKEN) headers['Authorization'] = `Bearer ${process.env.HF_TOKEN}`;
      res = await fetch(url, { headers });
      if (res.ok) break;
      if (res.status === 429 && attempt < 4) {
        const wait = 3000 * (attempt + 1);
        console.log(`    Rate limited, waiting ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      throw new Error(
        `HuggingFace datasets-server failed: ${res.status} ${res.statusText}\n  URL: ${url}\n  Body: ${text.slice(0, 400)}`
      );
    }
    if (!res || !res.ok) throw new Error('HuggingFace fetch failed after retries');

    const data = (await res.json()) as HfRowsResponse<T>;

    if (total === null) {
      total = data.num_rows_total;
      console.log(`    Total rows: ${total}`);
    }

    for (const entry of data.rows) {
      allRows.push(entry.row);
    }

    offset += data.rows.length;

    // Throttle to avoid HF rate limits
    await new Promise((r) => setTimeout(r, 300));

    if (data.rows.length === 0) {
      // Safety: break if the API returns no rows to avoid infinite loop
      break;
    }

    if (offset % 5000 === 0 || offset >= total) {
      console.log(`    Downloaded ${offset}/${total} rows`);
    }
  }

  // Cache to disk
  const cacheDir = path.dirname(cacheFile);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  fs.writeFileSync(cacheFile, JSON.stringify(allRows), 'utf-8');
  console.log(`  Cached to: ${cacheFile}`);

  return allRows;
}

function ensureDataDir(datasetName: string): string {
  const dir = path.join(DATA_DIR, datasetName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── Embedding (Ollama direct) ──────────────────────────────────────────────

/**
 * Embed a batch of texts via Ollama /api/embed.
 * MRL: slice to VECTOR_SIZE dims if model returns larger vectors.
 */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const body = {
    model: OLLAMA_MODEL,
    input: texts,
  };

  const res = (await httpPostJson(`${OLLAMA_URL}/api/embed`, body)) as {
    embeddings: number[][];
  };

  if (!res.embeddings || res.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama embed returned ${res.embeddings?.length ?? 0} vectors for ${texts.length} inputs`
    );
  }

  // MRL truncation: slice to target dimension
  return res.embeddings.map((vec) => vec.slice(0, VECTOR_SIZE));
}

/**
 * Embed all texts in batches of EMBED_BATCH_SIZE, with progress logging.
 */
async function embedAll(texts: string[], label: string): Promise<number[][]> {
  const vectors: number[][] = [];
  const total = texts.length;
  let done = 0;

  for (let i = 0; i < total; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const batchVecs = await embedBatch(batch);
    vectors.push(...batchVecs);
    done += batch.length;

    if (done % 500 === 0 || done === total) {
      console.log(`    [${label}] embedded ${done}/${total}`);
    }
  }

  return vectors;
}

// ── Qdrant operations ──────────────────────────────────────────────────────

async function createCollection(collectionName: string): Promise<void> {
  const url = `${QDRANT_URL}/collections/${collectionName}`;

  // Delete if exists
  try {
    const delRes = await fetch(url, { method: 'DELETE' });
    if (delRes.ok) {
      console.log(`  Deleted existing collection: ${collectionName}`);
    }
  } catch {
    // Ignore delete errors — collection may not exist
  }

  await httpPutJson(url, {
    vectors: {
      size: VECTOR_SIZE,
      distance: 'Cosine',
    },
  });

  console.log(`  Created collection: ${collectionName} (dim=${VECTOR_SIZE})`);
}

interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

async function upsertPoints(collectionName: string, points: QdrantPoint[]): Promise<void> {
  const url = `${QDRANT_URL}/collections/${collectionName}/points`;
  await httpPutJson(url, { points });
}

async function upsertAllDocs(
  collectionName: string,
  docs: BeirDoc[],
  vectors: number[][]
): Promise<void> {
  const total = docs.length;
  let done = 0;

  for (let i = 0; i < total; i += UPSERT_BATCH_SIZE) {
    const batchDocs = docs.slice(i, i + UPSERT_BATCH_SIZE);
    const batchVecs = vectors.slice(i, i + UPSERT_BATCH_SIZE);

    const points: QdrantPoint[] = batchDocs.map((doc, j) => ({
      // Qdrant requires numeric IDs or UUID strings; hash the string ID to a uint64
      id: hashId(doc._id),
      vector: batchVecs[j],
      payload: {
        doc_id: doc._id,
        text: doc.text.slice(0, 2000),
        title: doc.title || '',
      },
    }));

    await upsertPoints(collectionName, points);
    done += batchDocs.length;

    if (done % 1000 === 0 || done === total) {
      console.log(`    Upserted ${done}/${total} points`);
    }
  }
}

/**
 * Deterministic non-cryptographic hash of a string to a positive uint53.
 * Qdrant accepts unsigned integer IDs up to 2^64 but JS safe integers cap at 2^53.
 */
function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h >>>= 0;
  }
  // Ensure positive, fit in JS safe integer range (use only 32 bits)
  return h >>> 0;
}

interface QdrantSearchResult {
  id: number;
  score: number;
  payload: Record<string, unknown>;
}

async function searchCollection(
  collectionName: string,
  queryVector: number[],
  topK: number
): Promise<QdrantSearchResult[]> {
  const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
  const body = {
    vector: queryVector,
    limit: topK,
    with_payload: true,
  };

  const res = (await httpPostJson(url, body)) as { result: QdrantSearchResult[] };
  return res.result || [];
}

// ── Metrics ────────────────────────────────────────────────────────────────

/**
 * NDCG@K — normalized discounted cumulative gain.
 * relevanceMap: corpus_id → relevance score (>=1 means relevant)
 */
function ndcgAtK(retrievedIds: string[], relevanceMap: Map<string, number>, k: number): number {
  const topK = retrievedIds.slice(0, k);

  // DCG
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceMap.get(topK[i]) ?? 0;
    const gain = rel > 0 ? 1 : 0; // binary relevance
    dcg += gain / Math.log2(i + 2); // log2(rank+1), rank is 1-indexed
  }

  // Ideal DCG: sort by relevance descending, take top-K
  const idealRels = Array.from(relevanceMap.values())
    .filter((v) => v > 0)
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Recall@K: fraction of relevant docs found in top-K results.
 */
function recallAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 1;
  const topK = retrievedIds.slice(0, k);
  const found = topK.filter((id) => relevantIds.has(id)).length;
  return found / relevantIds.size;
}

/**
 * MRR: 1/rank of first relevant result (within top-K).
 */
function mrrAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  const topK = retrievedIds.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevantIds.has(topK[i])) return 1 / (i + 1);
  }
  return 0;
}

// ── CoIR dataset adapter ───────────────────────────────────────────────────

interface CoirQueryResult {
  queryId: string;
  queryText: string;
  retrievedIds: string[];
  relevantIds: string[];
  ndcg10: number;
  recall10: number;
  mrr: number;
  latencyMs: number;
}

interface CoirDatasetReport {
  dataset: string;
  timestamp: string;
  totalQueries: number;
  indexedDocs: number;
  meanNdcg10: number;
  meanRecall10: number;
  meanMrr: number;
  latency: { mean: number; p50: number; p95: number; p99: number };
  perQuery: CoirQueryResult[];
}

export class CoirAdapter extends BenchmarkAdapter {
  name = 'coir';
  level = 'corpus';

  private spec: DatasetSpec;
  private queries: BeirQuery[] = [];
  private corpus: BeirDoc[] = [];
  private qrels: BeirQrel[] = [];

  constructor(datasetName: keyof typeof DATASETS = 'cosqa') {
    super();
    const spec = DATASETS[datasetName];
    if (!spec) {
      throw new Error(
        `Unknown CoIR dataset: ${datasetName}. Valid: ${Object.keys(DATASETS).join(', ')}`
      );
    }
    this.spec = spec;
    this.name = `coir-${datasetName}`;
  }

  async prepare(): Promise<void> {
    console.log(`\nPreparing CoIR dataset: ${this.spec.name}`);
    const dataDir = ensureDataDir(this.spec.name);

    const queriesCacheFile = path.join(dataDir, 'queries.json');
    const corpusCacheFile = path.join(dataDir, 'corpus.json');
    const qrelsCacheFile = path.join(dataDir, 'qrels-test.json');

    const [queries, corpus, qrels] = await Promise.all([
      fetchHfSplitRows<BeirQuery>(this.spec.hfQueriesCorpusRepo, 'queries', queriesCacheFile),
      fetchHfSplitRows<BeirDoc>(this.spec.hfQueriesCorpusRepo, 'corpus', corpusCacheFile),
      fetchHfSplitRows<BeirQrel>(this.spec.hfQrelsRepo, this.spec.qrelsSplit, qrelsCacheFile),
    ]);

    this.queries = queries;
    this.corpus = corpus;
    // Keep only qrels with positive relevance score
    this.qrels = qrels.filter((q) => q.score > 0);

    console.log(
      `  Loaded: ${this.queries.length} queries, ${this.corpus.length} docs, ${this.qrels.length} qrels`
    );
  }

  async loadCases(): Promise<BenchmarkCase[]> {
    if (this.queries.length === 0) {
      await this.prepare();
    }

    // Build relevance map: query_id → [corpus_id, ...]
    const queryRelevance = new Map<string, string[]>();
    for (const qrel of this.qrels) {
      if (qrel.score > 0) {
        const list = queryRelevance.get(qrel.query_id) ?? [];
        list.push(qrel.corpus_id);
        queryRelevance.set(qrel.query_id, list);
      }
    }

    return this.queries
      .filter((q) => queryRelevance.has(q._id))
      .map((q) => ({
        id: q._id,
        query: q.text,
        relevantIds: queryRelevance.get(q._id) ?? [],
        category: this.spec.name,
      }));
  }

  getCorpus(): BeirDoc[] {
    return this.corpus;
  }

  getCollectionName(): string {
    return this.spec.collectionName;
  }
}

// ── Index phase ────────────────────────────────────────────────────────────

async function indexCorpus(adapter: CoirAdapter): Promise<void> {
  const corpus = adapter.getCorpus();
  const collectionName = adapter.getCollectionName();

  console.log(`\nIndexing ${corpus.length} docs into ${collectionName}`);

  await createCollection(collectionName);

  // Build text for each doc: title + text
  const docTexts = corpus.map((doc) => {
    const parts: string[] = [];
    if (doc.title) parts.push(doc.title);
    parts.push(doc.text);
    return parts.join('\n').slice(0, 4000); // truncate to reasonable size
  });

  console.log('  Embedding corpus...');
  const vectors = await embedAll(docTexts, 'corpus');

  console.log('  Upserting to Qdrant...');
  await upsertAllDocs(collectionName, corpus, vectors);

  console.log(`  Indexing complete: ${corpus.length} docs`);
}

// ── Retrieval phase ────────────────────────────────────────────────────────

async function runRetrieval(
  cases: BenchmarkCase[],
  collectionName: string
): Promise<CoirQueryResult[]> {
  console.log(`\nRunning retrieval: ${cases.length} queries against ${collectionName}`);

  // Embed all queries in batches
  const queryTexts = cases.map((c) => c.query);
  console.log('  Embedding queries...');
  const queryVectors = await embedAll(queryTexts, 'queries');

  const results: CoirQueryResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const qvec = queryVectors[i];

    const start = Date.now();
    const hits = await searchCollection(collectionName, qvec, SEARCH_TOP_K);
    const latencyMs = Date.now() - start;

    const retrievedIds = hits.map((h) => String(h.payload['doc_id'] ?? ''));
    const relevantSet = new Set(c.relevantIds);

    // Build relevance map for NDCG (binary: 1 if relevant)
    const relMap = new Map<string, number>();
    for (const id of c.relevantIds) relMap.set(id, 1);

    const ndcg10 = ndcgAtK(retrievedIds, relMap, SEARCH_TOP_K);
    const recall10 = recallAtK(retrievedIds, relevantSet, SEARCH_TOP_K);
    const mrr = mrrAtK(retrievedIds, relevantSet, SEARCH_TOP_K);

    results.push({
      queryId: c.id,
      queryText: c.query,
      retrievedIds,
      relevantIds: c.relevantIds,
      ndcg10,
      recall10,
      mrr,
      latencyMs,
    });

    if ((i + 1) % 100 === 0 || i + 1 === cases.length) {
      const runningNdcg = results.reduce((s, r) => s + r.ndcg10, 0) / results.length;
      console.log(
        `    Progress: ${i + 1}/${cases.length} — running NDCG@10=${runningNdcg.toFixed(4)}`
      );
    }
  }

  return results;
}

// ── Report ─────────────────────────────────────────────────────────────────

function buildReport(
  datasetName: string,
  corpus: BeirDoc[],
  perQuery: CoirQueryResult[]
): CoirDatasetReport {
  const n = perQuery.length;
  const meanNdcg10 = perQuery.reduce((s, r) => s + r.ndcg10, 0) / n;
  const meanRecall10 = perQuery.reduce((s, r) => s + r.recall10, 0) / n;
  const meanMrr = perQuery.reduce((s, r) => s + r.mrr, 0) / n;

  const latencies = perQuery.map((r) => r.latencyMs).sort((a, b) => a - b);
  const latency = {
    mean: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
    p99: latencies[Math.floor(latencies.length * 0.99)],
  };

  return {
    dataset: datasetName,
    timestamp: new Date().toISOString(),
    totalQueries: n,
    indexedDocs: corpus.length,
    meanNdcg10,
    meanRecall10,
    meanMrr,
    latency,
    perQuery,
  };
}

function printReport(report: CoirDatasetReport): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CoIR Results — ${report.dataset} (${report.totalQueries} queries)`);
  console.log('='.repeat(60));
  console.log(`  NDCG@10:   ${(report.meanNdcg10 * 100).toFixed(2)}%`);
  console.log(`  Recall@10: ${(report.meanRecall10 * 100).toFixed(2)}%`);
  console.log(`  MRR:       ${report.meanMrr.toFixed(4)}`);
  console.log(
    `  Latency:   mean=${report.latency.mean}ms  p50=${report.latency.p50}ms  p95=${report.latency.p95}ms  p99=${report.latency.p99}ms`
  );
}

function saveReport(report: CoirDatasetReport): string {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const ts = Date.now();
  const outPath = path.join(RESULTS_DIR, `coir-${report.dataset}-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  return outPath;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runDataset(datasetName: string, skipIndex: boolean): Promise<CoirDatasetReport> {
  if (!DATASETS[datasetName]) {
    throw new Error(`Unknown dataset: ${datasetName}. Valid: ${Object.keys(DATASETS).join(', ')}`);
  }

  const adapter = new CoirAdapter(datasetName as keyof typeof DATASETS);
  await adapter.prepare();

  const cases = await adapter.loadCases();
  const corpus = adapter.getCorpus();
  const collectionName = adapter.getCollectionName();

  console.log(`\nDataset: ${datasetName}`);
  console.log(`  Queries with qrels: ${cases.length}`);
  console.log(`  Corpus size:        ${corpus.length}`);
  console.log(`  Collection:         ${collectionName}`);

  if (!skipIndex) {
    await indexCorpus(adapter);
  } else {
    console.log('\nSkipping index phase (--skip-index)');
  }

  const perQuery = await runRetrieval(cases, collectionName);
  const report = buildReport(datasetName, corpus, perQuery);

  printReport(report);

  const outPath = saveReport(report);
  console.log(`\nReport saved: ${outPath}`);

  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const datasetArg =
    args.find((a) => a.startsWith('--dataset='))?.split('=')[1] ||
    (args.includes('--dataset') ? args[args.indexOf('--dataset') + 1] : undefined);

  const skipIndex = args.includes('--skip-index');

  const datasetsToRun = datasetArg ? [datasetArg] : (Object.keys(DATASETS) as string[]);

  console.log('CoIR Benchmark Adapter');
  console.log(`  Datasets:    ${datasetsToRun.join(', ')}`);
  console.log(`  Ollama URL:  ${OLLAMA_URL}`);
  console.log(`  Ollama Model:${OLLAMA_MODEL}`);
  console.log(`  Qdrant URL:  ${QDRANT_URL}`);
  console.log(`  Vector size: ${VECTOR_SIZE}`);
  console.log(`  Skip index:  ${skipIndex}`);

  const allReports: CoirDatasetReport[] = [];

  for (const ds of datasetsToRun) {
    try {
      const report = await runDataset(ds, skipIndex);
      allReports.push(report);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to run dataset ${ds}: ${message}`);
    }
  }

  if (allReports.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('AGGREGATE SUMMARY');
    console.log('='.repeat(60));
    for (const r of allReports) {
      console.log(
        `  ${r.dataset.padEnd(15)} NDCG@10=${(r.meanNdcg10 * 100).toFixed(2)}%  Recall@10=${(r.meanRecall10 * 100).toFixed(2)}%  MRR=${r.meanMrr.toFixed(4)}`
      );
    }
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((err) => {
    console.error('CoIR benchmark failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
