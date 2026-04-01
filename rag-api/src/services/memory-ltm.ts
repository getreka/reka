/**
 * Long-Term Memory Service — Episodic + Semantic split with Ebbinghaus decay.
 *
 * Human memory has distinct systems:
 * - Episodic: "What happened" (context-rich, time-bound, fast decay)
 * - Semantic: "What is true" (decontextualized facts, slow decay)
 * - Procedural: "How to do X" (stored as semantic with subtype='procedure')
 *
 * Decay model: retention(t) = e^(-t/S)
 *   where S = baseStability * (1 + accessCount * 0.5)
 *   Each recall increases S by RECALL_STRENGTHENING_FACTOR (default 1.5x)
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
// Note: reconsolidation import is deferred to avoid circular dependency
// reconsolidation is triggered by the caller (memory.ts routes), not internally
import { embeddingService } from './embedding';
import { logger } from '../utils/logger';
import config from '../config';
import type { MemoryRelation } from './memory';
import type { ExtendedRelationType } from './relationship-classifier';

// ── Types ─────────────────────────────────────────────────

export type SemanticSubtype = 'decision' | 'insight' | 'pattern' | 'procedure';

export interface EpisodicMemory {
  id: string;
  content: string;
  sessionId: string;
  timestamp: string;
  files: string[];
  actions: string[];
  outcome?: string;
  tags: string[];
  stability: number; // Ebbinghaus S factor (in days)
  accessCount: number;
  lastAccessed: string;
  relationships?: MemoryRelation[];
  anchors?: Anchor[];
  metadata?: Record<string, unknown>;
}

export interface SemanticMemory {
  id: string;
  content: string;
  subtype: SemanticSubtype;
  confidence: number; // 0-1
  tags: string[];
  stability: number; // Ebbinghaus S factor (in days)
  accessCount: number;
  lastAccessed: string;
  relationships?: MemoryRelation[];
  anchors?: Anchor[];
  createdAt: string;
  updatedAt: string;
  source?: string;
  validated?: boolean;
  supersededBy?: string;
  metadata?: Record<string, unknown>;
}

export interface Anchor {
  type: 'file' | 'symbol';
  path: string;
  name?: string; // symbol name if type='symbol'
}

export interface LtmSearchResult {
  memory: EpisodicMemory | SemanticMemory;
  score: number;
  retention: number; // Ebbinghaus retention at query time
  collection: 'episodic' | 'semantic';
}

export interface StoreEpisodicOptions {
  projectName: string;
  content: string;
  sessionId: string;
  files?: string[];
  actions?: string[];
  outcome?: string;
  tags?: string[];
  anchors?: Anchor[];
  relationships?: MemoryRelation[];
  metadata?: Record<string, unknown>;
}

export interface StoreSemanticOptions {
  projectName: string;
  content: string;
  subtype: SemanticSubtype;
  confidence?: number;
  tags?: string[];
  anchors?: Anchor[];
  relationships?: MemoryRelation[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface LtmRecallOptions {
  projectName: string;
  query: string;
  limit?: number;
  collections?: Array<'episodic' | 'semantic'>;
  subtype?: SemanticSubtype;
  minRetention?: number; // filter out memories below this retention (default 0.1)
}

// ── Ebbinghaus Decay ──────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute Ebbinghaus retention: R(t) = e^(-t/S)
 * S = baseStability * (1 + accessCount * 0.5)
 */
export function computeRetention(
  createdAt: string | number,
  stability: number,
  accessCount: number
): number {
  const ageMs =
    Date.now() - (typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime());
  const ageDays = ageMs / MS_PER_DAY;
  const S = stability * (1 + accessCount * 0.5);
  return Math.exp(-ageDays / S);
}

/**
 * Get base stability for a memory type (in days).
 */
function getBaseStability(type: 'episodic' | SemanticSubtype): number {
  switch (type) {
    case 'episodic':
      return config.EPISODIC_BASE_STABILITY_DAYS;
    case 'procedure':
      return config.PROCEDURAL_BASE_STABILITY_DAYS;
    default:
      return config.SEMANTIC_BASE_STABILITY_DAYS;
  }
}

// ── Service ───────────────────────────────────────────────

class LongTermMemoryService {
  private episodicCollection(project: string): string {
    return `${project}_memory_episodic`;
  }

  private semanticCollection(project: string): string {
    return `${project}_memory_semantic`;
  }

  /**
   * Store an episodic memory (what happened during a session).
   */
  async storeEpisodic(opts: StoreEpisodicOptions): Promise<EpisodicMemory> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const stability = getBaseStability('episodic');

