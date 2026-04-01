/**
 * Memory Migration — migrate durable memories to episodic/semantic LTM.
 *
 * Scrolls {project}_agent_memory, classifies each as episodic or semantic,
 * copies to new collections with Ebbinghaus fields. Old collection preserved.
 */

import { vectorStore } from './vector-store';
import { memoryLtm, type SemanticSubtype } from './memory-ltm';
import { logger } from '../utils/logger';
import config from '../config';

// ── Classification Rules ──────────────────────────────────

/** Map memory type → LTM target */
const TYPE_TO_LTM: Record<string, 'episodic' | 'semantic'> = {
  conversation: 'episodic',
  context: 'episodic',
  note: 'episodic',
  decision: 'semantic',
  insight: 'semantic',
  procedure: 'semantic',
  todo: 'episodic',
};

/** Map memory type → semantic subtype (only for semantic memories) */
const TYPE_TO_SUBTYPE: Record<string, SemanticSubtype> = {
  decision: 'decision',
  insight: 'insight',
  procedure: 'procedure',
};

// ── Types ─────────────────────────────────────────────────

export interface MigrationResult {
  totalScanned: number;
  episodicCreated: number;
  semanticCreated: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

// ── Service ───────────────────────────────────────────────

class MemoryMigrationService {
  /**
   * Migrate all durable memories to episodic/semantic LTM collections.
   * Idempotent: skips memories that already exist in target collections.
   */
  async migrate(projectName: string, opts?: { dryRun?: boolean }): Promise<MigrationResult> {
    const startTime = Date.now();
    const dryRun = opts?.dryRun ?? false;
    const sourceCollection = `${projectName}_agent_memory`;

    const result: MigrationResult = {
      totalScanned: 0,
      episodicCreated: 0,
      semanticCreated: 0,
      skipped: 0,
      errors: 0,
      durationMs: 0,
    };

    // Check if source collection exists
    try {
      await vectorStore.getCollectionInfo(sourceCollection);
    } catch {
      logger.info('Migration: source collection not found', { sourceCollection });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Build set of existing IDs in target collections to skip duplicates
    const existingIds = new Set<string>();
    for (const col of [`${projectName}_memory_episodic`, `${projectName}_memory_semantic`]) {
      try {
        let offset: string | undefined;
        do {
          const page = await vectorStore.scrollCollection(col, 100, offset);
          for (const p of page.points) {
            existingIds.add(String(p.id));
          }
          offset = page.nextOffset as string | undefined;
        } while (offset);
      } catch {
        // Collection may not exist yet — that's fine
      }
    }

    // Scroll through source collection and migrate
    let offset: string | undefined;
    do {
      const page = await vectorStore.scrollCollection(sourceCollection, 50, offset, true);

      for (const point of page.points) {
        result.totalScanned++;
        const id = String(point.id);
        const payload = point.payload;

        // Skip if already migrated
        if (existingIds.has(id)) {
          result.skipped++;
          continue;
        }

        // Skip superseded
        if (payload.supersededBy) {
          result.skipped++;
          continue;
        }

        const type = (payload.type as string) ?? 'note';
        const target = TYPE_TO_LTM[type] ?? 'episodic';

        if (dryRun) {
          if (target === 'episodic') result.episodicCreated++;
          else result.semanticCreated++;
          continue;
        }

        try {
          if (target === 'episodic') {
            await memoryLtm.storeEpisodic({
              projectName,
              content: (payload.content as string) ?? '',
              sessionId: (payload.metadata as any)?.sessionId ?? 'migrated',
              files: [],
              tags: (payload.tags as string[]) ?? [],
              metadata: {
                migratedFrom: 'agent_memory',
                migratedAt: new Date().toISOString(),
                originalId: id,
              },
            });
            result.episodicCreated++;
          } else {
            await memoryLtm.storeSemantic({
              projectName,
              content: (payload.content as string) ?? '',
              subtype: TYPE_TO_SUBTYPE[type] ?? 'insight',
              confidence: (payload.confidence as number) ?? 0.7,
              tags: (payload.tags as string[]) ?? [],
              source: 'migration',
              metadata: {
                migratedFrom: 'agent_memory',
                migratedAt: new Date().toISOString(),
                originalId: id,
                validated: payload.validated ?? false,
              },
            });
            result.semanticCreated++;
          }
        } catch (err: any) {
          result.errors++;
          logger.debug('Migration: failed to store memory', { id, error: err.message });
        }
      }

      offset = page.nextOffset as string | undefined;
    } while (offset);

    result.durationMs = Date.now() - startTime;

    logger.info('Migration complete', {
      projectName,
      dryRun,
      ...result,
    });

    return result;
  }
}

export const memoryMigration = new MemoryMigrationService();
