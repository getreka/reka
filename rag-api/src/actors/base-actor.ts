import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import config from '../config';
import { logger } from '../utils/logger';
import {
  eventProcessedTotal,
  eventProcessingDuration,
  actorLockContentions,
  actorStateSizeBytes,
} from '../utils/metrics';

// Parse Redis connection from config — mirrors queues.ts
function getRedisConnection(): { host: string; port: number } {
  const url = config.REDIS_URL || 'redis://localhost:6380';
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parseInt(parsed.port || '6380', 10) };
  } catch {
    return { host: 'localhost', port: 6380 };
  }
}

const connection = getRedisConnection();

/**
 * Message envelope — wraps every message sent to an actor
 */
export interface ActorMessage<T = unknown> {
  type: string;
  payload: T;
  actorId: string; // Target actor instance ID (e.g., "memory:beep-services")
  correlationId?: string;
  timestamp: string;
}

/**
 * Supervision strategy for handling actor failures
 */
export interface SupervisionStrategy {
  maxRestarts: number; // Max restarts within the window
  windowMs: number; // Time window for counting restarts
  backoffMs: number; // Initial backoff between restarts
}

const DEFAULT_SUPERVISION: SupervisionStrategy = {
  maxRestarts: 3,
  windowMs: 60000, // 1 minute
  backoffMs: 1000, // 1 second initial
};

/**
 * Actor reference — used to send messages to an actor without holding it directly
 */
export class ActorRef<TMessage = unknown> {
  constructor(
    private readonly queue: Queue,
    readonly actorId: string,
    readonly actorType: string
  ) {}

  /**
   * Send a message to this actor (enqueue to its mailbox)
   */
  async send(type: string, payload: TMessage): Promise<void> {
    const message: ActorMessage<TMessage> = {
      type,
      payload,
      actorId: this.actorId,
      timestamp: new Date().toISOString(),
    };

    await this.queue.add(type, message, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }
}

/**
 * Abstract Actor — subclass this to create specific actors.
 *
 * Each actor type gets one BullMQ queue (mailbox).
 * Each actor instance is identified by actorId (e.g., "memory:projectName").
 * State is checkpointed to Redis after each message.
 * Messages for a specific actorId are processed serially (concurrency: 1 per actorId).
 * Multiple actorIds can process in parallel across the same queue.
 */
export abstract class Actor<TState, TMessage = unknown> {
  protected queue: Queue;
  protected worker: Worker | null = null;
  protected redis: Redis;
  protected supervision: SupervisionStrategy;
  private restartTimes: number[] = [];

  constructor(
    readonly actorType: string,
    protected readonly defaultState: TState,
    supervision?: Partial<SupervisionStrategy>
  ) {
    this.queue = new Queue(`actor-${actorType}`, { connection });
    this.redis = new Redis(config.REDIS_URL || 'redis://localhost:6380');
    this.supervision = { ...DEFAULT_SUPERVISION, ...supervision };
  }

  /**
   * Override this — the core message handler.
   * Return the new state (or same state if unchanged).
   */
  abstract handle(actorId: string, message: ActorMessage<TMessage>, state: TState): Promise<TState>;

  /**
   * Optional: called when actor is first created (no existing state).
   */
  protected onInit?(actorId: string): Promise<TState>;

  /**
   * Optional: called when a message handler throws.
   * Return true to retry, false to drop the message.
   */
  protected onError?(
    actorId: string,
    message: ActorMessage<TMessage>,
    error: Error,
    state: TState
  ): Promise<boolean>;

  /**
   * Expose the underlying BullMQ queue for status inspection.
   */
  getQueue(): Queue {
    return this.queue;
  }

  /**
   * Get an ActorRef for sending messages to a specific instance.
   */
  ref(actorId: string): ActorRef<TMessage> {
    return new ActorRef<TMessage>(this.queue, actorId, this.actorType);
  }

