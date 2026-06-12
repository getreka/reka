/**
 * Batch consolidation orchestrator (M4-4, ADR-003).
 *
 * When `CONSOLIDATION_BATCH_ENABLED=true` AND an ANTHROPIC_API_KEY is
 * present, consolidation steps 1-2 (pattern detection, abstraction) run on
 * claude-opus-4-8 (effort 'medium') via the Message Batches API instead of
 * sync Ollama. Flow:
 *
 *   session:ending ──▶ submit():
 *     1. atomic inflight marker (dup-guard — acceptance f)
 *     2. SNAPSHOT WM slots + sensory events into the job payload
 *        (retries/continuations NEVER re-read the 24h-TTL buffer)
 *     3. submit step-1 (pattern detection) with json_schema output
 *     4. WORKING MEMORY CLEARED AT SUBMIT — the payload is self-contained,
 *        so a second session:ending cannot re-snapshot the same slots, and
 *        a stuck batch cannot pin the 20-slot WM for the 24h worst case.
 *
 *   llm-batch worker ──▶ 'consolidation:abstract' (step-1 result):
 *     strict-parse patterns (json_schema output — NO regex salvage),
 *     submit step-2 (abstraction) with the {memories:[...]} schema.
 *
 *   llm-batch worker ──▶ 'consolidation:finalize' (step-2 result):
 *     strict-parse memories, then store/classify/anchor via
 *     consolidationAgent.storeAbstracted (relationship classification
 *     stays sync Ollama in v1). Clears the inflight marker.
 *
 *   terminal failure (invalid_request DLQ / expiry-after-retries)
 *     ──▶ 'consolidation:batch-failed': restore the snapshot into WM
 *     (capacity policy applies) and run the sync Ollama fallback ON THE
 *     SNAPSHOT — no memory loss either way.
 *
 * Fallback: flag off / no key / batches.create throws → callers run the
 * byte-identical sync Ollama path.
 */

import config from '../config';
import { logger } from '../utils/logger';
import { cacheService } from './cache';
import { workingMemory } from './working-memory';
import { sensoryBuffer } from './sensory-buffer';
import {
  consolidationAgent,
  PATTERN_DETECTION_PROMPT,
  ABSTRACTION_PROMPT,
  PATTERN_JSON_SCHEMA,
  MEMORIES_JSON_SCHEMA,
  type ConsolidationSnapshot,
  type ExtractedPattern,
  type AbstractedMemory,
} from './consolidation-agent';
import { anthropicBatch, type BatchRowInput } from './anthropic-batch';

// Inflight marker must outlive the worst case (2 sequential batch round
// trips × 24h hard-stop ≈ 48h) so a late finalize still finds it.
const INFLIGHT_TTL_SECONDS = 50 * 60 * 60;

const CONSOLIDATION_MAX_TOKENS = 2000;
const CONSOLIDATION_EFFORT = 'medium' as const; // ADR-003 / M1 per-call effort
const CALLER = 'consolidation';

export type ConsolidationSubmitOutcome = 'submitted' | 'inflight' | 'empty';

export interface ConsolidationBatchBasePayload {
  projectName: string;
  sessionId: string;
  snapshot: ConsolidationSnapshot;
}

export interface ConsolidationAbstractPayload extends ConsolidationBatchBasePayload {
  /** Step-1 raw output (json_schema-constrained {patterns:[...]}). */
  resultText?: string;
  batchId?: string;
}

export interface ConsolidationFinalizePayload extends ConsolidationBatchBasePayload {
  /** Step-2 raw output (json_schema-constrained {memories:[...]}). */
  resultText?: string;
  batchId?: string;
  /** Step-1 pattern count, carried through for the result/observability. */
  patternsDetected?: number;
}

export interface ConsolidationFailedPayload extends ConsolidationBatchBasePayload {
  reason?: string;
  batchId?: string;
}

/**
 * Strict JSON parse for json_schema-constrained batch outputs. The API
 * guarantees valid JSON matching the schema; anything else (prose-wrapped
 * JSON, markdown fences, truncation) is a hard failure — deliberately NOT
 * regex-salvaged like the Ollama path's parseJson (acceptance e).
 */
function parseStrict<T>(text: string | undefined, rootKey: string): T {
  if (!text) {
    throw new Error(`Batch result missing text for expected "${rootKey}" payload`);
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed[rootKey])) {
    throw new Error(`Batch result JSON lacks required "${rootKey}" array`);
  }
  return parsed as T;
}

class ConsolidationBatchService {
  // Coalescing window state (CONSOLIDATION_BATCH_WINDOW_MS > 0). With the
  // default 0 the buffer is bypassed entirely — batch-of-1 submits inline.
  private pendingRows: BatchRowInput[] = [];
  private windowFlush: Promise<void> | null = null;

  /** Batch path is active only when the flag is on AND a key is present. */
  isEnabled(): boolean {
    return config.CONSOLIDATION_BATCH_ENABLED && Boolean(config.ANTHROPIC_API_KEY);
  }

