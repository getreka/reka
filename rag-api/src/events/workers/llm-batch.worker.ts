/**
 * llm-batch worker (M4-3) — drives Anthropic Message Batches to completion.
 *
 * Processes `batch:poll` jobs:
 *  - batch not ended → re-enqueue itself with a doubled delay (60s→300s cap);
 *    hard stop 24h after submit → treat every row as expired.
 *  - batch ended → iterate results:
 *      succeeded               → recordUsage(batch:true) + enqueue the row's
 *                                continuation job (named in the envelope)
 *      errored invalid_request → DLQ, no retry (+ failure continuation)
 *      errored (server-side) / canceled / expired
 *                              → resubmit those rows in a fresh batch,
 *                                attempts ≤ 3; beyond that → terminal failure
 *
 * Continuation payloads always carry the batchId (Redis-flush recovery —
 * Anthropic keeps results 29 days).
 */

import { createWorker, getQueue } from '../queues';
import { logger } from '../../utils/logger';
import config from '../../config';
import {
  anthropicBatch,
  recordBatchRowUsage,
  BATCH_HARD_STOP_MS,
  BATCH_MAX_POLL_DELAY_MS,
  BATCH_MAX_ROW_ATTEMPTS,
  type BatchPollJobData,
  type BatchRowEnvelope,
} from '../../services/anthropic-batch';

const CONTINUATION_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 50,
} as const;

