import { Actor, ActorMessage } from './base-actor';
import { logger } from '../utils/logger';
import type { SensoryEvent } from '../services/sensory-buffer';

// Lazy imports — avoid circular deps and defer service initialization
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
  status: 'active' | 'ending' | 'ended';
}

type SessionActorMessage =
  | { projectName: string; sessionId: string }
  | { projectName: string; sessionId: string; activityType: string }
  | { projectName: string; sessionId: string; eventType: string; value: SensoryEvent };

const DEFAULT_STATE: SessionActorState = {
  projectName: '',
  sessionId: '',
  startedAt: '',
  activitiesCount: 0,
  sensoryEventsProcessed: 0,
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
        newState.activitiesCount += 1;
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

      // NOTE: there is deliberately NO 'session:ending' case here. The emitter
      // routes 'session:ending' to the session-lifecycle BullMQ queue (see
      // events/emitter.ts EVENT_QUEUE_MAP), never to this actor — the queue
      // carries the attempts/backoff retry semantics consolidation needs, and
      // (M4) the CONSOLIDATION_BATCH_ENABLED split lives in
      // events/workers/session-lifecycle.worker.ts. The previous dead handler
      // here was pruned so the worker is the single consolidation entry point.

      default:
        logger.warn(`SessionActor received unknown message type: ${message.type}`, { actorId });
    }

    return newState;
  }
}

export const sessionActor = new SessionActor();