  // ── Inflight dup-guard (acceptance f) ───────────────────

  private markerKey(projectName: string, sessionId: string): string {
    return `consolidation:batch:inflight:${projectName}:${sessionId}`;
  }

  /** Atomically claim the session for batch consolidation (SET NX). */
  private async setInflight(projectName: string, sessionId: string): Promise<boolean> {
    const redis = cacheService.getClient();
    if (!redis) return true; // no Redis → no guard possible; proceed
    const res = await redis.set(
      this.markerKey(projectName, sessionId),
      new Date().toISOString(),
      'EX',
      INFLIGHT_TTL_SECONDS,
      'NX'
    );
    return res === 'OK';
  }

  async clearInflight(projectName: string, sessionId: string): Promise<void> {
    const redis = cacheService.getClient();
    if (!redis) return;
    try {
      await redis.del(this.markerKey(projectName, sessionId));
    } catch (err: any) {
      logger.debug('Failed to clear consolidation inflight marker', { error: err.message });
    }
  }

  // ── Submit (step 1) ─────────────────────────────────────

  /**
   * Snapshot the session and submit step-1 pattern detection as a batch
   * row. Clears working memory AT SUBMIT. Throws if batches.create fails
   * (after releasing the marker) — the caller falls back to sync Ollama.
   */
  async submit(projectName: string, sessionId: string): Promise<ConsolidationSubmitOutcome> {
    const claimed = await this.setInflight(projectName, sessionId);
    if (!claimed) {
      logger.info('Batch consolidation already inflight for session — skipping (dup-guard)', {
        projectName,
        sessionId,
      });
      return 'inflight';
    }

    try {
      // REPLAY + SNAPSHOT — the only place the sensory buffer is read.
      const [wmSlots, events] = await Promise.all([
        workingMemory.getAll(projectName, sessionId),
        sensoryBuffer.read(projectName, sessionId, { count: 500 }),
      ]);

      if (wmSlots.length === 0 && events.length === 0) {
        await this.clearInflight(projectName, sessionId);
        return 'empty';
      }

      const snapshot = consolidationAgent.buildSnapshot(wmSlots, events);

      await this.enqueueRow(projectName, {
        customId: `consolidation-step1-${sessionId}-${Date.now()}`,
        projectName,
        request: {
          prompt: `Session events:\n${snapshot.eventSummary.slice(0, 3000)}`,
          systemPrompt: PATTERN_DETECTION_PROMPT,
          maxTokens: CONSOLIDATION_MAX_TOKENS,
          jsonSchema: PATTERN_JSON_SCHEMA,
          effort: CONSOLIDATION_EFFORT,
        },
        continuation: {
          queue: 'session-lifecycle',
          jobName: 'consolidation:abstract',
          payload: { projectName, sessionId, snapshot },
        },
        failureContinuation: {
          queue: 'session-lifecycle',
          jobName: 'consolidation:batch-failed',
          payload: { projectName, sessionId, snapshot },
        },
      });

      // WM CLEARED AT SUBMIT — see module header.
      await workingMemory.clear(projectName, sessionId);

      logger.info('Batch consolidation step-1 submitted; working memory cleared at submit', {
        projectName,
        sessionId,
        wmSlots: wmSlots.length,
        events: events.length,
      });
      return 'submitted';
    } catch (err) {
      // Release the claim so the sync fallback (or a retry) isn't blocked.
      await this.clearInflight(projectName, sessionId).catch(() => {});
      throw err;
    }
  }

  // ── Continuations ───────────────────────────────────────

  /** Step-1 result → submit step-2 abstraction. */
  async handleAbstract(payload: ConsolidationAbstractPayload): Promise<void> {
    const { projectName, sessionId, snapshot } = payload;

    let patterns: ExtractedPattern[];
    try {
      patterns = parseStrict<{ patterns: ExtractedPattern[] }>(
        payload.resultText,
        'patterns'
      ).patterns;
    } catch (err: any) {
      logger.warn('Batch step-1 output failed strict schema parse — falling back', {
        projectName,
        sessionId,
        error: err.message,
      });
      await this.handleTerminalFailure({
        projectName,
        sessionId,
        snapshot,
        reason: `malformed step-1 output: ${err.message}`,
      });
      return;
    }

    const significant = patterns.filter((p) => p.significance >= 0.5);
    const observations = [
      ...significant.map(
        (p) => `[PATTERN: ${p.type}] ${p.description} (files: ${(p.files ?? []).join(', ')})`
      ),
      ...snapshot.wmObservationLines,
    ].join('\n');

    if (!observations.trim()) {
      // Legitimate "nothing worth storing" — finish the run.
      logger.info('Batch consolidation: no observations after step-1 — nothing to store', {
        projectName,
        sessionId,
      });
      await this.clearInflight(projectName, sessionId);
      return;
    }

    try {
      await this.enqueueRow(projectName, {
        customId: `consolidation-step2-${sessionId}-${Date.now()}`,
        projectName,
        request: {
          prompt: `Session observations:\n${observations.slice(0, 3000)}`,
          systemPrompt: ABSTRACTION_PROMPT,
          maxTokens: CONSOLIDATION_MAX_TOKENS,
          jsonSchema: MEMORIES_JSON_SCHEMA,
          effort: CONSOLIDATION_EFFORT,
        },
        continuation: {
          queue: 'session-lifecycle',
          jobName: 'consolidation:finalize',
          payload: { projectName, sessionId, snapshot, patternsDetected: patterns.length },
        },
        failureContinuation: {
          queue: 'session-lifecycle',
          jobName: 'consolidation:batch-failed',
          payload: { projectName, sessionId, snapshot },
        },
      });
    } catch (err: any) {
      // batches.create failed for step-2 → don't strand the run: sync
      // fallback on the snapshot (Ollama), no memory loss.
      logger.warn('Batch step-2 submit failed — running sync fallback on snapshot', {
        projectName,
        sessionId,
        error: err.message,
      });
      await this.handleTerminalFailure({
        projectName,
        sessionId,
        snapshot,
        reason: `step-2 submit failed: ${err.message}`,
      });
    }
  }

