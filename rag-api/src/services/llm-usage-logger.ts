/**
 * LLM Usage Logger — Buffer LLM call metadata and flush to storage.
 *
 * Tracks: provider, model, tokens, duration, caller context.
 * Flushes every 30s or when buffer reaches threshold.
 * Stores in Qdrant `{project}_llm_usage` collection (no vectors, payload-only).
 */

import { vectorStore } from './vector-store';
import { logger } from '../utils/logger';
import config from '../config';

export interface LLMUsageEntry {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheCreationTokens: number; // Anthropic prompt-cache write tokens (~1.25x cost)
  cacheReadTokens: number; // Anthropic prompt-cache read tokens (~0.1x cost)
  durationMs: number;
  caller: string; // e.g. 'consolidation', 'memory-merge', 'tribunal-judge', 'agent-loop'
  projectName?: string;
  timestamp: string;
  thinking: boolean;
  success: boolean;
  error?: string;
  batch?: boolean; // true when served via the Batches API (50% discount on all token classes)
}

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;

// ── Model Pricing ───────────────────────────────────────────
//
// Per-model [input, output] USD price per 1M tokens. Single source of truth for
// model cost knowledge across the codebase (tribunal, future cost dashboards, etc.).
const PRICING: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [3, 15],
  'claude-opus-4-8': [5, 25],
  'claude-fable-5': [10, 50],
  'claude-haiku-4-5': [1, 5],
};

// Anthropic prompt-cache multipliers relative to the base input price:
//   - cache WRITE (cache_creation) costs ~1.25x the input rate
//   - cache READ  (cache_read)     costs ~0.1x  the input rate
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Anthropic Batches API: 50% discount applied to ALL token classes.
const BATCH_MULTIPLIER = 0.5;

/**
 * Compute USD cost for a single model call from token counts. Unknown Anthropic models
 * fall back to Sonnet pricing. Cache tokens are priced relative to the input rate
 * (write ~1.25x, read ~0.1x) so prompt-caching savings/costs are reflected exactly.
 * `{batch: true}` applies the Batches API 50% discount to every token class.
 *
 * Note: `promptTokens` should be the *uncached* input tokens — Anthropic bills cache
 * creation/read tokens separately, so they are NOT also counted as prompt tokens.
 */
export function modelCostUsd(
  model: string,
  tokens: {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  },
  opts: { batch?: boolean } = {}
): number {
  const [inputPer1M, outputPer1M] = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
  const { promptTokens, completionTokens, cacheCreationTokens = 0, cacheReadTokens = 0 } = tokens;
  const batchMultiplier = opts.batch ? BATCH_MULTIPLIER : 1;

  return (
    ((promptTokens / 1_000_000) * inputPer1M +
      (completionTokens / 1_000_000) * outputPer1M +
      (cacheCreationTokens / 1_000_000) * inputPer1M * CACHE_WRITE_MULTIPLIER +
      (cacheReadTokens / 1_000_000) * inputPer1M * CACHE_READ_MULTIPLIER) *
    batchMultiplier
  );
}

// ── Usage Summary (read side of {project}_llm_usage) ───────

export interface LLMUsageBucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface LLMUsageSummary {
  project: string;
  from?: string;
  to?: string;
  failures: number;
  totals: LLMUsageBucket;
  byModel: Record<string, LLMUsageBucket>;
}

