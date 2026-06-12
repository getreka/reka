/**
 * Anthropic Message Batches service (M4-3).
 *
 * Thin wrapper around `client.messages.batches.{create,retrieve,results}` on
 * SDK 0.78 (verified sufficient — no SDK bump). Productionizes the working
 * pattern from `src/scripts/longmemeval-ingest-batch.ts`:
 *
 *  - `submit()` creates a batch and enqueues a `batch:poll` job on the
 *    `llm-batch` BullMQ queue. The poll job re-enqueues itself with a
 *    60s→300s capped delay until the batch ends (hard stop 24h from submit).
 *  - Each row carries an ENVELOPE: the original request (so failed rows can
 *    be resubmitted), a continuation job (enqueued with the result text on
 *    success) and an optional failure continuation (enqueued on terminal
 *    failure). The batchId is persisted into every continuation payload so a
 *    Redis flush is recoverable — Anthropic keeps batch results for 29 days.
 *  - Usage is recorded per row with `batch: true` so `{project}_llm_usage`
 *    reflects the 50% Batches discount (M1 plumbing in llm-usage-logger).
 *
 * Requests use `output_config.format` json_schema (structured outputs) when a
 * schema is supplied — consumers must parse strictly, never regex-salvage.
 * Sampling params and `thinking` are never sent (consistent with llm.ts:
 * sampling 400s on current models; consolidation runs without thinking).
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../config';
import { logger } from '../utils/logger';
import { llmUsageLogger } from './llm-usage-logger';
import { llmRequestsTotal, llmTokensUsed, llmDuration } from '../utils/metrics';
import { getQueue, type QueueName } from '../events/queues';
import type { EffortLevel } from './llm';

// ── Tunables ──────────────────────────────────────────────

/** Delay before the first poll after submit. */
export const BATCH_INITIAL_POLL_DELAY_MS = 60_000;
/** Poll delay doubles each round, capped here (60s → 120s → 240s → 300s → …). */
export const BATCH_MAX_POLL_DELAY_MS = 300_000;
/** Hard stop: a batch not ended 24h after submit is treated as expired. */
export const BATCH_HARD_STOP_MS = 24 * 60 * 60 * 1000;
/** Max submissions per row (initial submit counts as attempt 1). */
export const BATCH_MAX_ROW_ATTEMPTS = 3;

// ── Types ─────────────────────────────────────────────────

export interface BatchRequestSpec {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  /** output_config.format json_schema — server-enforced structured output. */
  jsonSchema?: Record<string, unknown>;
  /** output_config.effort — defaults to config.CLAUDE_EFFORT. */
  effort?: EffortLevel;
}

export interface BatchContinuation {
  queue: QueueName;
  jobName: string;
  payload: Record<string, unknown>;
}

export interface BatchRowEnvelope {
  customId: string;
  /** Original request — kept so server-error/canceled/expired rows can be resubmitted. */
  request: BatchRequestSpec;
  /** Enqueued (with batchId/customId/resultText merged in) when the row succeeds. */
  continuation: BatchContinuation;
  /** Enqueued (with batchId/customId/reason merged in) on terminal failure. */
  failureContinuation?: BatchContinuation;
  /** Submissions so far — initial submit = 1; resubmits increment. */
  attempts: number;
  /** Per-row usage attribution (overrides the envelope-level projectName). */
  projectName?: string;
}

export interface BatchPollJobData {
  batchId: string;
  caller: string;
  projectName?: string;
  /** ISO timestamp of the batches.create call — 24h hard-stop reference. */
  submittedAt: string;
  /** Delay used to schedule THIS poll; the next re-enqueue doubles it (capped). */
  pollDelayMs: number;
  rows: BatchRowEnvelope[];
}

export type BatchRowInput = Omit<BatchRowEnvelope, 'attempts'> & { attempts?: number };

// ── Usage recording (M1 plumbing: batch:true + caller) ────

