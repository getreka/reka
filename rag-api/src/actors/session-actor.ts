import { Actor, ActorMessage } from './base-actor';
import { logger } from '../utils/logger';
import type { SensoryEvent } from '../services/sensory-buffer';

// Lazy imports — avoid circular deps and defer service initialization
async function getSessionContext() {
  const mod = await import('../services/session-context');
  return mod.sessionContext;
}
async function getPredictiveLoader() {
  const mod = await import('../services/predictive-loader');
  return mod.predictiveLoader;
}
async function getConsolidationAgent() {
  const mod = await import('../services/consolidation-agent');
  return mod.consolidationAgent;
}
async function getStaleDetector() {
  const mod = await import('../services/stale-memory-detector');
  return mod.staleMemoryDetector;
}
async function getWorkingMemory() {
  const mod = await import('../services/working-memory');
  return mod.workingMemory;
}

export interface SessionActorState {
  projectName: string;
  sessionId: string;
  startedAt: string;
  activitiesCount: number;
  sensoryEventsProcessed: number;
  prefetchesRun: number;
  status: 'active' | 'ending' | 'ended';
}

type SessionActorMessage =
  | { projectName: string; sessionId: string }
  | { projectName: string; sessionId: string; activityType: string }
  | { projectName: string; sessionId: string; eventType: string; value: SensoryEvent }
  | { projectName: string; sessionId: string; summary?: string };

const DEFAULT_STATE: SessionActorState = {
  projectName: '',
  sessionId: '',
  startedAt: '',
  activitiesCount: 0,
  sensoryEventsProcessed: 0,
  prefetchesRun: 0,
  status: 'active',
};

/**
 * SessionActor — stateful actor that manages per-session lifecycle.
 *
 * Actor ID: `session:{projectName}:{sessionId}`
 *
 * Replaces the stateless session-lifecycle.worker.ts with per-session state tracking.
 * Messages for a given session are serialized (processed one at a time).
 */
class SessionActor extends Actor<SessionActorState, SessionActorMessage> {
  constructor() {
    super('session', DEFAULT_STATE, {
      maxRestarts: 5,
      windowMs: 60000,
      backoffMs: 1000,
    });
  }

  protected async onInit(actorId: string): Promise<SessionActorState> {
    // Extract projectName and sessionId from actorId: "session:{projectName}:{sessionId}"
    const parts = actorId.split(':');
    const sessionId = parts[parts.length - 1];
    const projectName = parts.slice(1, -1).join(':');
    return {
      ...DEFAULT_STATE,
      projectName,
      sessionId,
      startedAt: new Date().toISOString(),
    };
  }