function emptyBucket(): LLMUsageBucket {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

// Safety cap when scrolling {project}_llm_usage (100 pages × 1000 points).
const SUMMARY_MAX_PAGES = 100;

class LLMUsageLogger {
  private buffer: LLMUsageEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Log a single LLM call.
   */
  log(entry: LLMUsageEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Convenience: create an entry from common fields.
   */
  record(opts: {
    provider: string;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    durationMs: number;
    caller: string;
    projectName?: string;
    thinking?: boolean;
    success?: boolean;
    error?: string;
    batch?: boolean;
  }): void {
    this.log({
      provider: opts.provider,
      model: opts.model,
      promptTokens: opts.promptTokens || 0,
      completionTokens: opts.completionTokens || 0,
      totalTokens: (opts.promptTokens || 0) + (opts.completionTokens || 0),
      cacheCreationTokens: opts.cacheCreationTokens || 0,
      cacheReadTokens: opts.cacheReadTokens || 0,
      durationMs: opts.durationMs,
      caller: opts.caller,
      projectName: opts.projectName,
      timestamp: new Date().toISOString(),
      thinking: opts.thinking || false,
      success: opts.success !== false,
      error: opts.error,
      batch: opts.batch,
    });
  }

  /**
   * Flush buffer to Qdrant (payload-only, no vectors).
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;

    const entries = this.buffer.splice(0);
    const count = entries.length;

    try {
      // Group by project
      const byProject = new Map<string, LLMUsageEntry[]>();
      for (const entry of entries) {
        const project = entry.projectName || '_global';
        if (!byProject.has(project)) byProject.set(project, []);
        byProject.get(project)!.push(entry);
      }

      for (const [project, projectEntries] of byProject) {
        const collectionName = `${project}_llm_usage`;

        // Ensure collection exists
        try {
          await vectorStore.ensureCollection(collectionName);
        } catch {
          // Collection may already exist
        }

        const zeroVector = new Array(config.VECTOR_SIZE).fill(0);
        const points = projectEntries.map((entry) => ({
          vector: zeroVector,
          payload: entry as unknown as Record<string, unknown>,
        }));

        await vectorStore.upsert(collectionName, points);
      }

      logger.debug(`LLM usage flushed: ${count} entries`);
      return count;
    } catch (error: any) {
      logger.warn('LLM usage flush failed, entries lost', { error: error.message, count });
      return 0;
    }
  }

  /**
   * Summarize a project's LLM usage from its `{project}_llm_usage` collection:
   * request/token totals plus a per-model breakdown, optionally bounded by an
   * ISO-8601 date range. Flushes the in-memory buffer first so just-recorded
   * calls are visible. Cost is computed for Anthropic entries only — local
   * (Ollama) usage is $0 and there is no OpenAI pricing table.
   */
  async summarize(
    projectName: string,
    range: { from?: string; to?: string } = {}
  ): Promise<LLMUsageSummary> {
    await this.flush();

    const collection = `${projectName}_llm_usage`;
    const fromTs = range.from ? Date.parse(range.from) : undefined;
    const toTs = range.to ? Date.parse(range.to) : undefined;

    const totals = emptyBucket();
    const byModel: Record<string, LLMUsageBucket> = {};
    let failures = 0;

    let offset: string | undefined;
    let pages = 0;
    do {
      const { points, nextOffset } = await vectorStore.scrollCollection(collection, 1000, offset);
      for (const point of points) {
        const entry = point.payload as unknown as LLMUsageEntry;
        const ts = Date.parse(entry.timestamp);
        if (fromTs !== undefined && !(ts >= fromTs)) continue;
        if (toTs !== undefined && !(ts <= toTs)) continue;

        const costUsd =
          entry.provider === 'anthropic'
            ? modelCostUsd(entry.model, entry, { batch: entry.batch })
            : 0;
        const bucket = (byModel[entry.model] ??= emptyBucket());
        for (const b of [totals, bucket]) {
          b.requests += 1;
          b.promptTokens += entry.promptTokens || 0;
          b.completionTokens += entry.completionTokens || 0;
          b.cacheCreationTokens += entry.cacheCreationTokens || 0;
          b.cacheReadTokens += entry.cacheReadTokens || 0;
          b.totalTokens += entry.totalTokens || 0;
          b.costUsd += costUsd;
        }
        if (entry.success === false) failures++;
      }
      offset = nextOffset as string | undefined;
      pages++;
    } while (offset !== undefined && pages < SUMMARY_MAX_PAGES);

    // Round accumulated costs to micro-dollars to drop float noise.
    const round = (b: LLMUsageBucket) => {
      b.costUsd = Math.round(b.costUsd * 1e6) / 1e6;
    };
    round(totals);
    Object.values(byModel).forEach(round);

    return { project: projectName, from: range.from, to: range.to, failures, totals, byModel };
  }

  /**
   * Get buffer stats.
   */
  getStats() {
    return {
      buffered: this.buffer.length,
      flushThreshold: FLUSH_THRESHOLD,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    };
  }

  /**
   * Shutdown — flush remaining entries.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}

export const llmUsageLogger = new LLMUsageLogger();
