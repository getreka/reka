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
 * timestamp, sha256 content hash, a content snapshot, AND an optional full
 * `snapshot` of the complete memory point payload (all fields, not just content).
 * The full snapshot is what lets rollback() of a DELETED memory reconstruct every
 * field — relatedTo, source, confidence, validated, trigger*, pin, tags, type,
 * factCategory, … — since the Qdrant point is gone and can no longer be fetched.
 * redact() clears both snapshots but keeps actor + timestamp + hash for
 * tamper-evidence.
 */

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
  /**
   * Full memory point payload at mutation time (all fields: relatedTo, source,
   * confidence, validated, trigger*, pin, factCategory, …). Captured so a
   * rollback-of-delete can reconstruct the COMPLETE memory, not just content.
   * Optional / nullable: old records (and content-only mutations) won't have it,
   * and redact() clears it. The triggerEmbedding vector is intentionally NOT
   * stored here (rollback re-embeds content; trigger is re-embedded if present).
   */
  snapshot?: Record<string, unknown> | null;
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
  /** Full memory payload to snapshot (see MemoryVersion.snapshot). */
  snapshot?: Record<string, unknown> | null;
}

// Cap list length so the audit log can't grow unbounded (newest kept).
const MAX_VERSIONS_PER_PROJECT = 10000;
const MAX_VERSIONS_PER_MEMORY = 500;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Strip a snapshot down to the fields rollback needs, dropping bulky/derived data.
 * The triggerEmbedding (a 1024-d vector) is omitted — rollback re-derives it from
 * triggerDescription — so the audit record stays small. The vector-store routing
 * field `project` is also dropped (rollback re-applies it).
 */
function sanitizeSnapshot(
  snapshot: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!snapshot) return undefined;
  const { triggerEmbedding, project, vector, ...rest } = snapshot as Record<string, unknown>;
  void triggerEmbedding;
  void project;
  void vector;
  return rest;
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
      versionId: crypto.randomUUID(),
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
      snapshot: sanitizeSnapshot(input.snapshot),
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
   * Field reconstruction precedence (lowest → highest):
   *   1. the live point (memoryService.getById) — present only if it still exists;
   *      for a rollback-of-DELETE the point is gone and this is null.
   *   2. the version's FULL `snapshot` — every field captured at mutation time
   *      (relatedTo, source, confidence, validated, trigger*, pin, tags, type,
   *      factCategory, relationships, …). This is what makes delete-rollback
   *      lossless: the deleted point is unrecoverable, but the snapshot carries
   *      its complete payload.
   *   3. explicit per-field overrides (content, fresh updatedAt, rollback metadata,
   *      cleared supersededBy).
   *
   * BACKWARD-COMPAT: a version recorded before full snapshots existed has no
   * `snapshot`. In that case we fall back to the prior content-only restore —
   * the live point (if any) supplies the other fields, otherwise only
   * content/type/tags are reconstructed.
   *
   * The memory is re-embedded and upserted directly at id = version.memoryId
   * (mirroring MemoryService.remember: same `${project}_agent_memory` collection,
   * same embedding-text format, same payload shape). Routing through
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
    const snapshot = version.snapshot ?? undefined;

    // If the original point still exists, fetch it so we can preserve fields neither
    // the snapshot nor the explicit overrides carry, and overwrite in place. If it's
    // gone (rollback-of-delete), the full snapshot reconstructs everything. getById
    // is best-effort — a failure just means no existing point.
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

    // type/tags/relatedTo: prefer the full snapshot, then the live point, then the
    // flat version fields (backward-compat for snapshot-less records).
    const type = (snapshot?.type as string) ?? (version.type as any) ?? existing?.type ?? 'note';
    const tags = (snapshot?.tags as string[]) ?? version.tags ?? existing?.tags ?? [];
    const relatedTo =
      (snapshot?.relatedTo as string | undefined) ??
      existing?.relatedTo ??
      (version.metadata?.relatedTo as string | undefined) ??
      undefined;

    const nowIso = new Date().toISOString();
    const rollbackMetadata = {
      ...(existing?.metadata ?? {}),
      ...((snapshot?.metadata as Record<string, unknown> | undefined) ?? {}),
      ...(version.metadata ?? {}),
      rolledBackFrom: versionId,
      rolledBackAt: nowIso,
    };

    // Embedding text MUST match MemoryService.remember exactly so the restored
    // point ranks identically in recall.
    const embedding = await embeddingService.embed(
      `${type}: ${content}${relatedTo ? ` (related to: ${relatedTo})` : ''}${tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''}`
    );

    // Layer the payload: live point (lowest) < full snapshot < explicit overrides.
    // The full snapshot is what restores ALL fields on a delete-rollback
    // (source, confidence, validated, factCategory, pin, trigger*, relationships).
    // The id stays the ORIGINAL.
    const payload: Record<string, unknown> = {
      ...(existing ?? {}),
      ...(snapshot ?? {}),
      id: memoryId,
      type,
      content,
      tags,
      relatedTo,
      createdAt: (snapshot?.createdAt as string | undefined) ?? existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      metadata: rollbackMetadata,
      // A restored memory is no longer superseded by anything.
      supersededBy: undefined,
      project: projectName,
    };

    // Re-derive the trigger embedding from the restored triggerDescription so the
    // stored vector matches the kept cue (the snapshot intentionally omits it).
    // Best-effort — a failed trigger embed must not abort the rollback upsert.
    const triggerDescription = payload.triggerDescription as string | undefined;
    if (triggerDescription) {
      try {
        payload.triggerEmbedding = await embeddingService.embed(triggerDescription);
      } catch (err: any) {
        logger.debug('rollback trigger re-embed failed; restoring without trigger vector', {
          project: projectName,
          memoryId,
          error: err?.message,
        });
        delete payload.triggerEmbedding;
      }
    } else {
      delete payload.triggerEmbedding;
    }

    await vectorStore.upsert(collectionName, [{ id: memoryId, vector: embedding, payload }]);

    // Record the restore against the SAME memoryId so the audit trail stays
    // attached to the original memory (not a new orphan). Carry the full restored
    // payload forward so a rollback of THIS restore is itself lossless.
    await this.record(projectName, {
      op: 'modified',
      memoryId,
      actor: 'api',
      content,
      type,
      tags,
      metadata: rollbackMetadata,
      snapshot: payload,
    });

    logger.info('Memory rolled back from version', {
      project: projectName,
      versionId,
      memoryId,
      restoredFromSnapshot: !!snapshot,
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
      // Clear the full snapshot too — it carries the entire memory payload, which
      // must not survive a redaction any more than the content snapshot does.
      snapshot: null,
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