  /**
   * Start the actor's worker (message processing loop).
   * Call this once during server startup.
   */
  start(concurrency: number = 5): void {
    this.worker = new Worker(
      `actor-${this.actorType}`,
      async (job: Job<ActorMessage<TMessage>>) => {
        const msg = job.data;
        const { actorId } = msg;
        const stateKey = `actor-${this.actorType}:${actorId}:state`;
        const lockKey = `actor-${this.actorType}:${actorId}:lock`;
        const lockTTL = 120; // seconds — max time a single message can hold the lock

        // Acquire per-actorId lock — guarantees serial message processing
        const lockAcquired = await this.redis.set(lockKey, job.id ?? '1', 'EX', lockTTL, 'NX');
        if (!lockAcquired) {
          // Another message for this actorId is being processed — retry after delay
          actorLockContentions.inc({ actor_type: this.actorType });
          throw new Error(`Actor ${this.actorType}:${actorId} busy — will retry`);
        }

        try {
          // Load state from Redis (or initialize)
          const loaded = await this.loadState(stateKey);
          let state: TState;
          if (loaded === null) {
            state = this.onInit ? await this.onInit(actorId) : { ...this.defaultState };
            await this.saveState(stateKey, state);
          } else {
            state = loaded;
          }

          // Process message
          const startTime = Date.now();
          try {
            const newState = await this.handle(actorId, msg, state);
            await this.saveState(stateKey, newState);

            const stateJson = JSON.stringify(newState);
            actorStateSizeBytes.set(
              { actor_type: this.actorType, actor_id: actorId },
              Buffer.byteLength(stateJson, 'utf8')
            );

            eventProcessedTotal.inc({
              queue: `actor-${this.actorType}`,
              event_type: msg.type,
              status: 'completed',
            });
            const duration = (Date.now() - startTime) / 1000;
            eventProcessingDuration.observe(
              { queue: `actor-${this.actorType}`, event_type: msg.type },
              duration
            );
          } catch (error) {
            const shouldRetry = this.onError
              ? await this.onError(actorId, msg, error as Error, state)
              : false;

            eventProcessedTotal.inc({
              queue: `actor-${this.actorType}`,
              event_type: msg.type,
              status: 'failed',
            });

            this.recordRestart();
            if (this.isOverRestartLimit()) {
              logger.error(
                `Actor ${this.actorType}:${actorId} exceeded restart limit — moving to DLQ`,
                { messageType: msg.type, error: (error as Error).message }
              );
              // Move to dead-letter queue for manual inspection
              try {
                const { getQueue } = await import('../events/queues');
                const dlq = getQueue('dead-letter');
                await dlq.add(`dlq:${this.actorType}:${msg.type}`, {
                  originalQueue: `actor-${this.actorType}`,
                  actorId,
                  message: msg,
                  error: (error as Error).message,
                  droppedAt: new Date().toISOString(),
                });
              } catch (dlqErr) {
                logger.error('Failed to move message to DLQ', { error: (dlqErr as Error).message });
              }
              return;
            }

            if (shouldRetry) {
              throw error; // BullMQ will retry
            }

            logger.warn(`Actor ${this.actorType}:${actorId} message handling failed`, {
              messageType: msg.type,
              error: (error as Error).message,
            });
          }
        } finally {
          // Always release the per-actorId lock
          await this.redis.del(lockKey);
        }
      },
      {
        connection,
        concurrency, // Multiple actor instances process in parallel
        lockDuration: 60000,
      }
    );

    this.worker.on('error', (err) => {
      logger.error(`Actor ${this.actorType} worker error`, { error: err.message });
    });

    logger.info(`Actor ${this.actorType} started`, { concurrency });
  }

  /**
   * Stop the actor gracefully.
   */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.queue.close();
    this.redis.disconnect();
  }

  // -- State persistence via Redis --

  private async loadState(key: string): Promise<TState | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TState;
    } catch {
      return null;
    }
  }

  private async saveState(key: string, state: TState): Promise<void> {
    await this.redis.set(key, JSON.stringify(state), 'EX', 86400); // 24h TTL
  }

  // -- Supervision --

  private recordRestart(): void {
    this.restartTimes.push(Date.now());
    // Prune restarts outside the window
    const cutoff = Date.now() - this.supervision.windowMs;
    this.restartTimes = this.restartTimes.filter((t) => t > cutoff);
  }

  private isOverRestartLimit(): boolean {
    return this.restartTimes.length > this.supervision.maxRestarts;
  }

  /**
   * Clear an actor instance's state (e.g., when session ends).
   */
  async clearState(actorId: string): Promise<void> {
    const key = `actor-${this.actorType}:${actorId}:state`;
    await this.redis.del(key);
  }
}
