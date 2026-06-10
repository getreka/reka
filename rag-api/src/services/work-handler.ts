/**
 * WorkHandler — Unified interface for long-running operations.
 *
 * Provides a common status/progress/cancellation layer across:
 * - Indexer (code indexing)
 * - AgentRuntime (ReAct/tool_use agent loops)
 * - ClaudeAgent (autonomous Claude Agent SDK runs)
 *
 * All active work items are registered in a central WorkRegistry
 * and can be queried or cancelled through a single API.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { eventBus } from './event-bus';

export type WorkType = 'indexing' | 'agent' | 'claude-agent';
export type WorkState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface WorkStatus {
  id: string;
  type: WorkType;
  state: WorkState;
  projectName: string;
  description: string;
  progress?: {
    current: number;
    total: number;
    percentage: number;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkHandle {
  id: string;
  type: WorkType;
  /** Update the status of this work item. */
  update(patch: Partial<Pick<WorkStatus, 'state' | 'progress' | 'error' | 'metadata'>>): void;
  /** Mark as completed. */
  complete(metadata?: Record<string, unknown>): void;
  /** Mark as failed. */
  fail(error: string): void;
  /** Get current status. */
  getStatus(): WorkStatus;
}

class WorkRegistry extends EventEmitter {
  private items = new Map<string, WorkStatus>();
  private cancelFns = new Map<string, () => void>();

  /**
   * Register a new work item and get a handle.
   */
  register(opts: {
    id: string;
    type: WorkType;
    projectName: string;
    description: string;
    cancelFn?: () => void;
    metadata?: Record<string, unknown>;
  }): WorkHandle {
    const now = new Date().toISOString();
    const status: WorkStatus = {
      id: opts.id,
      type: opts.type,
      state: 'running',
      projectName: opts.projectName,
      description: opts.description,
      startedAt: now,
      updatedAt: now,
      metadata: opts.metadata,
    };

    this.items.set(opts.id, status);
    if (opts.cancelFn) {
      this.cancelFns.set(opts.id, opts.cancelFn);
    }

    this.emit('registered', status);
    eventBus.publish('work:registered', status as unknown as Record<string, unknown>);
    logger.debug(`Work registered: ${opts.type}/${opts.id}`, { projectName: opts.projectName });

    const handle: WorkHandle = {
      id: opts.id,
      type: opts.type,

      update: (patch) => {
        const item = this.items.get(opts.id);
        if (!item) return;

        if (patch.state !== undefined) item.state = patch.state;
        if (patch.progress !== undefined) item.progress = patch.progress;
        if (patch.error !== undefined) item.error = patch.error;
        if (patch.metadata !== undefined) item.metadata = { ...item.metadata, ...patch.metadata };
        item.updatedAt = new Date().toISOString();

        this.emit('updated', item);
        eventBus.publish('work:updated', item as unknown as Record<string, unknown>);
      },

      complete: (metadata) => {
        const item = this.items.get(opts.id);
        if (!item) return;

        const now = new Date().toISOString();
        item.state = 'completed';
        item.completedAt = now;
        item.updatedAt = now;
        item.durationMs = new Date(now).getTime() - new Date(item.startedAt).getTime();
        if (metadata) item.metadata = { ...item.metadata, ...metadata };

        this.cancelFns.delete(opts.id);
        this.emit('completed', item);
        eventBus.publish('work:completed', item as unknown as Record<string, unknown>);
        this.scheduleCleanup(opts.id);
      },

      fail: (error: string) => {
        const item = this.items.get(opts.id);
        if (!item) return;

        const now = new Date().toISOString();
        item.state = 'failed';
        item.error = error;
        item.completedAt = now;
        item.updatedAt = now;
        item.durationMs = new Date(now).getTime() - new Date(item.startedAt).getTime();

        this.cancelFns.delete(opts.id);
        this.emit('failed', item);
        eventBus.publish('work:failed', item as unknown as Record<string, unknown>);
        this.scheduleCleanup(opts.id);
      },

      getStatus: () => {
        return { ...(this.items.get(opts.id) || status) };
      },
    };

    return handle;
  }

  /**
   * Cancel a work item by ID.
   */
  cancel(id: string): boolean {
    const cancelFn = this.cancelFns.get(id);
    const item = this.items.get(id);

    if (!cancelFn || !item) return false;
    if (item.state !== 'running' && item.state !== 'pending') return false;

    cancelFn();
    item.state = 'cancelled';
    item.completedAt = new Date().toISOString();
    item.updatedAt = item.completedAt;
    item.durationMs = new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime();

    this.cancelFns.delete(id);
    this.emit('cancelled', item);
    eventBus.publish('work:cancelled', item as unknown as Record<string, unknown>);
    this.scheduleCleanup(id);

    logger.info(`Work cancelled: ${item.type}/${id}`);
    return true;
  }

  /**
   * Get status of a specific work item.
   */
  get(id: string): WorkStatus | undefined {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  /**
   * List all active work items, optionally filtered.
   */
  list(filter?: { type?: WorkType; projectName?: string; state?: WorkState }): WorkStatus[] {
    let items = Array.from(this.items.values());

    if (filter?.type) items = items.filter((i) => i.type === filter.type);
    if (filter?.projectName) items = items.filter((i) => i.projectName === filter.projectName);
    if (filter?.state) items = items.filter((i) => i.state === filter.state);

    return items.map((i) => ({ ...i }));
  }

  /**
   * Get count of running work items by type.
   */
  getRunningCounts(): Record<WorkType, number> {
    const counts: Record<WorkType, number> = { indexing: 0, agent: 0, 'claude-agent': 0 };
    for (const item of this.items.values()) {
      if (item.state === 'running') {
        counts[item.type]++;
      }
    }
    return counts;
  }

  /**
   * Clean up completed/failed items after a delay (keep recent for querying).
   */
  private scheduleCleanup(id: string): void {
    setTimeout(() => {
      this.items.delete(id);
      this.cancelFns.delete(id);
    }, 5 * 60_000); // 5 minutes
  }
}

export const workRegistry = new WorkRegistry();