/** Extract concatenated text blocks from a batch row's Message. */
function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Terminal failure: record in the dead-letter queue and fire the failure continuation. */
async function handleTerminalRowFailure(
  data: BatchPollJobData,
  row: BatchRowEnvelope,
  reason: string
): Promise<void> {
  logger.warn('llm-batch row terminally failed', {
    batchId: data.batchId,
    customId: row.customId,
    reason,
    attempts: row.attempts,
  });

  recordBatchRowUsage({
    model: config.ANTHROPIC_MODEL,
    durationMs: Date.now() - Date.parse(data.submittedAt),
    caller: data.caller,
    projectName: row.projectName ?? data.projectName,
    success: false,
    error: reason,
  });

  try {
    await getQueue('dead-letter').add('dlq:llm-batch:row', {
      originalQueue: 'llm-batch',
      batchId: data.batchId,
      customId: row.customId,
      caller: data.caller,
      projectName: row.projectName ?? data.projectName,
      reason,
      attempts: row.attempts,
      request: row.request,
      droppedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.error('Failed to record llm-batch row in DLQ', { error: err.message });
  }

  if (row.failureContinuation) {
    await getQueue(row.failureContinuation.queue).add(
      row.failureContinuation.jobName,
      {
        ...row.failureContinuation.payload,
        batchId: data.batchId,
        customId: row.customId,
        reason,
      },
      CONTINUATION_JOB_OPTS
    );
  }
}

/**
 * Route a non-succeeded row: resubmit while attempts < BATCH_MAX_ROW_ATTEMPTS,
 * otherwise terminal failure.
 */
async function resubmitOrFail(
  data: BatchPollJobData,
  rows: BatchRowEnvelope[],
  reasonByCustomId: Map<string, string>
): Promise<void> {
  const toResubmit: BatchRowEnvelope[] = [];

  for (const row of rows) {
    const reason = reasonByCustomId.get(row.customId) ?? 'unknown';
    if (row.attempts < BATCH_MAX_ROW_ATTEMPTS) {
      toResubmit.push({ ...row, attempts: row.attempts + 1 });
    } else {
      await handleTerminalRowFailure(data, row, `${reason} (attempts exhausted)`);
    }
  }

  if (toResubmit.length > 0) {
    logger.info('llm-batch resubmitting rows', {
      batchId: data.batchId,
      rows: toResubmit.length,
      caller: data.caller,
    });
    await anthropicBatch.submit({
      caller: data.caller,
      projectName: data.projectName,
      rows: toResubmit,
    });
  }
}

/**
 * Job processor for the llm-batch queue, extracted (same pattern as
 * session-lifecycle.worker.ts) so it can be unit-tested without a live
 * Redis/BullMQ Worker.
 */
export async function processLlmBatchJob(job: { name: string; data: unknown }): Promise<void> {
  if (job.name !== 'batch:poll') {
    logger.warn(`llm-batch worker received unknown job: ${job.name}`);
    return;
  }

  const data = job.data as BatchPollJobData;
  const submittedAtMs = Date.parse(data.submittedAt);
  const pastHardStop = Date.now() - submittedAtMs >= BATCH_HARD_STOP_MS;

  const batch = await anthropicBatch.retrieve(data.batchId);

  if (batch.processing_status !== 'ended') {
    if (pastHardStop) {
      // 24h hard stop: treat every row as expired (resubmit ≤3 / terminal).
      logger.warn('llm-batch hard stop (24h) reached — treating batch as expired', {
        batchId: data.batchId,
        status: batch.processing_status,
      });
      const reasons = new Map(data.rows.map((r) => [r.customId, 'expired (24h hard stop)']));
      await resubmitOrFail(data, data.rows, reasons);
      return;
    }

    // Re-enqueue self with doubled, capped delay.
    const nextDelay = Math.min(data.pollDelayMs * 2, BATCH_MAX_POLL_DELAY_MS);
    await anthropicBatch.enqueuePoll({ ...data, pollDelayMs: nextDelay }, nextDelay);
    logger.debug('llm-batch still processing — re-enqueued poll', {
      batchId: data.batchId,
      nextDelayMs: nextDelay,
    });
    return;
  }

  // Batch ended — iterate results and dispatch per row.
  const rowsById = new Map(data.rows.map((r) => [r.customId, r]));
  const seen = new Set<string>();
  const failedRows: BatchRowEnvelope[] = [];
  const failureReasons = new Map<string, string>();
  const elapsedMs = Date.now() - submittedAtMs;

  const results = await anthropicBatch.results(data.batchId);
  for await (const result of results) {
    const row = rowsById.get(result.custom_id);
    if (!row) {
      logger.warn('llm-batch result for unknown row — skipping', {
        batchId: data.batchId,
        customId: result.custom_id,
      });
      continue;
    }
    seen.add(result.custom_id);

    switch (result.result.type) {
      case 'succeeded': {
        const message = result.result.message;
        recordBatchRowUsage({
          model: message.model ?? config.ANTHROPIC_MODEL,
          usage: {
            promptTokens: message.usage?.input_tokens ?? 0,
            completionTokens: message.usage?.output_tokens ?? 0,
            cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? undefined,
            cacheReadTokens: message.usage?.cache_read_input_tokens ?? undefined,
          },
          durationMs: elapsedMs,
          caller: data.caller,
          projectName: row.projectName ?? data.projectName,
        });

        await getQueue(row.continuation.queue).add(
          row.continuation.jobName,
          {
            ...row.continuation.payload,
            batchId: data.batchId,
            customId: row.customId,
            resultText: extractText(message),
          },
          CONTINUATION_JOB_OPTS
        );
        break;
      }

      case 'errored': {
        const errType = result.result.error?.error?.type ?? 'unknown_error';
        const errMessage =
          (result.result.error?.error as { message?: string } | undefined)?.message ?? '';
        if (errType === 'invalid_request_error') {
          // Invalid request: resubmitting the same params can never succeed → DLQ, no retry.
          await handleTerminalRowFailure(data, row, `invalid_request: ${errMessage}`);
        } else {
          // Server-side errors (api_error, overloaded, rate_limit, timeout…) are retryable.
          failedRows.push(row);
          failureReasons.set(row.customId, `errored: ${errType}`);
        }
        break;
      }

      case 'canceled':
      case 'expired': {
        failedRows.push(row);
        failureReasons.set(row.customId, result.result.type);
        break;
      }
    }
  }

  // Defensive: rows missing from the results stream are treated as expired.
  for (const row of data.rows) {
    if (!seen.has(row.customId)) {
      failedRows.push(row);
      failureReasons.set(row.customId, 'missing from results');
    }
  }

  if (failedRows.length > 0) {
    await resubmitOrFail(data, failedRows, failureReasons);
  }
}

export function startLlmBatchWorker(): void {
  createWorker('llm-batch', (job) => processLlmBatchJob(job), { concurrency: 1 });
  logger.info('LLM batch worker started');
}
