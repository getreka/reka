/**
 * Memory Governance Service - Routes memories to quarantine or durable storage
 * based on source (manual vs auto-generated).
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { memoryService, Memory, MemoryType, MemorySource, CreateMemoryOptions, SearchMemoryOptions, MemorySearchResult } from './memory';
import { qualityGates } from './quality-gates';
import { feedbackService } from './feedback';
import { logger } from '../utils/logger';
import { memoryGovernanceTotal, maintenanceDuration } from '../utils/metrics';
import config from '../config';

export type PromoteReason = 'human_validated' | 'pr_merged' | 'tests_passed';

export interface IngestOptions extends CreateMemoryOptions {
  source?: MemorySource;
  confidence?: number;
}

class MemoryGovernanceService {
  // Cache adaptive thresholds per project (refresh every 30 min)
  private thresholdCache = new Map<string, { value: number; expiresAt: number }>();
  // Per-project compaction lock to prevent concurrent compaction races
  private compactionLocks = new Set<string>();

  private getQuarantineCollection(projectName: string): string {
    return `${projectName}_memory_pending`;
  }

  private getDurableCollection(projectName: string): string {
    return `${projectName}_agent_memory`;
  }

  /**
   * Compute adaptive confidence threshold from promotion/rejection history.
   * High success rate → lower threshold (accept more). High rejection → raise threshold.
   * Range: [0.4, 0.8], default 0.5.
   */
  async getAdaptiveThreshold(projectName: string): Promise<number> {
    const cached = this.thresholdCache.get(projectName);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const DEFAULT = 0.5;
    try {
      const quarantine = this.getQuarantineCollection(projectName);
      const durable = this.getDurableCollection(projectName);

      // Count promoted (durable with originalSource=auto_*)
      let promoted = 0;
      try {
        const durableResults = await vectorStore['client'].scroll(durable, {
          limit: 200, with_payload: true, with_vector: false,
          filter: {
            should: [
              { key: 'metadata.originalSource', match: { value: 'auto_conversation' } },
              { key: 'metadata.originalSource', match: { value: 'auto_pattern' } },
              { key: 'metadata.originalSource', match: { value: 'auto_feedback' } },
            ],
          },
        });
        promoted = durableResults.points.length;
      } catch { /* collection may not exist */ }

      // Count still in quarantine (rejected or pending)
      let pending = 0;
      try {
        const pendingResults = await vectorStore['client'].scroll(quarantine, {
          limit: 200, with_payload: false, with_vector: false,
        });
        pending = pendingResults.points.length;
      } catch { /* collection may not exist */ }

      const total = promoted + pending;
      if (total < 5) {
        this.thresholdCache.set(projectName, { value: DEFAULT, expiresAt: Date.now() + 30 * 60 * 1000 });
        return DEFAULT;
      }

      const successRate = promoted / total;
      // Map success rate to threshold: high success → lower threshold
      // successRate 0.0 → 0.8, successRate 1.0 → 0.4
      const threshold = Math.max(0.4, Math.min(0.8, 0.8 - successRate * 0.4));

      this.thresholdCache.set(projectName, { value: threshold, expiresAt: Date.now() + 30 * 60 * 1000 });
      logger.debug(`Adaptive threshold for ${projectName}: ${threshold.toFixed(2)} (${promoted}/${total} promoted)`, { project: projectName });
      return threshold;
    } catch (err: any) {
      logger.debug('Adaptive threshold computation failed, using default', { error: err.message });
      return DEFAULT;
    }
  }

  /**
   * Ingest a memory — routes to durable or quarantine based on source.
   * Manual/undefined source → durable; auto_* source → quarantine.
   */
  async ingest(options: IngestOptions): Promise<Memory> {
    const { source, confidence, ...memoryOptions } = options;
    const { projectName } = memoryOptions;

    const isAuto = source && source.startsWith('auto_');

    if (!isAuto) {
      // Manual memory → go straight to durable via existing memoryService
      memoryGovernanceTotal.inc({ operation: 'ingest', tier: 'durable', project: projectName });
      return memoryService.remember(memoryOptions);
    }

    // Auto-generated → check adaptive threshold, then quarantine
    const threshold = await this.getAdaptiveThreshold(projectName);
    if (confidence !== undefined && confidence < threshold) {
      logger.debug(`Memory below adaptive threshold (${confidence} < ${threshold.toFixed(2)}), skipped`, { project: projectName });
      // Return a stub memory without persisting
      return {
        id: uuidv4(),
        type: memoryOptions.type || 'note',
        content: memoryOptions.content,
        tags: memoryOptions.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: { skipped: true, reason: 'below_threshold', threshold, confidence },
      };
    }

    memoryGovernanceTotal.inc({ operation: 'ingest', tier: 'quarantine', project: projectName });
    const collectionName = this.getQuarantineCollection(projectName);

    const memory: Memory = {
      id: uuidv4(),
      type: memoryOptions.type || 'note',
      content: memoryOptions.content,
      tags: memoryOptions.tags || [],
      relatedTo: memoryOptions.relatedTo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source,
      confidence: confidence ?? 0.5,
      validated: false,
      metadata: {
        ...memoryOptions.metadata,
        source,
        confidence: confidence ?? 0.5,
      },
    };

    if (memoryOptions.type === 'todo') {
      memory.status = 'pending';
      memory.statusHistory = [{ status: 'pending', timestamp: memory.createdAt }];
    }

    const embedding = await embeddingService.embed(
      `${memory.type}: ${memory.content}${memory.relatedTo ? ` (related to: ${memory.relatedTo})` : ''}${memory.tags.length > 0 ? ` [tags: ${memory.tags.join(', ')}]` : ''}`
    );

    const point: VectorPoint = {
      id: memory.id,
      vector: embedding,
      payload: {
        ...memory,
        project: projectName,
        source,
        validated: false,
      },
    };

    await vectorStore.upsert(collectionName, [point]);
    logger.info(`Memory quarantined: ${memory.type}`, { id: memory.id, project: projectName, source });
    return memory;
  }

  /**
   * Promote a memory from quarantine → durable.
   */
  async promote(
    projectName: string,
    memoryId: string,
    reason: PromoteReason,
    evidence?: string,
    gateOptions?: { runGates?: boolean; projectPath?: string; affectedFiles?: string[] }
  ): Promise<Memory> {
    // Run quality gates if requested
    if (gateOptions?.runGates && gateOptions?.projectPath) {
      const report = await qualityGates.runGates({
        projectName,
        projectPath: gateOptions.projectPath,
        affectedFiles: gateOptions.affectedFiles,
      });

      if (!report.passed) {
        const failedGates = report.gates.filter(g => !g.passed).map(g => g.gate);
        throw new Error(`Quality gates failed: ${failedGates.join(', ')}. Details: ${report.gates.filter(g => !g.passed).map(g => g.details).join('; ')}`);
      }
    }

    memoryGovernanceTotal.inc({ operation: 'promote', tier: 'durable', project: projectName });
    const quarantineCollection = this.getQuarantineCollection(projectName);

    // Find memory in quarantine by scrolling with filter
    const results = await vectorStore['client'].scroll(quarantineCollection, {
      limit: 1,
      with_payload: true,
      filter: {
        must: [{ key: 'id', match: { value: memoryId } }],
      },
    });

    if (results.points.length === 0) {
      throw new Error(`Memory not found in quarantine: ${memoryId}`);
    }

    const point = results.points[0];
    const payload = point.payload as Record<string, unknown>;

    // Delete from quarantine
    await vectorStore.delete(quarantineCollection, [memoryId]);

    // Promote to durable with metadata
    const promotedMemory = await memoryService.remember({
      projectName,
      content: payload.content as string,
      type: payload.type as MemoryType,
      tags: (payload.tags as string[]) || [],
      relatedTo: payload.relatedTo as string | undefined,
      metadata: {
        ...(payload.metadata as Record<string, unknown> || {}),
        validated: true,
        promotedAt: new Date().toISOString(),
        promoteReason: reason,
        promoteEvidence: evidence,
        originalSource: payload.source,
        originalConfidence: payload.confidence,
      },
    });

    logger.info(`Memory promoted: ${memoryId} → ${promotedMemory.id}`, { project: projectName, reason });
    return promotedMemory;
  }

  /**
   * Reject (delete) a memory from quarantine.
   */
  async reject(projectName: string, memoryId: string): Promise<boolean> {
    memoryGovernanceTotal.inc({ operation: 'reject', tier: 'quarantine', project: projectName });
    const quarantineCollection = this.getQuarantineCollection(projectName);

    try {
      await vectorStore.delete(quarantineCollection, [memoryId]);
      logger.info(`Memory rejected: ${memoryId}`, { project: projectName });
      return true;
    } catch (error: any) {
      logger.error(`Failed to reject memory: ${memoryId}`, { error: error.message });
      return false;
    }
  }

  /**
   * Recall ONLY from durable storage — for enrichment use.
   */
  async recallDurable(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    return memoryService.recall(options);
  }

  /**
   * Recall from quarantine — for review.
   */
  async recallQuarantine(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    const { projectName, query, type = 'all', limit = 20, tag } = options;
    const collectionName = this.getQuarantineCollection(projectName);

    const embedding = await embeddingService.embed(query);

    const mustConditions: Record<string, unknown>[] = [];
    if (type && type !== 'all') {
      mustConditions.push({ key: 'type', match: { value: type } });
    }
    if (tag) {
      mustConditions.push({ key: 'tags', match: { any: [tag] } });
    }

    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

    const results = await vectorStore.search(collectionName, embedding, limit, filter);

    return results.map(r => ({
      memory: {
        id: r.id,
        type: r.payload.type as MemoryType,
        content: r.payload.content as string,
        tags: (r.payload.tags as string[]) || [],
        relatedTo: r.payload.relatedTo as string | undefined,
        createdAt: r.payload.createdAt as string,
        updatedAt: r.payload.updatedAt as string,
        metadata: r.payload.metadata as Record<string, unknown> | undefined,
        source: r.payload.source as MemorySource | undefined,
        confidence: r.payload.confidence as number | undefined,
        validated: r.payload.validated as boolean | undefined,
      },
      score: r.score,
    }));
  }

  /**
   * List quarantine memories (non-semantic, for review UI).
   */
  async listQuarantine(projectName: string, limit: number = 20, offset?: string | number): Promise<Memory[]> {
    const collectionName = this.getQuarantineCollection(projectName);

    try {
      const results = await vectorStore['client'].scroll(collectionName, {
        limit,
        offset: offset || undefined,
        with_payload: true,
        with_vector: false,
      });

      return results.points.map(p => {
        const payload = p.payload as Record<string, unknown>;
        return {
          id: p.id as string,
          type: payload.type as MemoryType,
          content: payload.content as string,
          tags: (payload.tags as string[]) || [],
          relatedTo: payload.relatedTo as string | undefined,
          createdAt: payload.createdAt as string,
          updatedAt: payload.updatedAt as string,
          metadata: payload.metadata as Record<string, unknown> | undefined,
          source: payload.source as MemorySource | undefined,
          confidence: payload.confidence as number | undefined,
          validated: payload.validated as boolean | undefined,
        };
      });
    } catch (error: any) {
      if (error.status === 404) return [];
      throw error;
    }
  }
  /**
   * Auto-promote memories with 3+ positive feedback from quarantine to durable.
   */
  async autoPromoteByFeedback(projectName: string): Promise<{ promoted: string[]; errors: string[] }> {
    const promoted: string[] = [];
    const errors: string[] = [];

    try {
      const feedbackCounts = await feedbackService.getMemoryFeedbackCounts(projectName);

      for (const [memoryId, counts] of feedbackCounts) {
        if (counts.accurate >= 3) {
          try {
            await this.promote(projectName, memoryId, 'human_validated', `Auto-promoted: ${counts.accurate} accurate feedback`);
            promoted.push(memoryId);
          } catch (error: any) {
            // Memory might not be in quarantine (already promoted or durable)
            if (!error.message?.includes('not found in quarantine')) {
              errors.push(`${memoryId}: ${error.message}`);
            }
          }
        }
      }

      if (promoted.length > 0) {
        logger.info(`Auto-promoted ${promoted.length} memories`, { project: projectName });
      }
    } catch (error: any) {
      logger.error('Auto-promote failed', { error: error.message, project: projectName });
    }

    return { promoted, errors };
  }

  /**
   * Auto-prune memories with 2+ incorrect feedback.
   * Deletes from both quarantine and durable.
   */
  async autoPruneByFeedback(projectName: string): Promise<{ pruned: string[]; errors: string[] }> {
    const pruned: string[] = [];
    const errors: string[] = [];

    try {
      const feedbackCounts = await feedbackService.getMemoryFeedbackCounts(projectName);

      for (const [memoryId, counts] of feedbackCounts) {
        if (counts.incorrect >= 2) {
          try {
            // Try quarantine first
            const quarantineCollection = this.getQuarantineCollection(projectName);
            await vectorStore.delete(quarantineCollection, [memoryId]);
            pruned.push(memoryId);
            memoryGovernanceTotal.inc({ operation: 'prune', tier: 'quarantine', project: projectName });
          } catch {
            try {
              // Then try durable
              const durableCollection = this.getDurableCollection(projectName);
              await vectorStore.delete(durableCollection, [memoryId]);
              pruned.push(memoryId);
              memoryGovernanceTotal.inc({ operation: 'prune', tier: 'durable', project: projectName });
            } catch (error: any) {
              errors.push(`${memoryId}: ${error.message}`);
            }
          }
        }
      }

      if (pruned.length > 0) {
        logger.info(`Auto-pruned ${pruned.length} memories`, { project: projectName });
      }
    } catch (error: any) {
      logger.error('Auto-prune failed', { error: error.message, project: projectName });
    }

    return { pruned, errors };
  }

  /**
   * Run both auto-promote and auto-prune in one pass.
   */
  async runFeedbackMaintenance(projectName: string): Promise<{
    promoted: string[];
    pruned: string[];
    errors: string[];
  }> {
    const [promoteResult, pruneResult] = await Promise.all([
      this.autoPromoteByFeedback(projectName),
      this.autoPruneByFeedback(projectName),
    ]);

    return {
      promoted: promoteResult.promoted,
      pruned: pruneResult.pruned,
      errors: [...promoteResult.errors, ...pruneResult.errors],
    };
  }

  /**
   * Cleanup expired quarantine memories (older than TTL).
   */
  async cleanupExpiredQuarantine(projectName: string): Promise<{ rejected: string[]; errors: string[] }> {
    const end = maintenanceDuration.startTimer({ operation: 'quarantine_cleanup', project: projectName });
    const rejected: string[] = [];
    const errors: string[] = [];

    try {
      const collectionName = this.getQuarantineCollection(projectName);
      const cutoff = new Date(Date.now() - config.MEMORY_QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 500,
          offset,
          with_payload: true,
          with_vector: false,
        });

        const idsToDelete: string[] = [];
        for (const point of response.points) {
          const createdAt = (point.payload as Record<string, unknown>).createdAt as string;
          if (createdAt && createdAt < cutoff) {
            idsToDelete.push(point.id as string);
          }
        }

        for (let i = 0; i < idsToDelete.length; i += 100) {
          const chunk = idsToDelete.slice(i, i + 100);
          try {
            await vectorStore.delete(collectionName, chunk);
            rejected.push(...chunk);
            memoryGovernanceTotal.inc({ operation: 'quarantine_expired', tier: 'quarantine', project: projectName }, chunk.length);
          } catch (err: any) {
            errors.push(`Batch delete failed: ${err.message}`);
          }
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset);

      logger.info(`Quarantine cleanup: ${rejected.length} expired memories removed`, { project: projectName });
    } catch (error: any) {
      if (error.status !== 404) {
        errors.push(`Quarantine cleanup failed: ${error.message}`);
        logger.error('Quarantine cleanup failed', { error: error.message, project: projectName });
      }
    } finally {
      end();
    }

    return { rejected, errors };
  }

  /**
   * Run compaction on durable memories — detect clusters of similar memories,
   * merge them, and mark originals as superseded.
   */
  async runCompaction(
    projectName: string,
    options: { dryRun?: boolean; limit?: number } = {}
  ): Promise<{
    clusters: Array<{ originalIds: string[]; mergedId?: string; mergedContent: string }>;
    totalClusters: number;
    dryRun: boolean;
  }> {
    const { dryRun = true, limit = 20 } = options;

    if (this.compactionLocks.has(projectName)) {
      throw new Error(`Compaction already running for project: ${projectName}`);
    }
    this.compactionLocks.add(projectName);

    const end = maintenanceDuration.startTimer({ operation: 'compaction', project: projectName });
    const collectionName = this.getDurableCollection(projectName);

    const result: {
      clusters: Array<{ originalIds: string[]; mergedId?: string; mergedContent: string }>;
      totalClusters: number;
      dryRun: boolean;
    } = { clusters: [], totalClusters: 0, dryRun };

    try {
      // Use existing mergeMemories to detect clusters (always dry-run first)
      const mergeResult = await memoryService.mergeMemories({
        projectName,
        threshold: config.MEMORY_COMPACTION_THRESHOLD,
        dryRun: true,
        limit,
      });

      result.totalClusters = mergeResult.totalMerged;

      if (mergeResult.merged.length === 0) {
        end();
        return result;
      }

      for (const cluster of mergeResult.merged) {
        const originalIds = cluster.original.map(m => m.id);
        const mergedContent = cluster.merged.content;

        if (!dryRun) {
          // Create the merged memory
          const newMemory = await memoryService.remember({
            projectName,
            content: mergedContent,
            type: cluster.merged.type,
            tags: cluster.merged.tags,
            relatedTo: cluster.merged.relatedTo,
            metadata: {
              ...cluster.merged.metadata,
              compactedAt: new Date().toISOString(),
            },
          });

          // Mark originals as superseded (NOT deleted — preserves audit trail)
          for (const origId of originalIds) {
            try {
              await vectorStore['client'].setPayload(collectionName, {
                points: [origId],
                payload: {
                  supersededBy: newMemory.id,
                  updatedAt: new Date().toISOString(),
                },
              });
              memoryGovernanceTotal.inc({ operation: 'compaction_superseded', tier: 'durable', project: projectName });
            } catch (err: any) {
              logger.debug('Failed to mark superseded during compaction', { origId, error: err.message });
            }
          }

          memoryGovernanceTotal.inc({ operation: 'compaction_merged', tier: 'durable', project: projectName });
          result.clusters.push({ originalIds, mergedId: newMemory.id, mergedContent });
        } else {
          result.clusters.push({ originalIds, mergedContent });
        }
      }

      logger.info(`Compaction: ${result.clusters.length} clusters${dryRun ? ' (dry run)' : ' merged'}`, { project: projectName });
    } catch (error: any) {
      if (error.status !== 404) {
        logger.error('Compaction failed', { error: error.message, project: projectName });
        throw error;
      }
    } finally {
      this.compactionLocks.delete(projectName);
      end();
    }

    return result;
  }

  /**
   * Orchestrator: run selected maintenance operations.
   * Quarantine cleanup + feedback maintenance run in parallel,
   * then compaction runs sequentially (avoids race on durable).
   */
  async runMaintenance(
    projectName: string,
    operations?: {
      quarantine_cleanup?: boolean;
      feedback_maintenance?: boolean;
      compaction?: boolean;
      compaction_dry_run?: boolean;
    }
  ): Promise<{
    quarantine_cleanup?: { rejected: string[]; errors: string[] };
    feedback_maintenance?: { promoted: string[]; pruned: string[]; errors: string[] };
    compaction?: {
      clusters: Array<{ originalIds: string[]; mergedId?: string; mergedContent: string }>;
      totalClusters: number;
      dryRun: boolean;
    };
  }> {
    // Default: quarantine_cleanup + feedback_maintenance
    const ops = operations || { quarantine_cleanup: true, feedback_maintenance: true };
    const result: Record<string, unknown> = {};

    // Phase 1: quarantine_cleanup + feedback_maintenance in parallel
    const parallelTasks: Array<Promise<void>> = [];

    if (ops.quarantine_cleanup) {
      parallelTasks.push(
        this.cleanupExpiredQuarantine(projectName).then(r => { result.quarantine_cleanup = r; })
      );
    }

    if (ops.feedback_maintenance) {
      parallelTasks.push(
        this.runFeedbackMaintenance(projectName).then(r => { result.feedback_maintenance = r; })
      );
    }

    await Promise.all(parallelTasks);

    // Phase 2: compaction (sequential — writes to durable)
    if (ops.compaction) {
      result.compaction = await this.runCompaction(projectName, {
        dryRun: ops.compaction_dry_run !== false,
      });
    }

    return result as any;
  }
}

export const memoryGovernance = new MemoryGovernanceService();
export default memoryGovernance;
