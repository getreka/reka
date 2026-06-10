/**
 * Memory Versions Service — append-only audit log for memory mutations.
 *
 * STORAGE BACKEND: Redis list (via cacheService), NOT a Qdrant collection.
 *
 * Rationale (lighter backend justification):
 *   - Versioning is an append-only audit log keyed per project / per memory. Redis
 *     lists (RPUSH/LRANGE) model this natively and are O(1) to append.
 *   - Versions never need semantic search, so generating an embedding (a network
 *     round-trip to BGE-M3) per mutation — as a Qdrant point would require — is pure
 *     overhead. Recording must be cheap and non-blocking so it never slows a remember.
 *   - No collection lifecycle / vector-dimension management to maintain.
 *   - Consistent with the rest of the human-memory pipeline, which already uses Redis
 *     Streams + Hashes (sensory buffer, working memory, governance counters).
 *
 * Keys:
 *   ${project}_memory_versions            → global per-project list of versionIds
 *   ${project}_memory_versions:<memoryId> → per-memory list of versionIds
 *   ${project}_memory_versions:v:<versionId> → the immutable version record (JSON)
 *
 * Every mutation records: op (created|modified|deleted), memoryId, actor, ISO
 * timestamp, sha256 content hash, and a content snapshot. redact() clears the
 * snapshot but keeps actor + timestamp + hash for tamper-evidence.
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { cacheService } from './cache';
import { logger } from '../utils/logger';

export type VersionOp = 'created' | 'modified' | 'deleted';
export type VersionActor = 'session' | 'api' | 'governance';

export interface MemoryVersion {
  versionId: string;
  projectName: string;
  memoryId: string;
  op: VersionOp;
  actor: VersionActor;
  timestamp: string; // ISO
  contentHash: string; // sha256 of the content snapshot
  /** Immutable content snapshot. null after redaction. */
  content: string | null;
  type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Set by redact() — actor+timestamp+hash are retained for audit. */
  redacted?: boolean;
}

export interface RecordVersionInput {
  op: VersionOp;
  memoryId: string;
  actor?: VersionActor;
  content: string;
  type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// Cap list length so the audit log can't grow unbounded (newest kept).
const MAX_VERSIONS_PER_PROJECT = 10000;
const MAX_VERSIONS_PER_MEMORY = 500;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

class MemoryVersionsService {
  private projectKey(projectName: string): string {
    return `${projectName}_memory_versions`;
  }

  private memoryKey(projectName: string, memoryId: string): string {
    return `${projectName}_memory_versions:${memoryId}`;
  }

  private versionKey(projectName: string, versionId: string): string {
    return `${projectName}_memory_versions:v:${versionId}`;
  }

  /**
   * Append an immutable version record. Fire-and-forget safe: a missing Redis
   * client (or any failure) just means no audit entry — it never throws to the
   * caller, so a failed log can never break a remember/forget/promote.
   */
  async record(projectName: string, input: RecordVersionInput): Promise<MemoryVersion | null> {
    const client = cacheService.getClient();
    if (!client) return null;

    const version: MemoryVersion = {
      versionId: uuidv4(),
      projectName,
      memoryId: input.memoryId,
      op: input.op,
      actor: input.actor ?? 'api',
      timestamp: new Date().toISOString(),
      contentHash: sha256(input.content ?? ''),
      content: input.content ?? '',
      type: input.type,
      tags: input.tags,
      metadata: input.metadata,
    };

    try {
      const projKey = this.projectKey(projectName);
      const memKey = this.memoryKey(projectName, input.memoryId);
      const verKey = this.versionKey(projectName, version.versionId);

      const pipeline = client.pipeline();
      pipeline.set(verKey, JSON.stringify(version));
      // Newest-first ordering via LPUSH; trim to cap.
      pipeline.lpush(projKey, version.versionId);
      pipeline.ltrim(projKey, 0, MAX_VERSIONS_PER_PROJECT - 1);
      pipeline.lpush(memKey, version.versionId);
      pipeline.ltrim(memKey, 0, MAX_VERSIONS_PER_MEMORY - 1);
      await pipeline.exec();

      return version;
    } catch (err: any) {
      logger.debug('Failed to record memory version', {
        project: projectName,
        memoryId: input.memoryId,
        error: err?.message,
      });
      return null;
    }
  }

  /**
   * List versions for a project, optionally filtered by memoryId. Newest-first.
   */
  async list(
    projectName: string,
    options: { memoryId?: string; limit?: number } = {}
  ): Promise<MemoryVersion[]> {
    const client = cacheService.getClient();
    if (!client) return [];

    const { memoryId, limit = 100 } = options;
    const listKey = memoryId ? this.memoryKey(projectName, memoryId) : this.projectKey(projectName);

    try {
      const ids = await client.lrange(listKey, 0, limit - 1);
      if (ids.length === 0) return [];

      const keys = ids.map((id) => this.versionKey(projectName, id));
      const raw = await client.mget(...keys);
      const versions: MemoryVersion[] = [];
      for (const item of raw) {
        if (item) {
          try {
            versions.push(JSON.parse(item) as MemoryVersion);
          } catch {
            // skip corrupt entry
          }
        }
      }
      return versions;
    } catch (err: any) {
      logger.debug('Failed to list memory versions', {
        project: projectName,
        memoryId,
        error: err?.message,
      });
      return [];
    }
  }