    const memory: EpisodicMemory = {
      id,
      content: opts.content,
      sessionId: opts.sessionId,
      timestamp: now,
      files: opts.files ?? [],
      actions: opts.actions ?? [],
      outcome: opts.outcome,
      tags: opts.tags ?? [],
      stability,
      accessCount: 0,
      lastAccessed: now,
      relationships: opts.relationships,
      anchors: opts.anchors,
      metadata: opts.metadata,
    };

    const embeddingText = `[episodic] ${opts.content}`;
    const embedding = await embeddingService.embed(embeddingText);

    const point: VectorPoint = {
      id,
      vector: embedding,
      payload: {
        ...memory,
        createdAt: now,
        memoryLayer: 'episodic',
      },
    };

    const collection = this.episodicCollection(opts.projectName);
    await vectorStore.upsert(collection, [point]);

    logger.debug('Stored episodic memory', { id, project: opts.projectName });
    return memory;
  }

  /**
   * Store a semantic memory (decontextualized fact/decision/procedure).
   */
  async storeSemantic(opts: StoreSemanticOptions): Promise<SemanticMemory> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const stability = getBaseStability(opts.subtype);

    const memory: SemanticMemory = {
      id,
      content: opts.content,
      subtype: opts.subtype,
      confidence: opts.confidence ?? 0.7,
      tags: opts.tags ?? [],
      stability,
      accessCount: 0,
      lastAccessed: now,
      relationships: opts.relationships,
      anchors: opts.anchors,
      createdAt: now,
      updatedAt: now,
      source: opts.source,
      metadata: opts.metadata,
    };

    const embeddingText = `[${opts.subtype}] ${opts.content}`;
    const embedding = await embeddingService.embed(embeddingText);

    const point: VectorPoint = {
      id,
      vector: embedding,
      payload: {
        ...memory,
        memoryLayer: 'semantic',
      },
    };

    const collection = this.semanticCollection(opts.projectName);
    await vectorStore.upsert(collection, [point]);

    logger.debug('Stored semantic memory', {
      id,
      subtype: opts.subtype,
      project: opts.projectName,
    });
    return memory;
  }

  /**
   * Recall from both episodic and semantic LTM with Ebbinghaus decay.
   * Returns union of results sorted by retention-weighted score.
   */
  async recall(opts: LtmRecallOptions): Promise<LtmSearchResult[]> {
    const {
      projectName,
      query,
      limit = 10,
      collections = ['episodic', 'semantic'],
      subtype,
      minRetention = 0.1,
    } = opts;

    const embedding = await embeddingService.embed(query);
    const results: LtmSearchResult[] = [];

    // Build filters for semantic subtype
    const semanticFilter = subtype
      ? { must: [{ key: 'subtype', match: { value: subtype } }] }
      : undefined;

    // Search both collections in parallel
    const searches = collections.map(async (col) => {
      const collection =
        col === 'episodic'
          ? this.episodicCollection(projectName)
          : this.semanticCollection(projectName);

      const filter = col === 'semantic' ? semanticFilter : undefined;

      try {
        // Over-fetch to compensate for retention filtering
        const searchResults = await vectorStore.search(collection, embedding, limit * 3, filter);

        for (const r of searchResults) {
          const payload = r.payload;
          const createdAt = (payload.timestamp ?? payload.createdAt) as string;
          const stability =
            (payload.stability as number) ??
            getBaseStability(col === 'episodic' ? 'episodic' : 'insight');
          const accessCount = (payload.accessCount as number) ?? 0;

          // Skip superseded
          if (payload.supersededBy) continue;

          const retention = computeRetention(createdAt, stability, accessCount);
          if (retention < minRetention) continue;

          // Weight search score by retention
          const weightedScore = r.score * retention;

          results.push({
            memory: this.pointToMemory(payload, col),
            score: weightedScore,
            retention,
            collection: col,
          });
        }
      } catch (error: any) {
        // Collection might not exist yet — that's ok
        if (error.status !== 404) {
          logger.debug(`LTM recall failed for ${col}`, { error: error.message });
        }
      }
    });

    await Promise.all(searches);

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Strengthen a memory on recall (spaced repetition).
   * Increments accessCount, updates lastAccessed, increases stability.
   */
  async strengthenOnRecall(
    projectName: string,
    memoryId: string,
    collectionType: 'episodic' | 'semantic'
  ): Promise<void> {
    const collection =
      collectionType === 'episodic'
        ? this.episodicCollection(projectName)
        : this.semanticCollection(projectName);

    try {
      // Read current state
      const points = await vectorStore.scrollCollection(collection, 1, undefined, false);
      // We need to find by ID — use Qdrant retrieve
      const client = (vectorStore as any).client;
      const retrieved = await client.retrieve(collection, {
        ids: [memoryId],
        with_payload: true,
      });

      if (!retrieved || retrieved.length === 0) return;

      const payload = retrieved[0].payload;
      const currentAccess = (payload.accessCount as number) ?? 0;
      const currentStability = (payload.stability as number) ?? 7;

      await client.setPayload(collection, {
        points: [memoryId],
        payload: {
          accessCount: currentAccess + 1,
          lastAccessed: new Date().toISOString(),
          stability: currentStability * config.RECALL_STRENGTHENING_FACTOR,
        },
      });
    } catch (error: any) {
      logger.debug('Failed to strengthen memory on recall', { memoryId, error: error.message });
    }
  }

  /**
   * List memories from a specific LTM collection.
   */
  async list(
    projectName: string,
    collectionType: 'episodic' | 'semantic',
    opts?: { limit?: number; subtype?: SemanticSubtype }
  ): Promise<Array<EpisodicMemory | SemanticMemory>> {
    const collection =
      collectionType === 'episodic'
        ? this.episodicCollection(projectName)
        : this.semanticCollection(projectName);

    try {
      const limit = opts?.limit ?? 20;
      const result = await vectorStore.scrollCollection(collection, limit);

      return result.points
        .map((p) => this.pointToMemory(p.payload as Record<string, unknown>, collectionType))
        .filter(Boolean);
    } catch (error: any) {
      if (error.status === 404) return [];
      logger.debug(`LTM list failed for ${collectionType}`, { error: error.message });
      return [];
    }
  }

  /**
   * Get stats for LTM collections.
   */
  async getStats(projectName: string): Promise<{
    episodic: { count: number };
    semantic: { count: number; bySubtype: Record<string, number> };
  }> {
    let episodicCount = 0;
    let semanticCount = 0;
    const bySubtype: Record<string, number> = {};

    try {
      episodicCount = await vectorStore.count(this.episodicCollection(projectName));
    } catch {
      /* collection may not exist */
    }

    try {
      semanticCount = await vectorStore.count(this.semanticCollection(projectName));
    } catch {
      /* collection may not exist */
    }

    return {
      episodic: { count: episodicCount },
      semantic: { count: semanticCount, bySubtype },
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private pointToMemory(
    payload: Record<string, unknown>,
    collection: 'episodic' | 'semantic'
  ): EpisodicMemory | SemanticMemory {
    if (collection === 'episodic') {
      return {
        id: payload.id as string,
        content: payload.content as string,
        sessionId: payload.sessionId as string,
        timestamp: (payload.timestamp ?? payload.createdAt) as string,
        files: (payload.files as string[]) ?? [],
        actions: (payload.actions as string[]) ?? [],
        outcome: payload.outcome as string | undefined,
        tags: (payload.tags as string[]) ?? [],
        stability: (payload.stability as number) ?? config.EPISODIC_BASE_STABILITY_DAYS,
        accessCount: (payload.accessCount as number) ?? 0,
        lastAccessed: (payload.lastAccessed ?? payload.createdAt) as string,
        relationships: payload.relationships as MemoryRelation[] | undefined,
        anchors: payload.anchors as Anchor[] | undefined,
        metadata: payload.metadata as Record<string, unknown> | undefined,
      };
    }

    return {
      id: payload.id as string,
      content: payload.content as string,
      subtype: (payload.subtype as SemanticSubtype) ?? 'insight',
      confidence: (payload.confidence as number) ?? 0.7,
      tags: (payload.tags as string[]) ?? [],
      stability: (payload.stability as number) ?? config.SEMANTIC_BASE_STABILITY_DAYS,
      accessCount: (payload.accessCount as number) ?? 0,
      lastAccessed: (payload.lastAccessed ?? payload.createdAt) as string,
      relationships: payload.relationships as MemoryRelation[] | undefined,
      anchors: payload.anchors as Anchor[] | undefined,
      createdAt: (payload.createdAt as string) ?? new Date().toISOString(),
      updatedAt: (payload.updatedAt as string) ?? new Date().toISOString(),
      source: payload.source as string | undefined,
      validated: payload.validated as boolean | undefined,
      supersededBy: payload.supersededBy as string | undefined,
      metadata: payload.metadata as Record<string, unknown> | undefined,
    };
  }
}

export const memoryLtm = new LongTermMemoryService();