  /** Step-2 result → store/classify/anchor (classification stays sync Ollama v1). */
  async handleFinalize(payload: ConsolidationFinalizePayload): Promise<void> {
    const { projectName, sessionId, snapshot } = payload;

    let memories: AbstractedMemory[];
    try {
      memories = parseStrict<{ memories: AbstractedMemory[] }>(
        payload.resultText,
        'memories'
      ).memories;
    } catch (err: any) {
      logger.warn('Batch step-2 output failed strict schema parse — falling back', {
        projectName,
        sessionId,
        error: err.message,
      });
      await this.handleTerminalFailure({
        projectName,
        sessionId,
        snapshot,
        reason: `malformed step-2 output: ${err.message}`,
      });
      return;
    }

    const normalized = consolidationAgent.normalizeAbstracted(memories);
    await consolidationAgent.storeAbstracted(projectName, sessionId, normalized, {
      result: {
        episodic: [],
        semantic: [],
        relationships: [],
        anchors: [],
        patternsDetected: payload.patternsDetected ?? 0,
        totalEventsProcessed: snapshot.totalEvents,
        durationMs: 0,
      },
    });

    await this.clearInflight(projectName, sessionId);
    logger.info('Batch consolidation finalized', {
      projectName,
      sessionId,
      memories: normalized.length,
    });
  }

  /**
   * Terminal failure (invalid_request DLQ, expiry-after-retries, malformed
   * structured output): restore the snapshot into WM (capacity policy
   * applies via insert/evict) and run the sync Ollama fallback ON THE
   * SNAPSHOT. Throws if the fallback itself fails so BullMQ retries this
   * job — the payload is self-contained, no buffer re-read.
   */
  async handleTerminalFailure(payload: ConsolidationFailedPayload): Promise<void> {
    const { projectName, sessionId, snapshot, reason } = payload;

    logger.warn('Batch consolidation terminally failed — restoring WM + sync fallback', {
      projectName,
      sessionId,
      reason,
    });

    // 1. Restore the snapshot into working memory FIRST, so the data
    //    survives even if the fallback below crashes mid-run.
    for (const slot of snapshot.wmSlots) {
      try {
        await workingMemory.insert(projectName, sessionId, slot);
      } catch (err: any) {
        logger.debug('WM restore insert failed', { error: err.message, slotId: slot.id });
      }
    }

    // 2. Sync Ollama fallback on the snapshot (throws → BullMQ retry).
    await consolidationAgent.consolidateSnapshot(projectName, sessionId, snapshot);

    // 3. Fallback consolidated successfully → clear the restored WM + marker.
    await workingMemory.clear(projectName, sessionId);
    await this.clearInflight(projectName, sessionId);
  }

  // ── Row submission (optional coalescing window) ─────────

  private async enqueueRow(projectName: string, row: BatchRowInput): Promise<void> {
    if (config.CONSOLIDATION_BATCH_WINDOW_MS <= 0) {
      // Default: batch-of-1, submitted inline (still earns the 50% discount).
      await anthropicBatch.submit({ caller: CALLER, projectName, rows: [row] });
      return;
    }

    // Window > 0: coalesce rows arriving within the window into one batch.
    this.pendingRows.push(row);
    if (!this.windowFlush) {
      this.windowFlush = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const rows = this.pendingRows.splice(0);
          this.windowFlush = null;
          anthropicBatch
            .submit({ caller: CALLER, rows })
            .then(() => resolve())
            .catch(reject);
        }, config.CONSOLIDATION_BATCH_WINDOW_MS);
        timer.unref?.();
      });
    }
    await this.windowFlush;
  }
}

export const consolidationBatch = new ConsolidationBatchService();
export default consolidationBatch;