export function recordBatchRowUsage(opts: {
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  durationMs: number;
  caller: string;
  projectName?: string;
  success?: boolean;
  error?: string;
}): void {
  const status = opts.success === false ? 'error' : 'success';
  llmRequestsTotal.inc({ provider: 'anthropic', model: opts.model, status });
  llmDuration.observe({ provider: 'anthropic', model: opts.model }, opts.durationMs / 1000);
  if (opts.usage) {
    llmTokensUsed.inc(
      { provider: 'anthropic', model: opts.model, type: 'input' },
      opts.usage.promptTokens || 0
    );
    llmTokensUsed.inc(
      { provider: 'anthropic', model: opts.model, type: 'output' },
      opts.usage.completionTokens || 0
    );
    if (opts.usage.cacheCreationTokens) {
      llmTokensUsed.inc(
        { provider: 'anthropic', model: opts.model, type: 'cache_write' },
        opts.usage.cacheCreationTokens
      );
    }
    if (opts.usage.cacheReadTokens) {
      llmTokensUsed.inc(
        { provider: 'anthropic', model: opts.model, type: 'cache_read' },
        opts.usage.cacheReadTokens
      );
    }
  }

  llmUsageLogger.record({
    provider: 'anthropic',
    model: opts.model,
    promptTokens: opts.usage?.promptTokens,
    completionTokens: opts.usage?.completionTokens,
    cacheCreationTokens: opts.usage?.cacheCreationTokens,
    cacheReadTokens: opts.usage?.cacheReadTokens,
    durationMs: opts.durationMs,
    caller: opts.caller,
    projectName: opts.projectName,
    thinking: false,
    success: opts.success,
    error: opts.error,
    batch: true,
  });
}

// ── Service ───────────────────────────────────────────────

class AnthropicBatchService {
  private client: Anthropic | null = null;

  constructor() {
    if (config.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private requireClient(): Anthropic {
    if (!this.client) {
      throw new Error('Anthropic API key not configured — Batches API unavailable');
    }
    return this.client;
  }

  /**
   * Build per-row Messages params. No sampling params, no thinking — see
   * module header. json_schema goes through output_config.format so the
   * output is server-constrained (no regex salvage downstream).
   */
  buildParams(request: BatchRequestSpec): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: config.ANTHROPIC_MODEL,
      max_tokens: request.maxTokens ?? 2000,
      messages: [{ role: 'user', content: request.prompt }],
    };
    if (request.systemPrompt) {
      params.system = request.systemPrompt;
    }
    const outputConfig: Anthropic.OutputConfig = {
      // 'xhigh' is valid on Opus 4.7+ but absent from the 0.78 SDK enum — cast (same as llm.ts).
      effort: (request.effort ?? config.CLAUDE_EFFORT) as Anthropic.OutputConfig['effort'],
    };
    if (request.jsonSchema) {
      outputConfig.format = { type: 'json_schema', schema: request.jsonSchema };
    }
    params.output_config = outputConfig;
    return params;
  }

  /**
   * Create a batch from the given rows and schedule the first `batch:poll`.
   * Throws if batches.create fails — callers own their fallback.
   */
  async submit(opts: {
    caller: string;
    projectName?: string;
    rows: BatchRowInput[];
  }): Promise<{ batchId: string }> {
    if (opts.rows.length === 0) {
      throw new Error('anthropicBatch.submit called with zero rows');
    }
    const client = this.requireClient();

    const requests = opts.rows.map((row) => ({
      custom_id: row.customId,
      params: this.buildParams(row.request),
    }));

    const batch = await client.messages.batches.create({ requests });

    const rows: BatchRowEnvelope[] = opts.rows.map((row) => ({
      ...row,
      attempts: row.attempts ?? 1,
    }));

    await this.enqueuePoll(
      {
        batchId: batch.id,
        caller: opts.caller,
        projectName: opts.projectName,
        submittedAt: new Date().toISOString(),
        pollDelayMs: BATCH_INITIAL_POLL_DELAY_MS,
        rows,
      },
      BATCH_INITIAL_POLL_DELAY_MS
    );

    logger.info('Anthropic batch submitted', {
      batchId: batch.id,
      rows: rows.length,
      caller: opts.caller,
      model: config.ANTHROPIC_MODEL,
    });

    return { batchId: batch.id };
  }

  /** Schedule a `batch:poll` job on the llm-batch queue. */
  async enqueuePoll(data: BatchPollJobData, delayMs: number): Promise<void> {
    const queue = getQueue('llm-batch');
    await queue.add('batch:poll', data, {
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  async retrieve(batchId: string): Promise<Anthropic.Messages.Batches.MessageBatch> {
    return this.requireClient().messages.batches.retrieve(batchId);
  }

  async results(
    batchId: string
  ): Promise<AsyncIterable<Anthropic.Messages.Batches.MessageBatchIndividualResponse>> {
    return this.requireClient().messages.batches.results(batchId);
  }
}

export const anthropicBatch = new AnthropicBatchService();
export default anthropicBatch;
