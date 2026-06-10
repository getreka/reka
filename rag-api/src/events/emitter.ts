import { eventBus, type EventType } from '../services/event-bus';
import { getQueue, type QueueName } from './queues';
import type { DomainEventType, EventPayloadMap } from './types';
import { generateCorrelationId } from './types';
import config from '../config';
import { logger } from '../utils/logger';
import { withSpan } from '../utils/tracing';
import { eventEmittedTotal } from '../utils/metrics';

// Infrastructure events that stay on plain BullMQ queues
const EVENT_QUEUE_MAP: Partial<Record<DomainEventType, QueueName>> = {
  'session:ending': 'session-lifecycle',
  'maintenance:cycle.started': 'maintenance',
  'maintenance:dedup.completed': 'maintenance',
};

// Actor routing: memory/session events are handled by stateful actors
const ACTOR_ROUTES: Partial<
  Record<DomainEventType, { actorType: string; getActorId: (payload: any) => string }>
> = {
  'memory:created': {
    actorType: 'memory',
    getActorId: (p) => `memory:${p.projectName}`,
  },
  'memory:recalled': {
    actorType: 'memory',
    getActorId: (p) => `memory:${p.projectName}`,
  },
  'memory:deleted': {
    actorType: 'memory',
    getActorId: (p) => `memory:${p.projectName}`,
  },
  'memory:superseded': {
    actorType: 'memory',
    getActorId: (p) => `memory:${p.projectName}`,
  },
  'session:started': {
    actorType: 'session',
    getActorId: (p) => `session:${p.projectName}:${p.sessionId}`,
  },
  'session:activity': {
    actorType: 'session',
    getActorId: (p) => `session:${p.projectName}:${p.sessionId}`,
  },
  // session:ending routed to BullMQ worker (not actor) for reliable consolidation + debug logging
  'session:ended': {
    actorType: 'session',
    getActorId: (p) => `session:${p.projectName}:${p.sessionId}`,
  },
  'sensory:appended': {
    actorType: 'session',
    getActorId: (p) => `session:${p.projectName}:${p.sessionId}`,
  },
  'index:started': {
    actorType: 'index',
    getActorId: (p: any) => `index:${p.projectName}`,
  },
  'index:progress': {
    actorType: 'index',
    getActorId: (p: any) => `index:${p.projectName}`,
  },
  'index:completed': {
    actorType: 'index',
    getActorId: (p: any) => `index:${p.projectName}`,
  },
  'index:failed': {
    actorType: 'index',
    getActorId: (p: any) => `index:${p.projectName}`,
  },
};

/**
 * Publish a domain event.
 * - Emits to in-process eventBus (for SSE subscribers)
 * - Routes to actor mailbox (memory/session events) or BullMQ queue (infrastructure events)
 */
export async function publishEvent<T extends DomainEventType>(
  type: T,
  payload: Omit<EventPayloadMap[T], 'timestamp' | 'correlationId'> & { correlationId?: string }
): Promise<void> {
  const fullPayload = {
    ...payload,
    timestamp: new Date().toISOString(),
    correlationId: payload.correlationId || generateCorrelationId(),
  };

  await withSpan(
    `event:${type}`,
    {
      'event.type': type,
      'event.correlation_id': fullPayload.correlationId,
      'project.name': (payload as any).projectName || 'unknown',
    },
    async () => {
      // Emit in-process for SSE
      eventBus.publish(type as unknown as EventType, fullPayload as Record<string, unknown>);

      const actorRoute = ACTOR_ROUTES[type];
      if (actorRoute) {
        // Route to actor mailbox
        try {
          const { actorSystem } = await import('../actors/actor-system');
          const actor = actorSystem.get(actorRoute.actorType);
          if (actor) {
            const actorId = actorRoute.getActorId(fullPayload);
            await actor.ref(actorId).send(type, fullPayload);
          }
        } catch (err) {
          logger.warn(`Failed to route event ${type} to actor ${actorRoute.actorType}`, {
            error: (err as Error).message,
          });
        }
      } else {
        // Route to plain BullMQ queue
        const queueName = EVENT_QUEUE_MAP[type];
        if (queueName) {
          try {
            const queue = getQueue(queueName);
            await queue.add(type, fullPayload, {
              attempts: config.EVENT_DLQ_MAX_RETRIES,
              backoff: { type: 'exponential', delay: 1000 },
              removeOnComplete: 100,
              removeOnFail: 50,
            });
          } catch (err) {
            logger.warn(`Failed to enqueue event ${type}`, { error: (err as Error).message });
          }
        }
      }

      eventEmittedTotal.inc({ event_type: type });
    }
  );
}
