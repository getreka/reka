/**
 * Scheduled Maintenance Service
 *
 * Runs periodic deduplication and cleanup of memory collections.
 * - Finds clusters of similar memories (above threshold)
 * - Merges clusters into single consolidated memories
 * - Deletes superseded memories after grace period
 */

import config from '../config';
import { logger } from '../utils/logger';
import { vectorStore } from './vector-store';

class ScheduledMaintenance {
  private interval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (!config.MAINTENANCE_ENABLED) {
      logger.info('Scheduled maintenance disabled');
      return;
    }

    const intervalMs = config.MAINTENANCE_INTERVAL_HOURS * 3600000;
    this.interval = setInterval(() => this.runCycle(), intervalMs);
    this.interval.unref();

    // First run after 5 minutes (let services initialize)
    const startDelay = setTimeout(() => this.runCycle(), 300000);
    startDelay.unref();

    logger.info('Scheduled maintenance started', {
      intervalHours: config.MAINTENANCE_INTERVAL_HOURS,
      dedupThreshold: config.DEDUP_SIMILARITY_THRESHOLD,
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runCycle(): Promise<void> {
    logger.info('Maintenance cycle starting');
    const startTime = Date.now();

    try {
      const projects = await this.getActiveProjects();
      let totalMerged = 0;
      let totalDeleted = 0;

      for (const project of projects) {
        try {
          const { merged, deleted } = await this.deduplicateProject(project);
          totalMerged += merged;
          totalDeleted += deleted;
        } catch (err: any) {
          logger.error(`Maintenance failed for ${project}`, { error: err.message });
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('Maintenance cycle complete', {
        projects: projects.length,
        totalMerged,
        totalDeleted,
        durationMs,
      });
    } catch (err: any) {
      logger.error('Maintenance cycle failed', { error: err.message });
    }
  }

  async deduplicateProject(projectName: string): Promise<{ merged: number; deleted: number }> {
    const collection = `${projectName}_agent_memory`;
    let merged = 0;
    let deleted = 0;

    // 1. Delete superseded memories older than grace period
    if (config.DEDUP_DELETE_SUPERSEDED) {
      deleted = await this.deleteSuperseded(collection);
    }

    // 2. Find and merge duplicate clusters
    // Use memoryService.mergeMemories if available, otherwise just mark superseded
    try {
      const { memoryService } = await import('./memory');
      const mergeResult = await memoryService.mergeMemories({
        projectName,
        threshold: config.DEDUP_SIMILARITY_THRESHOLD,
        dryRun: false,
        limit: config.DEDUP_MAX_CLUSTERS,
      });
      merged = Array.isArray(mergeResult) ? mergeResult.length : 0;
    } catch (err: any) {
      logger.debug('Memory merge skipped', { error: err.message?.slice(0, 80) });
    }

    if (merged > 0 || deleted > 0) {
      logger.info(`Maintenance: ${projectName}`, { merged, deleted });
    }

    return { merged, deleted };
  }

  private async deleteSuperseded(collection: string): Promise<number> {
    try {
      const graceDays = config.DEDUP_DELETE_GRACE_DAYS;
      const cutoff = new Date(Date.now() - graceDays * 86400000).toISOString();

      // Scroll for superseded points
      const { points } = await vectorStore.scrollCollection(collection, 500);

      // Filter: only superseded + older than grace period
      const toDelete = points.filter((p: any) => {
        if (!p.payload?.supersededBy) return false;
        const supersededAt = (p.payload?.supersededAt as string) || (p.payload?.createdAt as string);
        return supersededAt && supersededAt < cutoff;
      });

      if (toDelete.length === 0) return 0;

      const ids = toDelete.map(p => p.id as string);
      await vectorStore.delete(collection, ids);

      logger.debug(`Deleted ${ids.length} superseded memories from ${collection}`);
      return ids.length;
    } catch (err: any) {
      logger.debug('Delete superseded failed', { error: err.message?.slice(0, 80) });
      return 0;
    }
  }

  private async getActiveProjects(): Promise<string[]> {
    try {
      const collections = await vectorStore.listCollections();
      return [...new Set(
        collections
          .filter((c: string) => c.endsWith('_agent_memory'))
          .map((c: string) => c.replace('_agent_memory', ''))
      )];
    } catch {
      return [];
    }
  }
}

export const scheduledMaintenance = new ScheduledMaintenance();
