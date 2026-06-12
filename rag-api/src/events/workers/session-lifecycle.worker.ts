import { createWorker } from '../queues';
import config from '../../config';
import { logger } from '../../utils/logger';
import type { SensoryEvent } from '../../services/sensory-buffer';

// Lazy imports to avoid circular deps
async function getConsolidationAgent() {
  const mod = await import('../../services/consolidation-agent');
  return mod.consolidationAgent;
}
async function getStaleDetector() {
  const mod = await import('../../services/stale-memory-detector');
  return mod.staleMemoryDetector;
}
async function getWorkingMemory() {
  const mod = await import('../../services/working-memory');
  return mod.workingMemory;
}
// Only loaded when CONSOLIDATION_BATCH_ENABLED — the flag-off path never
// imports the batch module (M4 acceptance a).
async function getConsolidationBatch() {
  const mod = await import('../../services/consolidation-batch');
  return mod.consolidationBatch;
}

/**
 * Job processor for the session-lifecycle queue. Extracted from the Worker
 * registration so it can be unit-tested directly without constructing a real
 * BullMQ Worker (which would require a live Redis connection). The Worker
 * registration in {@link startSessionLifecycleWorker} simply forwards to this
 * function, so runtime behaviour is unchanged.
 */
export async function processSessionLifecycleJob(job: {
  name: string;
  data: unknown;
}): Promise<void> {
  const { name, data } = job;

  switch (name) {
    case 'session:started': {
      const { projectName } = data as { projectName: string; sessionId: string };

      // Auto-merge similar memories (delegated to memoryService via session-context).
      // NOTE: This worker path is superseded by SessionActor (see session-actor.ts)
      // and is effectively dead under the Actor-model rollout. It is kept aligned
      // with the actor: mergeMemories is non-destructive (supersede, not delete).
      try {
        const { memoryService } = await import('../../services/memory');
        const result = await memoryService.mergeMemories({
          projectName,
          type: 'all',
          threshold: 0.9,
          dryRun: false,
          limit: 50,
        });
        if (result.totalMerged > 0) {
          logger.info(`Auto-merged ${result.totalMerged} memory clusters on session start`, {
            project: projectName,
          });
        }
      } catch (err: any) {
        logger.debug('Auto-merge failed', { error: err.message });
      }
      break;
    }

    case 'sensory:appended': {
      const { projectName, sessionId, value } = data as {
        projectName: string;
        sessionId: string;
        eventType: string;
        value: SensoryEvent;
      };
      try {
        const wm = await getWorkingMemory();
        await wm.processEvent(projectName, sessionId, value);
      } catch (err: any) {
        logger.debug('Sensory event processing failed', { error: err.message });
      }
      break;
    }

    case 'session:ending': {
      const { projectName, sessionId } = data as {
        projectName: string;
        sessionId: string;
        summary?: string;
      };

      // Run consolidation agent (skip if short session with manual memories already saved).
      // Track success so we only clear working memory after a SUCCESSFUL (or skipped)
      // consolidation — a failed run must preserve the buffer so a BullMQ retry can
      // re-consolidate instead of losing the session.
      let consolidationOk = false;
      // M4 batch path owns its own WM lifecycle: WM is cleared AT SUBMIT
      // inside consolidationBatch.submit(), and the run finishes async via
      // the llm-batch queue — so the guarded clear below must be skipped.
      let wmHandledByBatch = false;
      // Hold the consolidation error so we can re-throw AFTER guarded cleanup is
      // skipped. Re-throwing makes the BullMQ job fail, which triggers the queue's
      // configured attempts/backoff to retry — the buffer survives because the
      // working-memory clear below is gated on consolidationOk.
      let consolidationError: Error | null = null;
      try {
        const { sensoryBuffer } = await import('../../services/sensory-buffer');
        const events = await sensoryBuffer.read(projectName, sessionId, { count: 50 });
        const hasManualMemories = events.some(
          (e) => e.toolName === 'remember' || e.toolName === 'batch_remember'
        );
        const tooFewEvents = events.length < 5;

        if (hasManualMemories && tooFewEvents) {
          logger.info('Consolidation skipped: short session with manual memories', {
            sessionId,
            events: events.length,
          });
          consolidationOk = true; // nothing to consolidate → safe to clear
        } else if (config.CONSOLIDATION_BATCH_ENABLED && config.ANTHROPIC_API_KEY) {
          // M4: Opus 4.8 via Message Batches (ADR-003). Falls back to the
          // sync Ollama path if batches.create throws.
          const consolidationBatch = await getConsolidationBatch();
          let outcome: 'submitted' | 'inflight' | 'empty' | 'failed' = 'failed';
          try {
            outcome = await consolidationBatch.submit(projectName, sessionId);
          } catch (err: any) {
            logger.warn('Batch consolidation submit failed — falling back to sync path', {
              error: err.message,
              sessionId,
            });
          }

          if (outcome === 'submitted' || outcome === 'inflight') {
            // 'submitted': WM was cleared at submit; the run continues async
            // on the llm-batch queue — this job is done.
            // 'inflight': a prior submit owns this session (dup-guard) —
            // do nothing, especially not a sync run (it would re-read the
            // still-alive sensory buffer and duplicate memories).
            wmHandledByBatch = true;
            logger.info(`Batch consolidation ${outcome}`, { sessionId, projectName });
          } else if (outcome === 'empty') {
            consolidationOk = true; // nothing to consolidate → safe to clear
          } else {
            // 'failed' → byte-identical sync Ollama path
            const agent = await getConsolidationAgent();
            await agent.consolidate(projectName, sessionId);
            consolidationOk = true;
            logger.info('Session consolidation completed (sync fallback)', {
              sessionId,
              events: events.length,
            });
          }
        } else {
          const agent = await getConsolidationAgent();
          await agent.consolidate(projectName, sessionId);
          consolidationOk = true;
          logger.info('Session consolidation completed', { sessionId, events: events.length });
        }
      } catch (err: any) {
        consolidationError = err instanceof Error ? err : new Error(String(err?.message ?? err));
        logger.warn('Consolidation failed — preserving working memory for retry', {
          error: err.message,
          sessionId,
        });
      }

      // Stale memory detection
      try {
        const detector = await getStaleDetector();
        await detector.detectStaleMemories(projectName);
      } catch (err: any) {
        logger.debug('Stale detection failed', { error: err.message });
      }

      // Cleanup working memory — ONLY if consolidation succeeded (or was skipped).
      // The buffer must survive a failed consolidation so the retried job can
      // re-consolidate from it. The batch path clears WM at submit instead.
      if (consolidationOk && !wmHandledByBatch) {
        try {
          const wm = await getWorkingMemory();
          await wm.clear(projectName, sessionId);
        } catch (err: any) {
          logger.debug('Working memory cleanup failed', { error: err.message });
        }
      }

      // Re-throw AFTER skipping the buffer clear so BullMQ fails this job and the
      // queue's attempts/backoff retry the consolidation. Without this the session's
      // knowledge silently dies on the 24h sensory-buffer TTL.
      if (consolidationError) {
        throw consolidationError;
      }
      break;
    }

    // ── M4 batch-consolidation continuations (enqueued by the llm-batch
    //    worker). Payloads are self-contained snapshots — a BullMQ retry of
    //    any of these NEVER re-reads the sensory buffer. Errors propagate so
    //    the queue's attempts/backoff retry the job.
    case 'consolidation:abstract': {
      const consolidationBatch = await getConsolidationBatch();
      await consolidationBatch.handleAbstract(
        data as import('../../services/consolidation-batch').ConsolidationAbstractPayload
      );
      break;
    }

    case 'consolidation:finalize': {
      const consolidationBatch = await getConsolidationBatch();
      await consolidationBatch.handleFinalize(
        data as import('../../services/consolidation-batch').ConsolidationFinalizePayload
      );
      break;
    }

    case 'consolidation:batch-failed': {
      const consolidationBatch = await getConsolidationBatch();
      await consolidationBatch.handleTerminalFailure(
        data as import('../../services/consolidation-batch').ConsolidationFailedPayload
      );
      break;
    }
  }
}

export function startSessionLifecycleWorker(): void {
  createWorker('session-lifecycle', (job) => processSessionLifecycleJob(job), { concurrency: 2 });

  logger.info('Session lifecycle worker started');
}
