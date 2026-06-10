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
  caller: string; // e.g. 'smart-dispatch', 'agent-runtime', 'review'
  projectName?: string;
  timestamp: string;
  thinking: boolean;
  success: boolean;
  error?: string;
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

/**
 * Compute USD cost for a single model call from token counts. Unknown Anthropic models
 * fall back to Sonnet pricing. Cache tokens are priced relative to the input rate
 * (write ~1.25x, read ~0.1x) so prompt-caching savings/costs are reflected exactly.
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
  }
): number {
  const [inputPer1M, outputPer1M] = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
  const { promptTokens, completionTokens, cacheCreationTokens = 0, cacheReadTokens = 0 } = tokens;

  return (
    (promptTokens / 1_000_000) * inputPer1M +
    (completionTokens / 1_000_000) * outputPer1M +
    (cacheCreationTokens / 1_000_000) * inputPer1M * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) * inputPer1M * CACHE_READ_MULTIPLIER
  );
}

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
