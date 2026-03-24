/**
 * Reconsolidation Service — memories change when recalled.
 *
 * In neuroscience, recalling a memory makes it labile — it can be updated
 * with new context before being re-stored. This service implements:
 *
 * 1. Spaced repetition: each recall strengthens stability (Ebbinghaus S *= factor)
 * 2. Co-recall tracking: memories recalled together build implicit relationships
 * 3. Tag enrichment: recalled in new context → enrich tags (max N per recall)
 */

import { cacheService } from './cache';
import { memoryLtm } from './memory-ltm';
import { relationshipClassifier } from './relationship-classifier';
import { vectorStore } from './vector-store';
import { logger } from '../utils/logger';
import config from '../config';
import type { MemoryRelation } from './memory';

// ── Types ─────────────────────────────────────────────────

export interface RecalledMemory {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  collection?: 'episodic' | 'semantic' | 'durable';
}

export interface CoRecallStats {
  memoryId: string;
  pairs: Array<{ otherId: string; count: number }>;
}

// ── Service ───────────────────────────────────────────────

class ReconsolidationService {
  /**
   * Process recalled memories: strengthen, track co-recalls, enrich tags.
   * Fire-and-forget — must never throw or delay the caller.
   */
  async onRecall(
    projectName: string,
    results: RecalledMemory[],
    queryContext: string
  ): Promise<void> {
    if (results.length === 0) return;

    const tasks: Promise<void>[] = [];

    // 1. Strengthen each recalled memory (spaced repetition)
    for (const mem of results) {
      if (mem.collection === 'episodic' || mem.collection === 'semantic') {
        tasks.push(
          memoryLtm.strengthenOnRecall(projectName, mem.id, mem.collection)
            .catch(err => logger.debug('Strengthen failed', { id: mem.id, error: err.message }))
        );
      }
    }

    // 2. Co-recall tracking: pairs of memories recalled together
    if (results.length >= 2) {
      tasks.push(this.trackCoRecalls(projectName, results));
    }

    // 3. Tag enrichment (skipped for now if we have too few results)
    // Enrichment is more meaningful with full LTM results, deferred to processCoRecalls

    await Promise.allSettled(tasks);
  }