  async handle(
    actorId: string,
    message: ActorMessage<SessionActorMessage>,
    state: SessionActorState
  ): Promise<SessionActorState> {
    const newState = { ...state };

    switch (message.type) {
      case 'session:started': {
        const { projectName, sessionId } = message.payload as {
          projectName: string;
          sessionId: string;
        };

        newState.projectName = projectName;
        newState.sessionId = sessionId;
        newState.startedAt = newState.startedAt || new Date().toISOString();
        newState.status = 'active';

        // Predictive prefetch
        try {
          const ctx = await getSessionContext();
          const session = await ctx.getSession(projectName, sessionId);
          if (session) {
            const loader = await getPredictiveLoader();
            const predictions = await loader.predict(projectName, sessionId, {
              currentFiles: session.currentFiles,
              recentQueries: session.recentQueries,
              toolsUsed: session.toolsUsed,
              activeFeatures: session.activeFeatures,
            });
            if (predictions.length > 0) {
              await loader.prefetch(projectName, sessionId, predictions);
              newState.prefetchesRun += 1;
            }
          }
        } catch (err: any) {
          logger.debug('Predictive prefetch failed on session:started', {
            error: err.message,
            sessionId,
          });
        }

        // Auto-merge similar memories on session start.
        // NOTE: mergeMemories is non-destructive — originals are marked
        // supersededBy (not deleted) and the merged memory carries over
        // validated/confidence/source + newest createdAt, so it does not resume
        // Ebbinghaus decay as an old unvalidated stub.
        try {
          const { memoryService } = await import('../services/memory');
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
          logger.debug('Auto-merge failed on session:started', { error: err.message });
        }

        break;
      }

      case 'session:activity': {
        const { projectName, sessionId } = message.payload as {
          projectName: string;
          sessionId: string;
        };

        newState.activitiesCount += 1;

        // Predictive prefetch on activity
        try {
          const ctx = await getSessionContext();
          const session = await ctx.getSession(projectName, sessionId);
          if (session) {
            const loader = await getPredictiveLoader();
            const predictions = await loader.predict(projectName, sessionId, {
              currentFiles: session.currentFiles,
              recentQueries: session.recentQueries,
              toolsUsed: session.toolsUsed,
              activeFeatures: session.activeFeatures,
            });
            if (predictions.length > 0) {
              await loader.prefetch(projectName, sessionId, predictions);
              newState.prefetchesRun += 1;
            }
          }
        } catch (err: any) {
          logger.debug('Activity prefetch failed', { error: err.message, sessionId });
        }

        break;
      }

      case 'sensory:appended': {
        const { projectName, sessionId, value } = message.payload as {
          projectName: string;
          sessionId: string;
          eventType: string;
          value: SensoryEvent;
        };

        try {
          const wm = await getWorkingMemory();
          await wm.processEvent(projectName, sessionId, value);
          newState.sensoryEventsProcessed += 1;
        } catch (err: any) {
          logger.debug('Sensory event processing failed', { error: err.message });
        }

        break;
      }

      case 'session:ending': {
        const { projectName, sessionId } = message.payload as {
          projectName: string;
          sessionId: string;
          summary?: string;
        };

        newState.status = 'ending';

        // Run consolidation agent. Track success so we only clear working memory
        // (and the 24h sensory buffer source) AFTER a successful consolidation —
        // otherwise a transient LLM failure would wipe the buffer and lose the
        // session forever.
        //
        // RETRY SEMANTICS: A bare re-throw here would NOT retry consolidation — the
        // actor's supervision treats repeated failures as restarts and routes the
        // message to the DLQ after maxRestarts, so the session knowledge is still
        // lost (just via DLQ instead of buffer TTL). The actor mailbox has no
        // BullMQ attempts/backoff per message. So on failure we instead enqueue a
        // `session:ending` retry job onto the session-lifecycle BullMQ queue (the
        // same queue the worker consumes), which DOES carry attempts/backoff and
        // re-consolidates from the still-intact buffer. We also leave the actor
        // state un-cleared and status NOT 'ended' so the session remains
        // re-consolidatable; clearState only runs on success.
        let consolidationOk = false;
        try {
          const agent = await getConsolidationAgent();
          await agent.consolidate(projectName, sessionId);
          consolidationOk = true;
          logger.debug('Session consolidation completed', { sessionId });
        } catch (err: any) {
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

        // Cleanup working memory — ONLY if consolidation succeeded.
        if (consolidationOk) {
          try {
            const wm = await getWorkingMemory();
            await wm.clear(projectName, sessionId);
          } catch (err: any) {
            logger.debug('Working memory cleanup failed', { error: err.message });
          }
        }

        if (consolidationOk) {
          newState.status = 'ended';
          // Remove actor state from Redis — session is done
          await this.clearState(actorId);
        } else {
          // Consolidation failed: keep the actor alive in 'ending' state (NOT
          // 'ended', NOT cleared) and enqueue a retry onto the session-lifecycle
          // queue so the worker re-runs consolidation with attempts/backoff. The
          // buffer + working memory survive for that retry.
          try {
            const { getQueue } = await import('../events/queues');
            const queue = getQueue('session-lifecycle');
            await queue.add(
              'session:ending',
              { projectName, sessionId },
              {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 100,
                removeOnFail: 50,
              }
            );
            logger.info('Consolidation retry enqueued on session-lifecycle queue', {
              sessionId,
              projectName,
            });
          } catch (err: any) {
            logger.error('Failed to enqueue consolidation retry — session knowledge at risk', {
              error: err.message,
              sessionId,
            });
          }
        }

        break;
      }

      default:
        logger.warn(`SessionActor received unknown message type: ${message.type}`, { actorId });
    }

    return newState;
  }
}

export const sessionActor = new SessionActor();
