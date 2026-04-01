/**
 * Stale Memory Detector — Find memories that may be outdated.
 *
 * A memory is considered potentially stale if:
 * 1. It's older than a threshold (default 30 days)
 * 2. It references files/functions that no longer exist in the codebase
 * 3. It was auto-extracted with low confidence and never validated
 * 4. It's already superseded by another memory
 *
 * Called at endSession to surface cleanup candidates.
 */

import { vectorStore } from './vector-store';
import { computeRetention } from './memory-ltm';
import { logger } from '../utils/logger';
import config from '../config';
import type { Memory } from './memory';

export interface StaleMemory {
  id: string;
  content: string;
  type: string;
  reason: string;
  createdAt: string;
  confidence?: number;
  tags: string[];
}

export interface StaleDetectionResult {
  staleMemories: StaleMemory[];
  totalScanned: number;
  projectName: string;
}

const STALE_AGE_MS = parseInt(process.env.STALE_MEMORY_AGE_DAYS || '30', 10) * 86_400_000;
const LOW_CONFIDENCE_THRESHOLD = 0.4;

class StaleMemoryDetector {
  /**
   * Detect potentially stale memories for a project.
   */
  async detectStaleMemories(projectName: string): Promise<StaleDetectionResult> {
    const collectionName = `${projectName}_memory`;
    const staleMemories: StaleMemory[] = [];
    let totalScanned = 0;

    try {
      const now = Date.now();
      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 500,
          offset,
          with_payload: true,
          with_vector: false,
        });

        for (const point of response.points) {
          totalScanned++;
          const payload = point.payload as Record<string, unknown>;
          const id = String(point.id);
          const content = (payload.content as string) || '';
          const type = (payload.type as string) || 'note';
          const createdAt = (payload.createdAt as string) || '';
          const confidence = payload.confidence as number | undefined;
          const validated = payload.validated as boolean | undefined;
          const source = payload.source as string | undefined;
          const supersededBy = payload.supersededBy as string | undefined;
          const tags = (payload.tags as string[]) || [];

          // Rule 1: Already superseded
          if (supersededBy) {
            staleMemories.push({
              id,
              content: content.slice(0, 200),
              type,
              reason: `Superseded by ${supersededBy}`,
              createdAt,
              confidence,
              tags,
            });
            continue;
          }

          // Rule 2: Old + auto-extracted + unvalidated
          if (createdAt) {
            const ageMs = now - new Date(createdAt).getTime();
            if (ageMs > STALE_AGE_MS && source === 'auto_conversation' && !validated) {
              staleMemories.push({
                id,
                content: content.slice(0, 200),
                type,
                reason: `Auto-extracted ${Math.round(ageMs / 86_400_000)}d ago, never validated`,
                createdAt,
                confidence,
                tags,
              });
              continue;
            }
          }

          // Rule 3: Low confidence auto-extracted
          if (
            source === 'auto_conversation' &&
            confidence !== undefined &&
            confidence < LOW_CONFIDENCE_THRESHOLD &&
            !validated
          ) {
            staleMemories.push({
              id,
              content: content.slice(0, 200),
              type,
              reason: `Low confidence (${confidence.toFixed(2)}) auto-extracted, never validated`,
              createdAt,
              confidence,
              tags,
            });
            continue;
          }

          // Rule 4: Very old (>90 days) with generic tags
          if (createdAt) {
            const ageMs = now - new Date(createdAt).getTime();
            if (ageMs > 90 * 86_400_000 && type === 'note') {
              staleMemories.push({
                id,
                content: content.slice(0, 200),
                type,
                reason: `Generic note older than 90 days`,
                createdAt,
                confidence,
                tags,
              });
            }
          }
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && totalScanned < 10000);

      // Phase 2: Also scan LTM collections with Ebbinghaus decay rule
      if (config.CONSOLIDATION_ENABLED) {
        for (const ltmCollection of [
          `${projectName}_memory_episodic`,
          `${projectName}_memory_semantic`,
        ]) {
          try {
            let ltmOffset: string | number | undefined = undefined;
            do {
              const response = await vectorStore['client'].scroll(ltmCollection, {
                limit: 500,
                offset: ltmOffset,
                with_payload: true,
                with_vector: false,
              });

              for (const point of response.points) {
                totalScanned++;
                const payload = point.payload as Record<string, unknown>;
                const id = String(point.id);
                const content = (payload.content as string) || '';
                const type = (payload.subtype ?? payload.type ?? 'note') as string;
                const createdAt = ((payload.timestamp ?? payload.createdAt) as string) || '';
                const stability = (payload.stability as number) ?? 7;
                const accessCount = (payload.accessCount as number) ?? 0;
                const tags = (payload.tags as string[]) || [];

                // Ebbinghaus rule: retention < 0.1 AND never accessed → stale
                if (createdAt && accessCount === 0) {
                  const retention = computeRetention(createdAt, stability, accessCount);
                  if (retention < 0.1) {
                    staleMemories.push({
                      id,
                      content: content.slice(0, 200),
                      type,
                      reason: `Ebbinghaus retention ${(retention * 100).toFixed(1)}%, never accessed (stability=${stability}d)`,
                      createdAt,
                      tags,
                    });
                  }
                }
              }

              ltmOffset = response.next_page_offset as string | number | undefined;
            } while (ltmOffset && totalScanned < 10000);
          } catch {
            // Collection may not exist
          }
        }
      }

      logger.info('Stale memory detection complete', {
        projectName,
        totalScanned,
        staleCount: staleMemories.length,
      });

      return { staleMemories, totalScanned, projectName };
    } catch (error: any) {
      if (error.status === 404) {
        return { staleMemories: [], totalScanned: 0, projectName };
      }
      logger.error('Stale memory detection failed', { error: error.message, projectName });
      throw error;
    }
  }
}

export const staleMemoryDetector = new StaleMemoryDetector();