  /**
   * Track co-recall pairs in Redis sorted sets.
   * When two memories appear in the same recall result, increment their co-recall count.
   */
  private async trackCoRecalls(projectName: string, results: RecalledMemory[]): Promise<void> {
    const redis = cacheService.getClient();
    if (!redis) return;

    try {
      const ttlSeconds = config.CORECALL_TTL_DAYS * 24 * 3600;

      // Generate all unique pairs
      for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
          const a = results[i].id;
          const b = results[j].id;

          const keyA = `corecall:${projectName}:${a}`;
          const keyB = `corecall:${projectName}:${b}`;

          // Bidirectional: A↔B
          await redis.zincrby(keyA, 1, b);
          await redis.zincrby(keyB, 1, a);

          // Refresh TTL
          await redis.expire(keyA, ttlSeconds);
          await redis.expire(keyB, ttlSeconds);
        }
      }
    } catch (error: any) {
      logger.debug('Co-recall tracking failed', { error: error.message });
    }
  }

  /**
   * Process co-recall pairs that exceed the threshold.
   * Creates relationships between memories that are frequently co-recalled.
   * Call this periodically or at consolidation time.
   */
  async processCoRecalls(projectName: string): Promise<{
    processed: number;
    relationshipsCreated: number;
  }> {
    const redis = cacheService.getClient();
    if (!redis) return { processed: 0, relationshipsCreated: 0 };

    let processed = 0;
    let relationshipsCreated = 0;

    try {
      // Scan for co-recall keys
      const pattern = `corecall:${projectName}:*`;
      let cursor = '0';
      const seenPairs = new Set<string>();

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          const memoryId = key.replace(`corecall:${projectName}:`, '');

          // Get pairs above threshold
          const pairs = await redis.zrangebyscore(
            key, config.CORECALL_THRESHOLD, '+inf', 'WITHSCORES'
          );

          for (let i = 0; i < pairs.length; i += 2) {
            const otherId = pairs[i];
            const count = parseInt(pairs[i + 1], 10);
            const pairKey = [memoryId, otherId].sort().join(':');

            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            processed++;

            // Classify relationship between these co-recalled memories
            try {
              const memA = await this.getMemoryContent(projectName, memoryId);
              const memB = await this.getMemoryContent(projectName, otherId);

              if (memA && memB) {
                const classified = await relationshipClassifier.classify(
                  { content: memA.content, type: memA.type },
                  [{ id: otherId, content: memB.content, type: memB.type }]
                );

                if (classified.length > 0) {
                  // Store relationship on both memories
                  await this.addRelationship(projectName, memoryId, {
                    targetId: otherId,
                    type: classified[0].type as any,
                    reason: `Co-recalled ${count} times: ${classified[0].reason}`,
                  });
                  await this.addRelationship(projectName, otherId, {
                    targetId: memoryId,
                    type: classified[0].type as any,
                    reason: `Co-recalled ${count} times: ${classified[0].reason}`,
                  });
                  relationshipsCreated++;
                }
              }

              // Reset counter for this pair
              await redis.zrem(key, otherId);
              await redis.zrem(`corecall:${projectName}:${otherId}`, memoryId);
            } catch (err: any) {
              logger.debug('Co-recall relationship creation failed', {
                memoryId, otherId, error: err.message,
              });
            }
          }
        }
      } while (cursor !== '0');
    } catch (error: any) {
      logger.debug('processCoRecalls failed', { error: error.message });
    }

    if (relationshipsCreated > 0) {
      logger.info('Co-recall relationships created', { processed, relationshipsCreated, projectName });
    }

    return { processed, relationshipsCreated };
  }

  /**
   * Get co-recall stats for a specific memory.
   */
  async getCoRecallStats(projectName: string, memoryId: string): Promise<CoRecallStats> {
    const redis = cacheService.getClient();
    if (!redis) return { memoryId, pairs: [] };

    try {
      const key = `corecall:${projectName}:${memoryId}`;
      const pairs = await redis.zrevrangebyscore(key, '+inf', '1', 'WITHSCORES', 'LIMIT', 0, 20);

      const result: CoRecallStats = { memoryId, pairs: [] };
      for (let i = 0; i < pairs.length; i += 2) {
        result.pairs.push({ otherId: pairs[i], count: parseInt(pairs[i + 1], 10) });
      }
      return result;
    } catch {
      return { memoryId, pairs: [] };
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private async getMemoryContent(
    projectName: string,
    memoryId: string
  ): Promise<{ content: string; type: string } | null> {
    // Try semantic first, then episodic, then durable
    for (const collection of [
      `${projectName}_memory_semantic`,
      `${projectName}_memory_episodic`,
      `${projectName}_agent_memory`,
    ]) {
      try {
        const client = (vectorStore as any).client;
        const retrieved = await client.retrieve(collection, {
          ids: [memoryId],
          with_payload: true,
        });
        if (retrieved?.length > 0) {
          const p = retrieved[0].payload;
          return {
            content: (p.content as string) ?? '',
            type: (p.subtype ?? p.type ?? 'note') as string,
          };
        }
      } catch {
        // Collection may not exist, continue
      }
    }
    return null;
  }

  private async addRelationship(
    projectName: string,
    memoryId: string,
    relation: MemoryRelation
  ): Promise<void> {
    // Try all collections to find the memory
    for (const collection of [
      `${projectName}_memory_semantic`,
      `${projectName}_memory_episodic`,
      `${projectName}_agent_memory`,
    ]) {
      try {
        const client = (vectorStore as any).client;
        const retrieved = await client.retrieve(collection, {
          ids: [memoryId],
          with_payload: true,
        });
        if (retrieved?.length > 0) {
          const existing = (retrieved[0].payload.relationships as MemoryRelation[]) ?? [];
          // Don't duplicate
          if (existing.some(r => r.targetId === relation.targetId)) return;

          await client.setPayload(collection, {
            points: [memoryId],
            payload: {
              relationships: [...existing, relation],
            },
          });
          return;
        }
      } catch {
        // Continue to next collection
      }
    }
  }
}

export const reconsolidation = new ReconsolidationService();
