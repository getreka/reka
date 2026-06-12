/**
 * Memory Governance Service - Routes memories to quarantine or durable storage
 * based on source (manual vs auto-generated).
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import {
  memoryService,
  Memory,
  MemoryType,
  MemorySource,
  CreateMemoryOptions,
  SearchMemoryOptions,
  MemorySearchResult,
} from './memory';
import { memoryLtm, type SemanticSubtype } from './memory-ltm';
import { qualityGates } from './quality-gates';
import { cacheService } from './cache';
import { memoryVersions } from './memory-versions';
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

  private promotedCounterKey(projectName: string): string {
    return `governance:${projectName}:promoted`;
  }

  private rejectedCounterKey(projectName: string): string {
    return `governance:${projectName}:rejected`;
  }

  private sourceCounterKey(
    projectName: string,
    op: 'ingest' | 'promote' | 'reject',
    source: string
  ): string {
    return `governance:${projectName}:${op}:${source}`;
  }

  /**
   * Atomically bump a governance outcome counter (promote/reject).
   * Best-effort: a missing Redis client just means the threshold stays at default.
   */
  private async incrCounter(key: string): Promise<void> {
    try {
      await cacheService.increment(key, 1);
      // A counter changed → invalidate cached thresholds so the next ingest re-reads.
      this.thresholdCache.clear();
    } catch (err: any) {
      logger.debug('Governance counter increment failed', { key, error: err.message });
    }
  }

  /**
   * Per-source capture-funnel counter (ingest/promote/reject by MemorySource).
   * Unlike incrCounter this does NOT invalidate the adaptive-threshold cache —
   * these counters feed /api/analytics/memory-roi, not the threshold math.
   */
  private async incrSourceCounter(
    projectName: string,
    op: 'ingest' | 'promote' | 'reject',
    source: string
  ): Promise<void> {
    try {
      await cacheService.increment(this.sourceCounterKey(projectName, op, source), 1);
    } catch (err: any) {
      logger.debug('Governance source counter increment failed', {
        op,
        source,
        error: err.message,
      });
    }
  }

  private async readCounter(key: string): Promise<number> {
    try {
      const raw = await cacheService.getClient()?.get(key);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Read the per-source capture-funnel counters. Counters are CUMULATIVE
   * (never windowed/reset) — consumers wanting a window read deltas between
   * snapshots (the memory-roi day-30 review does exactly that).
   */
  async getSourceCounters(
    projectName: string,
    sources: readonly string[]
  ): Promise<Record<string, { ingested: number; promoted: number; rejected: number }>> {
    const out: Record<string, { ingested: number; promoted: number; rejected: number }> = {};
    for (const source of sources) {
      const [ingested, promoted, rejected] = await Promise.all([
        this.readCounter(this.sourceCounterKey(projectName, 'ingest', source)),
        this.readCounter(this.sourceCounterKey(projectName, 'promote', source)),
        this.readCounter(this.sourceCounterKey(projectName, 'reject', source)),
      ]);
      out[source] = { ingested, promoted, rejected };
    }
    return out;
  }

  /**
   * Compute adaptive confidence threshold from explicit promote/reject COUNTERS.
   *
   * Previously this counted the whole quarantine collection as "pending" and
   * derived successRate = promoted / (promoted + pending). That meant a normal
   * unreviewed backlog (lots of pending, zero reviews) drove the threshold to
   * 0.8 and silently dropped new auto-memories. We now use durable review
   * outcomes only: successRate = promoted / (promoted + rejected).
   *
   * High success rate → lower threshold (accept more). High rejection → raise it.
   * Range: [0.4, 0.8], default 0.5 until at least 5 reviews exist.
   */
  async getAdaptiveThreshold(projectName: string): Promise<number> {
    const cached = this.thresholdCache.get(projectName);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const DEFAULT = 0.5;
    try {
      const [promoted, rejected] = await Promise.all([
        this.readCounter(this.promotedCounterKey(projectName)),
        this.readCounter(this.rejectedCounterKey(projectName)),
      ]);

      const reviewed = promoted + rejected;
      if (reviewed < 5) {
        this.thresholdCache.set(projectName, {
          value: DEFAULT,
          expiresAt: Date.now() + 30 * 60 * 1000,
        });
        return DEFAULT;
      }

      const successRate = promoted / reviewed;
      // Map success rate to threshold: high success → lower threshold
      // successRate 0.0 → 0.8, successRate 1.0 → 0.4
      const threshold = Math.max(0.4, Math.min(0.8, 0.8 - successRate * 0.4));

      this.thresholdCache.set(projectName, {
        value: threshold,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      logger.debug(
        `Adaptive threshold for ${projectName}: ${threshold.toFixed(2)} (${promoted}/${reviewed} reviewed promoted)`,
        { project: projectName }
      );
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
      const memory = await memoryService.remember(memoryOptions);

      // Phase 2: also store manual memories in semantic LTM for Ebbinghaus tracking
      if (config.CONSOLIDATION_ENABLED) {
        const subtypeMap: Record<string, SemanticSubtype> = {
          decision: 'decision',
          insight: 'insight',
          procedure: 'procedure',
        };
        const subtype = subtypeMap[memoryOptions.type ?? ''];
        if (subtype) {
          memoryLtm
            .storeSemantic({
              projectName,
              content: memoryOptions.content,
              subtype,
              confidence: 0.9,
              tags: memoryOptions.tags,
              source: 'manual',
              metadata: { durableId: memory.id },
            })
            .catch((err) =>
              logger.debug('LTM store for manual memory failed', { error: err.message })
            );
        }
      }

      return memory;
    }

    // Auto-generated → check adaptive threshold, then quarantine
    const threshold = await this.getAdaptiveThreshold(projectName);
    if (confidence !== undefined && confidence < threshold) {
      logger.debug(
        `Memory below adaptive threshold (${confidence} < ${threshold.toFixed(2)}), skipped`,
        { project: projectName }
      );
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
      triggerDescription: memoryOptions.triggerDescription,
      pin: memoryOptions.pin,
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
    await this.incrSourceCounter(projectName, 'ingest', source);
    logger.info(`Memory quarantined: ${memory.type}`, {
      id: memory.id,
      project: projectName,
      source,
    });
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
        const failedGates = report.gates.filter((g) => !g.passed).map((g) => g.gate);
        throw new Error(
          `Quality gates failed: ${failedGates.join(', ')}. Details: ${report.gates
            .filter((g) => !g.passed)
            .map((g) => g.details)
            .join('; ')}`
        );
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

    // Write durable FIRST — if embed/upsert throws, the quarantine copy is still
    // intact so the promotion can be retried (no data loss). The quarantine point
    // is only deleted AFTER the durable write succeeds.
    const promotedMemory = await memoryService.remember({
      projectName,
      content: payload.content as string,
      type: payload.type as MemoryType,
      tags: (payload.tags as string[]) || [],
      relatedTo: payload.relatedTo as string | undefined,
      metadata: {
        ...((payload.metadata as Record<string, unknown>) || {}),
        validated: true,
        promotedAt: new Date().toISOString(),
        promoteReason: reason,
        promoteEvidence: evidence,
        originalSource: payload.source,
        originalConfidence: payload.confidence,
      },
    });

    // Durable write succeeded → remove the quarantine copy. A failure here leaves
    // a harmless duplicate in quarantine (idempotent: a retry re-finds and re-deletes).
    try {
      await vectorStore.delete(quarantineCollection, [memoryId]);
    } catch (err: any) {
      logger.warn(`Promoted ${memoryId} but failed to remove quarantine copy`, {
        project: projectName,
        error: err.message,
      });
    }

    // Record the review outcome for adaptive-threshold computation.
    await this.incrCounter(this.promotedCounterKey(projectName));
    const promotedSource = payload.source as string | undefined;
    if (promotedSource) {
      await this.incrSourceCounter(projectName, 'promote', promotedSource);
    }

    // Append-only version audit: promotion is a governance-actor MODIFICATION of
    // the memory (quarantine → durable). Fire-and-forget — never block the promote.
    memoryVersions
      .record(projectName, {
        op: 'modified',
        memoryId: promotedMemory.id,
        actor: 'governance',
        content: promotedMemory.content,
        type: promotedMemory.type,
        tags: promotedMemory.tags,
        metadata: {
          ...promotedMemory.metadata,
          promotedFrom: memoryId,
          promoteReason: reason,
        },
        // Snapshot the full promoted memory so a rollback restores every field
        // (validated, confidence, source, relatedTo, …), not just content.
        snapshot: {
          ...promotedMemory,
          project: projectName,
          metadata: {
            ...promotedMemory.metadata,
            promotedFrom: memoryId,
            promoteReason: reason,
          },
        },
      })
      .catch(() => {});

    logger.info(`Memory promoted: ${memoryId} → ${promotedMemory.id}`, {
      project: projectName,
      reason,
    });
    return promotedMemory;
  }

  /**
   * Reject (delete) a memory from quarantine.
   */
  async reject(projectName: string, memoryId: string): Promise<boolean> {
    memoryGovernanceTotal.inc({ operation: 'reject', tier: 'quarantine', project: projectName });
    const quarantineCollection = this.getQuarantineCollection(projectName);

    // Best-effort: read the source BEFORE deleting so the per-source funnel
    // counter can attribute the rejection. A failed read only loses attribution.
    let rejectedSource: string | undefined;
    try {
      const found = await vectorStore['client'].scroll(quarantineCollection, {
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ key: 'id', match: { value: memoryId } }] },
      });
      rejectedSource = (found.points[0]?.payload as Record<string, unknown> | undefined)?.source as
        | string
        | undefined;
    } catch {
      /* source attribution is best-effort */
    }

    try {
      await vectorStore.delete(quarantineCollection, [memoryId]);
      // Record the review outcome for adaptive-threshold computation.
      await this.incrCounter(this.rejectedCounterKey(projectName));
      if (rejectedSource) {
        await this.incrSourceCounter(projectName, 'reject', rejectedSource);
      }
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

    return results.map((r) => ({
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

  /** Map a quarantine scroll point onto the Memory shape. */
  private quarantinePointToMemory(id: unknown, payload: Record<string, unknown>): Memory {
    return {
      id: id as string,
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
  }

  /**
   * List quarantine memories (non-semantic, for review UI).
   *
   * `tag` filters by exact tag match — the memory-tool adapter uses it with
   * `mem:path=…` tags so unpromoted writes stay visible to path-based `view`
   * (read-your-writes) while remaining excluded from `recall` until promoted.
   */
  async listQuarantine(
    projectName: string,
    limit: number = 20,
    offset?: string | number,
    tag?: string
  ): Promise<Memory[]> {
    const collectionName = this.getQuarantineCollection(projectName);

    try {
      const results = await vectorStore['client'].scroll(collectionName, {
        limit,
        offset: offset || undefined,
        with_payload: true,
        with_vector: false,
        ...(tag ? { filter: { must: [{ key: 'tags', match: { any: [tag] } }] } } : {}),
      });

      return results.points.map((p) =>
        this.quarantinePointToMemory(p.id, p.payload as Record<string, unknown>)
      );
    } catch (error: any) {
      if (error.status === 404 || error.status === 400) return [];
      throw error;
    }
  }

  /**
   * Fetch a single quarantine memory by exact id. Returns null when not found
   * or the quarantine collection does not exist yet.
   */
  async getQuarantineById(projectName: string, memoryId: string): Promise<Memory | null> {
    const collectionName = this.getQuarantineCollection(projectName);
    try {
      const results = await vectorStore['client'].scroll(collectionName, {
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ key: 'id', match: { value: memoryId } }] },
      });
      const point = results.points[0];
      if (!point) return null;
      return this.quarantinePointToMemory(point.id, point.payload as Record<string, unknown>);
    } catch (error: any) {
      if (error.status === 404 || error.status === 400) return null;
      throw error;
    }
  }

  /**
   * Delete a quarantine memory WITHOUT recording a review outcome.
   *
   * Used when the memory tool deletes/supersedes its own unpromoted writes
   * (DELETE /api/memory/:id falling through to quarantine). Unlike reject(),
   * this must not increment the rejected counter — a self-correction by the
   * writing agent is not a human review signal and would skew the adaptive
   * promote/reject threshold.
   */
  async deleteFromQuarantine(projectName: string, memoryId: string): Promise<boolean> {
    const collectionName = this.getQuarantineCollection(projectName);
    try {
      await vectorStore.delete(collectionName, [memoryId]);
      logger.info(`Quarantine memory deleted (not counted as review): ${memoryId}`, {
        project: projectName,
      });
      return true;
    } catch (error: any) {
      logger.error(`Failed to delete quarantine memory: ${memoryId}`, { error: error.message });
      return false;
    }
  }
  /**
   * Cleanup expired quarantine memories (older than TTL).
   */
  async cleanupExpiredQuarantine(
    projectName: string
  ): Promise<{ rejected: string[]; errors: string[] }> {
    const end = maintenanceDuration.startTimer({
      operation: 'quarantine_cleanup',
      project: projectName,
    });
    const rejected: string[] = [];
    const errors: string[] = [];

    try {
      const collectionName = this.getQuarantineCollection(projectName);
      const cutoff = new Date(
        Date.now() - config.MEMORY_QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

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
            memoryGovernanceTotal.inc(
              { operation: 'quarantine_expired', tier: 'quarantine', project: projectName },
              chunk.length
            );
          } catch (err: any) {
            errors.push(`Batch delete failed: ${err.message}`);
          }
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset);

      logger.info(`Quarantine cleanup: ${rejected.length} expired memories removed`, {
        project: projectName,
      });
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
        const originalIds = cluster.original.map((m) => m.id);
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
              memoryGovernanceTotal.inc({
                operation: 'compaction_superseded',
                tier: 'durable',
                project: projectName,
              });
            } catch (err: any) {
              logger.debug('Failed to mark superseded during compaction', {
                origId,
                error: err.message,
              });
            }
          }

          memoryGovernanceTotal.inc({
            operation: 'compaction_merged',
            tier: 'durable',
            project: projectName,
          });
          result.clusters.push({ originalIds, mergedId: newMemory.id, mergedContent });
        } else {
          result.clusters.push({ originalIds, mergedContent });
        }
      }

      logger.info(
        `Compaction: ${result.clusters.length} clusters${dryRun ? ' (dry run)' : ' merged'}`,
        { project: projectName }
      );
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
   * Quarantine cleanup runs first, then compaction runs
   * sequentially (avoids race on durable).
   */
  async runMaintenance(
    projectName: string,
    operations?: {
      quarantine_cleanup?: boolean;
      compaction?: boolean;
      compaction_dry_run?: boolean;
    }
  ): Promise<{
    quarantine_cleanup?: { rejected: string[]; errors: string[] };
    compaction?: {
      clusters: Array<{ originalIds: string[]; mergedId?: string; mergedContent: string }>;
      totalClusters: number;
      dryRun: boolean;
    };
  }> {
    // Default: quarantine_cleanup only
    const ops = operations || { quarantine_cleanup: true };
    const result: Record<string, unknown> = {};

    if (ops.quarantine_cleanup) {
      result.quarantine_cleanup = await this.cleanupExpiredQuarantine(projectName);
    }

    // Compaction (sequential — writes to durable)
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
