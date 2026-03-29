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

        // Auto-merge similar memories
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

        // Run consolidation agent
        try {
          const agent = await getConsolidationAgent();
          await agent.consolidate(projectName, sessionId);
          logger.debug('Session consolidation completed', { sessionId });
        } catch (err: any) {
          logger.debug('Consolidation failed', { error: err.message, sessionId });
        }

        // Stale memory detection
        try {
          const detector = await getStaleDetector();
          await detector.detectStaleMemories(projectName);
        } catch (err: any) {
          logger.debug('Stale detection failed', { error: err.message });
        }

        // Cleanup working memory
        try {
          const wm = await getWorkingMemory();
          await wm.clear(projectName, sessionId);
        } catch (err: any) {
          logger.debug('Working memory cleanup failed', { error: err.message });
        }

        newState.status = 'ended';

        // Remove actor state from Redis — session is done
        await this.clearState(actorId);

        break;
      }

      default:
        logger.warn(`SessionActor received unknown message type: ${message.type}`, { actorId });
    }

    return newState;
  }
}

export const sessionActor = new SessionActor();