  /**
   * Get a single version by id.
   */
  async get(projectName: string, versionId: string): Promise<MemoryVersion | null> {
    const client = cacheService.getClient();
    if (!client) return null;

    try {
      const raw = await client.get(this.versionKey(projectName, versionId));
      if (!raw) return null;
      return JSON.parse(raw) as MemoryVersion;
    } catch (err: any) {
      logger.debug('Failed to get memory version', {
        project: projectName,
        versionId,
        error: err?.message,
      });
      return null;
    }
  }

  /**
   * Restore a memory from a stored version snapshot, UNDER ITS ORIGINAL ID.
   * Returns the (unchanged) memoryId, or null if the version is missing/redacted
   * (no content to restore).
   *
   * The memory is re-embedded and upserted directly at id = version.memoryId
   * (mirroring how MemoryService.remember persists: same `${project}_agent_memory`
   * collection, same embedding-text format, same payload shape). Routing through
   * memoryService.remember() would mint a BRAND-NEW uuid, orphaning every
   * supersededBy/relationship pointer to the original id and duplicating the
   * memory on a second rollback. Upserting the same id keeps existing references
   * valid and makes a repeat rollback idempotent (overwrite, not duplicate).
   */
  async rollback(projectName: string, versionId: string): Promise<{ memoryId: string } | null> {
    const version = await this.get(projectName, versionId);
    if (!version) return null;
    if (version.redacted || version.content === null) {
      logger.debug('Cannot rollback a redacted version', { project: projectName, versionId });
      return null;
    }

    // Lazy imports to avoid a circular dependency (memory.ts imports this module).
    const { vectorStore } = await import('./vector-store');
    const { embeddingService } = await import('./embedding');
    const { memoryService } = await import('./memory');

    const memoryId = version.memoryId;
    const collectionName = `${projectName}_agent_memory`;
    const content = version.content;
    const type = (version.type as any) ?? 'note';
    const tags = version.tags ?? [];

    // If the original point still exists, fetch it so we can preserve fields the
    // snapshot doesn't carry (createdAt, source, confidence, relationships, …)
    // and overwrite in place. If it's gone (rollback-of-delete), reconstruct from
    // the snapshot. getById is best-effort — a failure just means no existing point.
    let existing: import('./memory').Memory | null = null;
    try {
      existing = await memoryService.getById(projectName, memoryId);
    } catch (err: any) {
      logger.debug('rollback getById failed; reconstructing from snapshot', {
        project: projectName,
        memoryId,
        error: err?.message,
      });
    }

    // relatedTo isn't carried on the version snapshot, so prefer the live point's
    // value, then any value stashed in the snapshot metadata.
    const relatedTo =
      existing?.relatedTo ?? (version.metadata?.relatedTo as string | undefined) ?? undefined;

    const nowIso = new Date().toISOString();
    const rollbackMetadata = {
      ...(existing?.metadata ?? {}),
      ...(version.metadata ?? {}),
      rolledBackFrom: versionId,
      rolledBackAt: nowIso,
    };

    // Embedding text MUST match MemoryService.remember exactly so the restored
    // point ranks identically in recall.
    const embedding = await embeddingService.embed(
      `${type}: ${content}${relatedTo ? ` (related to: ${relatedTo})` : ''}${tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''}`
    );

    // Build the payload from the existing memory when present (preserving its
    // identity fields), otherwise from the snapshot. The id stays the ORIGINAL.
    const payload: Record<string, unknown> = {
      ...(existing ?? {}),
      id: memoryId,
      type,
      content,
      tags,
      relatedTo,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      metadata: rollbackMetadata,
      // A restored memory is no longer superseded by anything.
      supersededBy: undefined,
      project: projectName,
    };

    await vectorStore.upsert(collectionName, [{ id: memoryId, vector: embedding, payload }]);

    // Record the restore against the SAME memoryId so the audit trail stays
    // attached to the original memory (not a new orphan).
    await this.record(projectName, {
      op: 'modified',
      memoryId,
      actor: 'api',
      content,
      type,
      tags,
      metadata: rollbackMetadata,
    });

    logger.info('Memory rolled back from version', {
      project: projectName,
      versionId,
      memoryId,
    });
    return { memoryId };
  }

  /**
   * Redact a version: clear the content snapshot but keep actor + timestamp +
   * hash + op for audit. Idempotent. Returns the redacted version, or null if
   * the version does not exist.
   */
  async redact(projectName: string, versionId: string): Promise<MemoryVersion | null> {
    const client = cacheService.getClient();
    if (!client) return null;

    const version = await this.get(projectName, versionId);
    if (!version) return null;

    const redactedVersion: MemoryVersion = {
      ...version,
      content: null,
      tags: undefined,
      metadata: undefined,
      redacted: true,
    };

    try {
      await client.set(this.versionKey(projectName, versionId), JSON.stringify(redactedVersion));
      logger.info('Memory version redacted', { project: projectName, versionId });
      return redactedVersion;
    } catch (err: any) {
      logger.debug('Failed to redact memory version', {
        project: projectName,
        versionId,
        error: err?.message,
      });
      return null;
    }
  }
}

export const memoryVersions = new MemoryVersionsService();
export default memoryVersions;
