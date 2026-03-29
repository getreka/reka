import { Actor } from './base-actor';
import { logger } from '../utils/logger';

/**
 * ActorSystem — manages all actor instances, provides lookup, and handles shutdown.
 */
class ActorSystem {
  private actors: Map<string, Actor<any, any>> = new Map();

  /**
   * Register and start an actor.
   */
  register(actor: Actor<any, any>, concurrency?: number): void {
    if (this.actors.has(actor.actorType)) {
      logger.warn(`Actor ${actor.actorType} already registered — skipping`);
      return;
    }
    this.actors.set(actor.actorType, actor);
    actor.start(concurrency);
  }

  /**
   * Get a registered actor by type.
   */
  get<T extends Actor<any, any>>(actorType: string): T | undefined {
    return this.actors.get(actorType) as T | undefined;
  }

  /**
   * Return status for all registered actors (mailbox depth, active/completed/failed counts).
   */
  async getStatus(): Promise<
    Array<{
      actorType: string;
      mailboxDepth: number;
      activeJobs: number;
      completedJobs: number;
      failedJobs: number;
    }>
  > {
    const statuses = [];
    for (const [type, actor] of this.actors) {
      try {
        const counts = await actor.getQueue().getJobCounts();
        statuses.push({
          actorType: type,
          mailboxDepth: (counts.waiting || 0) + (counts.delayed || 0),
          activeJobs: counts.active || 0,
          completedJobs: counts.completed || 0,
          failedJobs: counts.failed || 0,
        });
      } catch {
        statuses.push({
          actorType: type,
          mailboxDepth: 0,
          activeJobs: 0,
          completedJobs: 0,
          failedJobs: 0,
        });
      }
    }
    return statuses;
  }

  /**
   * Gracefully stop all actors.
   */
  async shutdown(): Promise<void> {
    const stops = [...this.actors.values()].map((a) => a.stop());
    await Promise.allSettled(stops);
    this.actors.clear();
    logger.info('Actor system shut down');
  }
}

export const actorSystem = new ActorSystem();
