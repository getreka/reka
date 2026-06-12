/**
 * Agent Memory Service - Persistent memory storage for AI agents
 *
 * Stores and retrieves memories using Qdrant vector database for semantic search.
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { llm } from './llm';
import { relationshipClassifier } from './relationship-classifier';
// reconsolidation moved to memory-effects worker
import { spreadingActivation } from './spreading-activation';
import { memoryVersions, type VersionActor } from './memory-versions';
import { logger } from '../utils/logger';
import config from '../config';
import { publishEvent } from '../events/emitter';

export type MemoryType =
  | 'decision'
  | 'insight'
  | 'context'
  | 'todo'
  | 'conversation'
  | 'note'
  | 'procedure';
// 'auto_memory_tool' = writes from the MCP `memory` tool (memory_20250818 adapter).
// Like every auto_* source they are quarantined by governance: visible to the
// tool's own path-based `view` (read-your-writes) but NOT to `recall` until
// promoted — that IS the governance gate.
// 'auto_transcript' = candidates mined from Claude Code session transcripts
// (POST /api/capture/transcript → transcript-miner). Quarantined like every
// auto_* source; per-source governance counters feed the 30-day validate-or-kill
// gate in /api/analytics/memory-roi.
export type MemorySource =
  | 'manual'
  | 'auto_conversation'
  | 'auto_pattern'
  | 'auto_feedback'
  | 'auto_memory_tool'
  | 'auto_transcript';
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
/** Pin scope — controls which surfaces a memory is always loaded in. */
export type PinScope = 'repo' | 'all' | 'unpinned';
export type FactCategory =
  | 'personal_info'
  | 'preference'
  | 'event'
  | 'temporal'
  | 'update'
  | 'plan';

export type MemoryRelationType =
  | 'supersedes'
  | 'relates_to'
  | 'contradicts'
  | 'extends'
  | 'caused_by'
  | 'follow_up'
  | 'refines'
  | 'alternative_to';

export interface MemoryRelation {
  targetId: string;
  type: MemoryRelationType;
  reason?: string;
}

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  relatedTo?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  // For todos
  status?: TodoStatus;
  statusHistory?: { status: TodoStatus; timestamp: string; note?: string }[];
  // Auto-learning fields
  source?: MemorySource;
  confidence?: number; // 0-1 confidence score for auto-extracted memories
  validated?: boolean; // User validation status
  originalContext?: string; // Source conversation/context
  // Relationships
  relationships?: MemoryRelation[];
  supersededBy?: string; // ID of memory that supersedes this one
  // Structured fact fields (typed-category extraction)
  factCategory?: FactCategory;
  factEntities?: string[];
  factDateTs?: number; // Unix timestamp (seconds) for date-range filtering
  // Trigger descriptions: "when to recall" cue, embedded separately so the QUERY
  // can match the trigger in addition to the content.
  triggerDescription?: string;
  triggerEmbedding?: number[]; // embedding of triggerDescription (for blended ranking)
  pin?: PinScope;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}

export interface CreateMemoryOptions {
  projectName: string;
  content: string;
  type?: MemoryType;
  tags?: string[];
  relatedTo?: string;
  metadata?: Record<string, unknown>;
  // Structured fact fields
  factCategory?: FactCategory;
  factEntities?: string[];
  factDateTs?: number; // Unix timestamp (seconds)
  // Trigger descriptions
  triggerDescription?: string;
  pin?: PinScope;
}

export interface TemporalConstraint {
  op: 'first' | 'last' | 'before' | 'after' | 'between' | 'current' | 'none';
  date?: string;
  dateEnd?: string;
  orderBy?: 'asc' | 'desc';
}

export interface SearchMemoryOptions {
  projectName: string;
  query: string;
  type?: MemoryType | 'all';
  limit?: number;
  tag?: string;
  graphRecall?: boolean; // Phase 4: enable spreading activation after vector search
  ragFusion?: boolean; // RAG-Fusion: multi-query + RRF merge
  recencyBoost?: number; // 0-1: weight for recency scoring (0=disabled)
  multiStrategy?: boolean; // TEMPR: semantic + keyword + temporal strategies fused with RRF
}

export interface ListMemoryOptions {
  projectName: string;
  type?: MemoryType | 'all';
  tag?: string;
  limit?: number;
}

// ============================================
// Multi-Strategy Recall Helpers
// ============================================

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'was',
  'are',
  'were',
  'do',
  'did',
  'does',
  'what',
  'where',
  'when',
  'how',
  'who',
  'which',
  'my',
  'i',
  'me',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'that',
  'this',
  'it',
  'and',
  'or',
  'but',
  'not',
  'have',
  'has',
  'had',
  'be',
  'been',
  'about',
  'any',
  'all',
  'so',
  'if',
  'then',
  'than',
  'into',
  'up',
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Cosine similarity between two equal-length vectors (used for trigger blending). */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function extractTemporalConstraint(query: string): TemporalConstraint {
  const q = query.toLowerCase();

  // "first X" — order ascending to get earliest
  if (/\bfirst\b/.test(q)) {
    return { op: 'first', orderBy: 'asc' };
  }

  // "last X" / "most recent X" / "latest X"
  if (/\blast\b|\bmost recent\b|\blatest\b/.test(q)) {
    return { op: 'last', orderBy: 'desc' };
  }

  // "current X" / "now" / "currently"
  if (/\bcurrent\b|\bnow\b|\bcurrently\b/.test(q)) {
    return { op: 'current', orderBy: 'desc' };
  }

  // "in YYYY" — full year range
  const yearOnlyMatch = q.match(/\bin (\d{4})\b/);
  if (yearOnlyMatch) {
    const year = yearOnlyMatch[1];
    return {
      op: 'between',
      date: `${year}-01-01T00:00:00.000Z`,
      dateEnd: `${year}-12-31T23:59:59.999Z`,
    };
  }

  // Month name patterns: "in January 2024", "January 2024"
  const monthNames: Record<string, string> = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
  };
  const monthNameRe =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/;
  const monthNameMatch = q.match(monthNameRe);
  if (monthNameMatch) {
    const month = monthNames[monthNameMatch[1]];
    const year = monthNameMatch[2];
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    return {
      op: 'between',
      date: `${year}-${month}-01T00:00:00.000Z`,
      dateEnd: `${year}-${month}-${String(lastDay).padStart(2, '0')}T23:59:59.999Z`,
    };
  }

  // "before YYYY-MM" or "before Month YYYY"
  const beforeMonthMatch = q.match(/\bbefore\s+(\d{4}-\d{2})\b/);
  if (beforeMonthMatch) {
    return { op: 'before', date: `${beforeMonthMatch[1]}-01T00:00:00.000Z` };
  }
  const beforeMonthNameMatch = q.match(
    /\bbefore\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/
  );
  if (beforeMonthNameMatch) {
    const month = monthNames[beforeMonthNameMatch[1]];
    return { op: 'before', date: `${beforeMonthNameMatch[2]}-${month}-01T00:00:00.000Z` };
  }

  // "after YYYY-MM" or "after Month YYYY"
  const afterMonthMatch = q.match(/\bafter\s+(\d{4}-\d{2})\b/);
  if (afterMonthMatch) {
    return { op: 'after', date: `${afterMonthMatch[1]}-01T00:00:00.000Z` };
  }
  const afterMonthNameMatch = q.match(
    /\bafter\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/
  );
  if (afterMonthNameMatch) {
    const month = monthNames[afterMonthNameMatch[1]];
    return { op: 'after', date: `${afterMonthNameMatch[2]}-${month}-01T00:00:00.000Z` };
  }

  // Bare YYYY-MM-DD date in query
  const isoDateMatch = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDateMatch) {
    const d = isoDateMatch[1];
    return {
      op: 'between',
      date: `${d}T00:00:00.000Z`,
      dateEnd: `${d}T23:59:59.999Z`,
    };
  }

  return { op: 'none' };
}

class MemoryService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_agent_memory`;
  }

  /**
   * Store a new memory
   */
  async remember(options: CreateMemoryOptions): Promise<Memory> {
    const {
      projectName,
      content,
      type = 'note',
      tags = [],
      relatedTo,
      metadata,
      factCategory,
      factEntities,
      factDateTs,
      triggerDescription,
      pin,
    } = options;
    const collectionName = this.getCollectionName(projectName);

    const memory: Memory = {
      id: uuidv4(),
      type,
      content,
      tags,
      relatedTo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
      factCategory,
      factEntities,
      factDateTs,
      triggerDescription,
      pin,
    };

    // Add todo-specific fields
    if (type === 'todo') {
      memory.status = 'pending';
      memory.statusHistory = [{ status: 'pending', timestamp: memory.createdAt }];
    }

    // Create embedding for semantic search
    const embedding = await embeddingService.embed(
      `${type}: ${content}${relatedTo ? ` (related to: ${relatedTo})` : ''}${tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''}`
    );

    // Trigger descriptions: embed the "when to recall" cue separately so recall can
    // blend a similarity over the trigger into the ranking. Best-effort — a failed
    // trigger embed must not break the remember.
    if (triggerDescription) {
      try {
        memory.triggerEmbedding = await embeddingService.embed(triggerDescription);
      } catch (err: any) {
        logger.debug('Trigger embedding failed; storing trigger without vector', {
          error: err?.message,
        });
      }
    }

    // Emit event for async relationship detection (handled by memory-effects worker)
    publishEvent('memory:created', {
      projectName,
      memoryId: memory.id,
      type,
      content,
      tags,
      embedding,
    }).catch(() => {});

    const point: VectorPoint = {
      id: memory.id,
      vector: embedding,
      payload: {
        ...memory,
        project: projectName,
      },
    };

    await vectorStore.upsert(collectionName, [point]);

    // Append-only version audit (fire-and-forget — never break a remember).
    // Snapshot the freshly-built memory so a rollback can reconstruct ALL fields
    // (relatedTo, trigger*, pin, factCategory, …), not just content.
    memoryVersions
      .record(projectName, {
        op: 'created',
        memoryId: memory.id,
        actor: (metadata?.versionActor as VersionActor) ?? 'api',
        content,
        type,
        tags,
        metadata,
        snapshot: { ...memory, project: projectName },
      })
      .catch(() => {});

    logger.info(`Memory stored: ${type}`, {
      id: memory.id,
      project: projectName,
      relationships: memory.relationships?.length || 0,
    });
    return memory;
  }

  /**
   * Recall memories using multi-strategy retrieval with RRF fusion (TEMPR pipeline).
   *
   * When multiStrategy is true (default), runs up to 3 strategies in parallel:
   *   1. Semantic vector search (always)
   *   2. Keyword/text-match search (always)
   *   3. Temporal filtered search (when query contains a date/temporal signal)
   * Results from all strategies are merged via Reciprocal Rank Fusion before reranking.
   */
  async recall(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    const {
      projectName,
      query,
      type = 'all',
      limit = 5,
      tag,
      graphRecall,
      ragFusion,
      recencyBoost = 0,
      multiStrategy = true,
    } = options;
    const collectionName = this.getCollectionName(projectName);

    // Build Qdrant filter for type/tag constraints
    const mustConditions: Record<string, unknown>[] = [];
    if (type && type !== 'all') {
      mustConditions.push({ key: 'type', match: { value: type } });
    }
    if (tag) {
      mustConditions.push({ key: 'tags', match: { any: [tag] } });
    }
    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

    let results: import('./vector-store').SearchResult[];

    if (multiStrategy) {
      const { retrievalFusion } = await import('./retrieval-fusion');
      const temporal = extractTemporalConstraint(query);
      const keywords = extractKeywords(query);

      // Strategy 1: Semantic (embed + vector search, or RAG-Fusion if enabled)
      const semanticPromise: Promise<import('./vector-store').SearchResult[]> =
        ragFusion && config.RAG_FUSION_ENABLED
          ? retrievalFusion.fusedRecall(
              query,
              async (q: string) => {
                const emb = config.EMBEDDING_INSTRUCTION_ENABLED
                  ? await embeddingService.embedQuery(q, 'memory_recall')
                  : await embeddingService.embed(q);
                return vectorStore.search(collectionName, emb, limit * 2, filter);
              },
              limit * 3
            )
          : (async () => {
              const emb = config.EMBEDDING_INSTRUCTION_ENABLED
                ? await embeddingService.embedQuery(query, 'memory_recall')
                : await embeddingService.embed(query);
              return vectorStore.search(collectionName, emb, limit * 2, filter);
            })();

      // Strategy 2: Keyword text-match search
      const keywordPromise: Promise<import('./vector-store').SearchResult[]> =
        keywords.length > 0
          ? vectorStore.searchByKeywords(collectionName, keywords, limit * 2, filter)
          : Promise.resolve([]);

      // Strategy 3: Temporal filtered semantic search (only when a temporal signal is detected)
      const temporalPromise: Promise<import('./vector-store').SearchResult[]> =
        temporal.op !== 'none'
          ? (async () => {
              const emb = config.EMBEDDING_INSTRUCTION_ENABLED
                ? await embeddingService.embedQuery(query, 'memory_recall')
                : await embeddingService.embed(query);

              const temporalConditions: Record<string, unknown>[] = [...mustConditions];

              if (temporal.op === 'before' && temporal.date) {
                temporalConditions.push({ key: 'createdAt', range: { lt: temporal.date } });
              } else if (temporal.op === 'after' && temporal.date) {
                temporalConditions.push({ key: 'createdAt', range: { gt: temporal.date } });
              } else if (temporal.op === 'between' && temporal.date && temporal.dateEnd) {
                temporalConditions.push({
                  key: 'createdAt',
                  range: { gte: temporal.date, lte: temporal.dateEnd },
                });
              }

              const temporalFilter =
                temporalConditions.length > 0 ? { must: temporalConditions } : undefined;

              const candidates = await vectorStore.search(
                collectionName,
                emb,
                limit * 3,
                temporalFilter
              );

              if (temporal.orderBy) {
                candidates.sort((a, b) => {
                  const ta = new Date((a.payload.createdAt as string) || 0).getTime();
                  const tb = new Date((b.payload.createdAt as string) || 0).getTime();
                  return temporal.orderBy === 'asc' ? ta - tb : tb - ta;
                });
              }

              return candidates.slice(0, limit * 2);
            })()
          : Promise.resolve([]);

      const [semanticResults, keywordResults, temporalResults] = await Promise.all([
        semanticPromise.catch((): import('./vector-store').SearchResult[] => []),
        keywordPromise.catch((): import('./vector-store').SearchResult[] => []),
        temporalPromise.catch((): import('./vector-store').SearchResult[] => []),
      ]);

      const strategyLists = [semanticResults, keywordResults, temporalResults].filter(
        (l) => l.length > 0
      );

      results =
        strategyLists.length > 1
          ? retrievalFusion.reciprocalRankFusion(strategyLists, 60)
          : (strategyLists[0] ?? []);

      logger.debug('Multi-strategy recall', {
        project: projectName,
        semantic: semanticResults.length,
        keyword: keywordResults.length,
        temporal: temporalResults.length,
        fused: results.length,
        temporalOp: temporal.op,
      });
    } else if (ragFusion && config.RAG_FUSION_ENABLED) {
      const { retrievalFusion } = await import('./retrieval-fusion');
      results = await retrievalFusion.fusedRecall(
        query,
        async (q: string) => {
          const emb = config.EMBEDDING_INSTRUCTION_ENABLED
            ? await embeddingService.embedQuery(q, 'memory_recall')
            : await embeddingService.embed(q);
          return vectorStore.search(collectionName, emb, limit * 2, filter);
        },
        limit * 3
      );
    } else {
      const embedding = config.EMBEDDING_INSTRUCTION_ENABLED
        ? await embeddingService.embedQuery(query, 'memory_recall')
        : await embeddingService.embed(query);
      results = await vectorStore.search(collectionName, embedding, limit * 3, filter);
    }

    // Cross-encoder reranking (before aging/superseded filter to rank all candidates)
    const { reranker } = await import('./reranker');
    results = await reranker.rerank(query, results, limit * 2);

    // Trigger descriptions: blend a similarity over each result's triggerEmbedding
    // (the "when to recall" cue) into its score. This lets a query match the trigger
    // even when it doesn't match the content text directly. Backward-compatible:
    // results without a triggerEmbedding are untouched.
    if (results.some((r) => Array.isArray(r.payload.triggerEmbedding))) {
      try {
        // Trigger embeddings are stored document/passage-side (embeddingService.embed
        // of the raw triggerDescription — see remember()). Compare against a
        // document-side embedding of the query so both vectors live in the SAME space.
        // Using the instruction-prefixed embedQuery here would compare across mismatched
        // spaces for instruction-tuned models and corrupt the similarity.
        const triggerQueryEmbedding = await embeddingService.embed(query);
        // ADDITIVE boost: a trigger match only ever LIFTS a memory's score; it never
        // multiplies the base score down (which would demote a triggered memory below
        // weaker untriggered ones that keep their full score). trigSim is in roughly
        // [0, 1], so untriggered items (no boost) stay directly comparable.
        const TRIGGER_WEIGHT = 0.3;
        for (const r of results) {
          const trigEmb = r.payload.triggerEmbedding as number[] | undefined;
          if (Array.isArray(trigEmb) && trigEmb.length === triggerQueryEmbedding.length) {
            // Clamp at 0: cosine can be negative, and a non-matching (or opposing)
            // trigger must never PENALIZE a memory below its base score. Only a
            // positive trigger match lifts the score.
            const trigSim = Math.max(0, cosineSimilarity(triggerQueryEmbedding, trigEmb));
            r.score = r.score + TRIGGER_WEIGHT * trigSim;
          }
        }
        results.sort((a, b) => b.score - a.score);
      } catch (err: any) {
        logger.debug('Trigger-description blend skipped', { error: err?.message });
      }
    }

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    let mappedResults = results
      .filter((r) => !r.payload.supersededBy) // Exclude superseded memories
      .map((r) => {
        let score = r.score;

        // Memory aging: penalize memories older than 30 days without validation
        const createdAt = r.payload.createdAt as string;
        if (createdAt) {
          const ageMs = now - new Date(createdAt).getTime();
          if (ageMs > THIRTY_DAYS) {
            const validated = r.payload.validated as boolean | undefined;
            const promoted = !!(r.payload.metadata as Record<string, unknown> | undefined)
              ?.promotedAt;
            // Validated/promoted memories keep their score; others decay
            if (!validated && !promoted) {
              // Decay: configurable rate per 30 days past the first 30
              const periodsOld = Math.floor(ageMs / THIRTY_DAYS) - 1;
              const decay = Math.min(
                config.MEMORY_DECAY_MAX,
                periodsOld * config.MEMORY_DECAY_RATE
              );
              score *= 1 - decay;
            }
          }
        }

        return {
          memory: {
            id: r.id,
            type: r.payload.type as MemoryType,
            content: r.payload.content as string,
            tags: (r.payload.tags as string[]) || [],
            relatedTo: r.payload.relatedTo as string | undefined,
            createdAt: r.payload.createdAt as string,
            updatedAt: r.payload.updatedAt as string,
            metadata: r.payload.metadata as Record<string, unknown> | undefined,
            status: r.payload.status as TodoStatus | undefined,
            statusHistory: r.payload.statusHistory as Memory['statusHistory'],
            relationships: r.payload.relationships as MemoryRelation[] | undefined,
            supersededBy: r.payload.supersededBy as string | undefined,
            factCategory: r.payload.factCategory as FactCategory | undefined,
            factEntities: r.payload.factEntities as string[] | undefined,
            factDateTs: r.payload.factDateTs as number | undefined,
            triggerDescription: r.payload.triggerDescription as string | undefined,
            pin: r.payload.pin as Memory['pin'],
          },
          score,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Recency boost: blend score with freshness for "current state" queries
    if (recencyBoost > 0) {
      const now = Date.now();
      for (const result of mappedResults) {
        const createdAt = result.memory.createdAt;
        if (createdAt) {
          const ageInDays = (now - new Date(createdAt).getTime()) / 86400000;
          const freshness = Math.exp(-ageInDays / 30); // 30-day half-life
          result.score = result.score * (1 - recencyBoost) + freshness * recencyBoost;
        }
      }
      mappedResults.sort((a, b) => b.score - a.score);
    }

    mappedResults = mappedResults.slice(0, limit);

    // Async reconsolidation via event worker
    if (config.RECONSOLIDATION_ENABLED && mappedResults.length > 0) {
      publishEvent('memory:recalled', {
        projectName,
        query,
        resultCount: mappedResults.length,
        memoryIds: mappedResults.map((r) => r.memory.id),
        recalledMemories: mappedResults.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
          type: r.memory.type,
          tags: r.memory.tags,
          collection: 'durable' as const,
        })),
      }).catch(() => {});
    }

    // Phase 4: Spreading activation — enrich results with graph-connected memories
    if (config.GRAPH_RECALL_ENABLED && graphRecall && mappedResults.length > 0) {
      try {
        const seeds = mappedResults.map((r) => ({ id: r.memory.id, activation: r.score }));
        const activated = await spreadingActivation.activate(projectName, seeds);

        // Merge: add graph-discovered memories that weren't in vector search results
        const existingIds = new Set(mappedResults.map((r) => r.memory.id));
        for (const act of activated) {
          if (existingIds.has(act.id) || act.hop === 0) continue;
          mappedResults.push({
            memory: {
              id: act.id,
              type: (act.type || 'note') as MemoryType,
              content: act.content,
              tags: [],
              relatedTo: undefined,
              createdAt: '',
              updatedAt: '',
              metadata: { graphActivated: true, hop: act.hop, activatedVia: act.activatedVia },
              status: undefined,
              statusHistory: undefined,
              relationships: undefined,
              supersededBy: undefined,
              factCategory: undefined,
              factEntities: undefined,
              factDateTs: undefined,
              triggerDescription: undefined,
              pin: undefined,
            },
            score: act.activation,
          });
        }

        // Re-sort and re-limit
        mappedResults.sort((a, b) => b.score - a.score);
        mappedResults = mappedResults.slice(0, limit);
      } catch (err: any) {
        logger.debug('Spreading activation failed, returning vector-only results', {
          error: err.message,
        });
      }
    }

    // Code graph → memory cross-links: find memories referencing files mentioned in results
    if (config.GRAPH_RECALL_ENABLED && graphRecall && mappedResults.length > 0) {
      try {
        const { graphStore } = await import('./graph-store');
        const filesInResults = mappedResults
          .flatMap((r) => {
            const files = (r.memory.metadata as any)?.files || [];
            return Array.isArray(files) ? files : [];
          })
          .filter(Boolean)
          .slice(0, 10);

        if (filesInResults.length > 0) {
          const memoryIds = await graphStore.getMemoriesForFiles(projectName, filesInResults);
          const existingIds = new Set(mappedResults.map((r) => r.memory.id));
          const newIds = memoryIds.filter((id) => !existingIds.has(id));

          if (newIds.length > 0) {
            // Fetch these memories from LTM
            const { memoryLtm } = await import('./memory-ltm');
            const graphMemories = await memoryLtm.getByIds(projectName, newIds.slice(0, 5));
            for (const gm of graphMemories) {
              mappedResults.push({
                memory: {
                  id: gm.id,
                  type: 'note' as MemoryType,
                  content: gm.content,
                  tags: gm.tags || [],
                  relatedTo: undefined,
                  createdAt: gm.createdAt || '',
                  updatedAt: '',
                  metadata: { graphLinked: true, source: 'code_graph' },
                  status: undefined,
                  statusHistory: undefined,
                  relationships: undefined,
                  supersededBy: undefined,
                  factCategory: undefined,
                  factEntities: undefined,
                  factDateTs: undefined,
                  triggerDescription: undefined,
                  pin: undefined,
                },
                score: 0.5,
              });
            }

            mappedResults.sort((a, b) => b.score - a.score);
            mappedResults = mappedResults.slice(0, limit);
          }
        }
      } catch (err: any) {
        logger.debug('Graph memory cross-link failed', { error: err.message });
      }
    }

    return mappedResults;
  }

  /**
   * List memories with filters
   */
  async list(options: ListMemoryOptions): Promise<Memory[]> {
    const { projectName, type = 'all', tag, limit = 10 } = options;
    const collectionName = this.getCollectionName(projectName);

    // Use a generic query to get recent memories
    const embedding = await embeddingService.embed(
      type !== 'all' ? `${type} memories` : 'recent memories notes decisions'
    );

    // Build Qdrant filter
    const mustConditions: Record<string, unknown>[] = [];
    if (type && type !== 'all') {
      mustConditions.push({ key: 'type', match: { value: type } });
    }
    if (tag) {
      mustConditions.push({ key: 'tags', match: { any: [tag] } });
    }

    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

    const results = await vectorStore.search(collectionName, embedding, limit, filter);

    return (
      results
        // Exclude superseded memories so a prior merge's originals don't leak into
        // list_memories / review output. Mirrors recall()'s post-filter (kept as a
        // post-filter rather than a Qdrant condition so the search filter stays the
        // plain type/tag filter the rest of the code and tests expect).
        .filter((r) => !r.payload.supersededBy)
        .map((r) => ({
          id: r.id,
          type: r.payload.type as MemoryType,
          content: r.payload.content as string,
          tags: (r.payload.tags as string[]) || [],
          relatedTo: r.payload.relatedTo as string | undefined,
          createdAt: r.payload.createdAt as string,
          updatedAt: r.payload.updatedAt as string,
          metadata: r.payload.metadata as Record<string, unknown> | undefined,
          status: r.payload.status as TodoStatus | undefined,
          statusHistory: r.payload.statusHistory as Memory['statusHistory'],
        }))
    );
  }

  /**
   * Delete a specific memory
   */
  async forget(
    projectName: string,
    memoryId: string,
    actor: VersionActor = 'api'
  ): Promise<boolean> {
    const collectionName = this.getCollectionName(projectName);

    // Record an immutable 'deleted' version BEFORE removing the point so the
    // content snapshot is preserved for audit/rollback. Best-effort: capture the
    // current payload if available, but never let logging block the delete.
    try {
      const existing = await this.getById(projectName, memoryId);
      await memoryVersions.record(projectName, {
        op: 'deleted',
        memoryId,
        actor,
        content: existing?.content ?? '',
        type: existing?.type,
        tags: existing?.tags,
        metadata: existing?.metadata,
        // Snapshot the WHOLE memory before it's deleted: once the Qdrant point is
        // gone, rollback can't getById() it, so the full payload (source, confidence,
        // validated, relatedTo, trigger*, pin, factCategory, relationships, …) is
        // only recoverable from this snapshot.
        snapshot: existing ? { ...existing, project: projectName } : undefined,
      });
    } catch (err: any) {
      logger.debug('Failed to record deletion version', { memoryId, error: err?.message });
    }

    try {
      await vectorStore.delete(collectionName, [memoryId]);
      logger.info(`Memory deleted: ${memoryId}`, { project: projectName });
      return true;
    } catch (error) {
      logger.error(`Failed to delete memory: ${memoryId}`, { error });
      return false;
    }
  }

  /**
   * Fetch a single memory by exact id (used by version audit/rollback).
   * Returns null if not found or the collection does not exist.
   */
  async getById(projectName: string, memoryId: string): Promise<Memory | null> {
    const collectionName = this.getCollectionName(projectName);
    try {
      const response = await vectorStore['client'].scroll(collectionName, {
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ key: 'id', match: { value: memoryId } }] },
      });
      const point = response.points[0];
      if (!point) return null;
      return this.pointToMemory({
        id: point.id as string,
        payload: point.payload as Record<string, unknown>,
      });
    } catch (err: any) {
      if (err.status === 404 || err.status === 400) return null;
      logger.debug('getById failed', { memoryId, error: err?.message });
      return null;
    }
  }

  /**
   * Delete memories by type
   */
  async forgetByType(projectName: string, type: MemoryType): Promise<number> {
    const collectionName = this.getCollectionName(projectName);

    try {
      await vectorStore.deleteByFilter(collectionName, {
        must: [{ key: 'type', match: { value: type } }],
      });
      logger.info(`Memories of type ${type} deleted`, { project: projectName });
      return 1; // Qdrant doesn't return count
    } catch (error) {
      logger.error(`Failed to delete memories by type: ${type}`, { error });
      return 0;
    }
  }

  /**
   * Delete memories older than N days (client-side date filtering).
   * tier: 'durable' (default) or 'quarantine' to target the pending collection.
   */
  async forgetOlderThan(
    projectName: string,
    olderThanDays: number,
    tier: 'durable' | 'quarantine' = 'durable'
  ): Promise<number> {
    const collectionName =
      tier === 'quarantine' ? `${projectName}_memory_pending` : this.getCollectionName(projectName);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    let deleted = 0;

    try {
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

        // Batch delete in chunks of 100
        for (let i = 0; i < idsToDelete.length; i += 100) {
          const chunk = idsToDelete.slice(i, i + 100);
          await vectorStore.delete(collectionName, chunk);
          deleted += chunk.length;
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset);

      logger.info(`Deleted ${deleted} memories older than ${olderThanDays} days`, {
        project: projectName,
      });
      return deleted;
    } catch (error: any) {
      if (error.status === 404) return 0;
      logger.error(`Failed to delete old memories`, { error: error.message, project: projectName });
      throw error;
    }
  }

  /**
   * Update todo status
   */
  async updateTodoStatus(
    projectName: string,
    todoId: string,
    status: TodoStatus,
    note?: string
  ): Promise<Memory | null> {
    const collectionName = this.getCollectionName(projectName);

    // First, recall the todo
    const results = await this.recall({
      projectName,
      query: todoId,
      type: 'todo',
      limit: 10,
    });

    const todo = results.find((r) => r.memory.id === todoId);
    if (!todo) {
      logger.warn(`Todo not found: ${todoId}`);
      return null;
    }

    // Update the memory
    const updatedMemory: Memory = {
      ...todo.memory,
      status,
      updatedAt: new Date().toISOString(),
      statusHistory: [
        ...(todo.memory.statusHistory || []),
        { status, timestamp: new Date().toISOString(), note },
      ],
    };

    // Re-embed and update
    const embedding = await embeddingService.embed(
      `todo: ${updatedMemory.content} [status: ${status}]${updatedMemory.relatedTo ? ` (related to: ${updatedMemory.relatedTo})` : ''}`
    );

    const point: VectorPoint = {
      id: updatedMemory.id,
      vector: embedding,
      payload: {
        ...updatedMemory,
        project: projectName,
      },
    };

    await vectorStore.upsert(collectionName, [point]);

    // Append-only version audit (fire-and-forget).
    memoryVersions
      .record(projectName, {
        op: 'modified',
        memoryId: updatedMemory.id,
        actor: 'api',
        content: updatedMemory.content,
        type: updatedMemory.type,
        tags: updatedMemory.tags,
        metadata: { ...updatedMemory.metadata, status },
      })
      .catch(() => {});

    logger.info(`Todo status updated: ${todoId} -> ${status}`, { project: projectName });
    return updatedMemory;
  }

  /**
   * Get memory statistics
   */
  async getStats(projectName: string): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
  }> {
    const collectionName = this.getCollectionName(projectName);
    const info = await vectorStore.getCollectionInfo(collectionName);

    // Aggregate real counts by type from collection
    const typeCounts = await vectorStore.aggregateByField(collectionName, 'type');

    return {
      total: info.vectorsCount,
      byType: {
        decision: typeCounts['decision'] || 0,
        insight: typeCounts['insight'] || 0,
        context: typeCounts['context'] || 0,
        todo: typeCounts['todo'] || 0,
        conversation: typeCounts['conversation'] || 0,
        note: typeCounts['note'] || 0,
        procedure: typeCounts['procedure'] || 0,
      },
    };
  }

  /**
   * Batch remember - store multiple memories efficiently
   */
  async batchRemember(
    projectName: string,
    items: Array<Omit<CreateMemoryOptions, 'projectName'>>
  ): Promise<{ saved: Memory[]; errors: string[] }> {
    const collectionName = this.getCollectionName(projectName);
    const saved: Memory[] = [];
    const errors: string[] = [];

    // Create all memories and embeddings in batch
    const memories: Memory[] = [];
    const textsToEmbed: string[] = [];

    for (const item of items) {
      const {
        content,
        type = 'note',
        tags = [],
        relatedTo,
        metadata,
        factCategory,
        factEntities,
        factDateTs,
        triggerDescription,
        pin,
      } = item;

      const memory: Memory = {
        id: uuidv4(),
        type,
        content,
        tags,
        relatedTo,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata,
        factCategory,
        factEntities,
        factDateTs,
        triggerDescription,
        pin,
      };

      if (type === 'todo') {
        memory.status = 'pending';
        memory.statusHistory = [{ status: 'pending', timestamp: memory.createdAt }];
      }

      memories.push(memory);
      textsToEmbed.push(
        `${type}: ${content}${relatedTo ? ` (related to: ${relatedTo})` : ''}${tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''}`
      );
    }

    try {
      // Batch embed all texts
      const embeddings = await embeddingService.embedBatch(textsToEmbed);

      // Create points
      const points: VectorPoint[] = memories.map((memory, i) => ({
        id: memory.id,
        vector: embeddings[i],
        payload: {
          ...memory,
          project: projectName,
        },
      }));

      // Batch upsert
      await vectorStore.upsert(collectionName, points);
      saved.push(...memories);

      // Append-only version audit per saved memory (fire-and-forget).
      for (const m of memories) {
        memoryVersions
          .record(projectName, {
            op: 'created',
            memoryId: m.id,
            actor: (m.metadata?.versionActor as VersionActor) ?? 'api',
            content: m.content,
            type: m.type,
            tags: m.tags,
            metadata: m.metadata,
          })
          .catch(() => {});
      }

      logger.info(`Batch remember: ${saved.length} memories saved`, { projectName });
    } catch (error: any) {
      errors.push(`Batch operation failed: ${error.message}`);
      logger.error('Batch remember failed', { error: error.message, projectName });
    }

    return { saved, errors };
  }

  /**
   * Validate auto-extracted memory (mark as user-validated)
   */
  async validateMemory(
    projectName: string,
    memoryId: string,
    validated: boolean
  ): Promise<Memory | null> {
    const collectionName = this.getCollectionName(projectName);

    // Find the memory
    const results = await this.recall({
      projectName,
      query: memoryId,
      limit: 1,
    });

    if (results.length === 0) {
      return null;
    }

    const memory = results[0].memory;
    const updatedMemory: Memory = {
      ...memory,
      validated,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...memory.metadata,
        validatedAt: new Date().toISOString(),
      },
    };

    // Re-embed and update
    const embedding = await embeddingService.embed(
      `${updatedMemory.type}: ${updatedMemory.content}${updatedMemory.relatedTo ? ` (related to: ${updatedMemory.relatedTo})` : ''}`
    );

    const point: VectorPoint = {
      id: updatedMemory.id,
      vector: embedding,
      payload: {
        ...updatedMemory,
        project: projectName,
      },
    };

    await vectorStore.upsert(collectionName, [point]);
    logger.info(`Memory validated: ${memoryId} = ${validated}`, { projectName });

    return updatedMemory;
  }

  /**
   * Merge duplicate/similar memories into consolidated entries
   */
  async mergeMemories(options: {
    projectName: string;
    type?: MemoryType | 'all';
    threshold?: number;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    merged: Array<{ original: Memory[]; merged: Memory }>;
    totalFound: number;
    totalMerged: number;
  }> {
    const { projectName, type = 'all', threshold = 0.9, dryRun = true, limit = 50 } = options;

    const collectionName = this.getCollectionName(projectName);
    const result: {
      merged: Array<{ original: Memory[]; merged: Memory }>;
      totalFound: number;
      totalMerged: number;
    } = {
      merged: [],
      totalFound: 0,
      totalMerged: 0,
    };

    try {
      // Scroll through memories to find candidates. Require supersededBy to be empty
      // so points already superseded by a prior merge are never candidates —
      // otherwise on every run the still-present (non-deleted) originals get
      // re-clustered with their near-identical merged successor and merged AGAIN,
      // causing unbounded duplicate growth and repeated LLM merge calls until the
      // grace-period purge removes them. Qdrant `is_empty` matches points where the
      // field is missing or null (i.e. NOT superseded).
      const mustConditions: Record<string, unknown>[] = [];
      if (type && type !== 'all') {
        mustConditions.push({ key: 'type', match: { value: type } });
      }
      mustConditions.push({ is_empty: { key: 'supersededBy' } });
      const filter = { must: mustConditions };

      const memories: Array<{ id: string; payload: Record<string, unknown> }> = [];
      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 500,
          offset,
          with_payload: true,
          with_vector: false,
          filter,
        });

        for (const point of response.points) {
          memories.push({
            id: point.id as string,
            payload: point.payload as Record<string, unknown>,
          });
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && memories.length < limit * 10);

      result.totalFound = memories.length;

      if (memories.length < 2) {
        return result;
      }

      // Find clusters of similar memories using recommend
      const processed = new Set<string>();
      const clusters: Memory[][] = [];

      for (const mem of memories) {
        if (processed.has(mem.id)) continue;

        try {
          // Constrain clusters to the SAME type so we never merge a decision into
          // a note (recommend() previously passed no type filter → cross-type merges).
          // Also require supersededBy to be empty so a prior merge's originals are
          // never pulled back into a new cluster (mirrors the scroll filter above and
          // prevents the re-merge loop).
          const memType = mem.payload.type as MemoryType | undefined;
          const recommendConditions: Record<string, unknown>[] = [
            { is_empty: { key: 'supersededBy' } },
          ];
          if (memType) {
            recommendConditions.push({ key: 'type', match: { value: memType } });
          }
          const typeFilter = { must: recommendConditions };
          const similar = await vectorStore.recommend(collectionName, [mem.id], [], 10, typeFilter);

          const cluster: Memory[] = [this.pointToMemory(mem)];
          processed.add(mem.id);

          for (const s of similar) {
            if (
              s.score >= threshold &&
              !processed.has(s.id) &&
              (!memType || s.payload.type === memType) &&
              // Defensive post-filter: drop any superseded point the filter missed
              // (e.g. clients that don't honor is_empty) so it can't re-cluster.
              !s.payload.supersededBy
            ) {
              cluster.push(this.pointToMemory({ id: s.id, payload: s.payload }));
              processed.add(s.id);
            }
          }

          if (cluster.length > 1) {
            clusters.push(cluster);
          }
        } catch {
          // Skip if recommend fails for this point
          processed.add(mem.id);
        }

        if (clusters.length >= limit) break;
      }

      // Merge clusters in parallel batches to avoid timeout
      const BATCH_SIZE = 3;
      const PER_MERGE_TIMEOUT = 30000;
      const mergeStartTime = Date.now();
      const OVERALL_TIMEOUT = 90000; // Leave buffer for HTTP response

      for (let i = 0; i < clusters.length; i += BATCH_SIZE) {
        if (Date.now() - mergeStartTime > OVERALL_TIMEOUT) {
          logger.warn('Memory merge: approaching timeout, stopping early', {
            processed: result.totalMerged,
            remaining: clusters.length - i,
          });
          break;
        }

        const batch = clusters.slice(i, i + BATCH_SIZE);
        const mergeResults = await Promise.allSettled(
          batch.map((cluster) =>
            Promise.race([
              this.llmMergeMemories(cluster),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('LLM merge timeout')), PER_MERGE_TIMEOUT)
              ),
            ])
          )
        );

        for (let j = 0; j < batch.length; j++) {
          const cluster = batch[j];
          const mergeResult = mergeResults[j];

          // On timeout/error, fallback to concatenation
          const mergedContent =
            mergeResult.status === 'fulfilled'
              ? mergeResult.value
              : [...new Set(cluster.map((m) => m.content.trim()))].join(' | ');

          // Carry over governance state so a merge never demotes a validated /
          // promoted / high-confidence memory back to an unvalidated stub.
          const anyValidated = cluster.some((m) => m.validated);
          const maxConfidence = cluster.reduce<number | undefined>((max, m) => {
            if (m.confidence === undefined) return max;
            return max === undefined ? m.confidence : Math.max(max, m.confidence);
          }, undefined);
          const promotedAt = cluster
            .map((m) => (m.metadata?.promotedAt as string | undefined) ?? undefined)
            .filter(Boolean)
            .sort()
            .pop();
          // Prefer the strongest provenance: manual > promoted-auto > raw auto.
          const mergedSource =
            cluster.find((m) => m.source === 'manual')?.source ??
            cluster.find((m) => m.source)?.source;

          // Carry the strongest pin so an auto-merge never silently un-pins an
          // always-loaded memory. Pin strength: 'all' > 'repo' > unpinned.
          const PIN_RANK: Record<string, number> = { all: 2, repo: 1, unpinned: 0 };
          const mergedPin = cluster
            .map((m) => m.pin)
            .filter((p): p is PinScope => p !== undefined && p !== 'unpinned')
            .sort((a, b) => (PIN_RANK[b] ?? 0) - (PIN_RANK[a] ?? 0))[0];

          // Keep a trigger cue so the merged memory still matches its recall trigger.
          // Take it from the most-recent member that carries one (cluster is roughly
          // ordered with the seed first; pick by createdAt to be deterministic).
          const triggerDonor = cluster
            .filter((m) => m.triggerDescription)
            .sort((a, b) =>
              b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0
            )[0];
          const mergedTriggerDescription = triggerDonor?.triggerDescription;

          const mergedMemory: Memory = {
            id: uuidv4(),
            type: cluster[0].type,
            content: mergedContent,
            tags: [...new Set(cluster.flatMap((m) => m.tags))],
            relatedTo: cluster.find((m) => m.relatedTo)?.relatedTo,
            // Use the NEWEST createdAt so the merged memory does not resume
            // Ebbinghaus decay as if it were the oldest member of the cluster.
            createdAt: cluster.reduce(
              (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
              cluster[0].createdAt
            ),
            updatedAt: new Date().toISOString(),
            source: mergedSource,
            confidence: maxConfidence,
            validated: anyValidated || undefined,
            relationships: (() => {
              const all = cluster.flatMap((m) => m.relationships ?? []);
              const seen = new Set<string>();
              const deduped = all.filter((r) => {
                const k = `${r.type}:${r.targetId}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
              return deduped.length > 0 ? deduped : undefined;
            })(),
            // Preserve pin (always-loaded scope) and trigger cue from the cluster so
            // an auto-merge never strips them. triggerEmbedding is re-derived below
            // (in the non-dryRun path) so the stored vector matches the kept text.
            pin: mergedPin,
            triggerDescription: mergedTriggerDescription,
            triggerEmbedding: triggerDonor?.triggerEmbedding,
            metadata: {
              mergedFrom: cluster.map((m) => m.id),
              mergedAt: new Date().toISOString(),
              originalCount: cluster.length,
              ...(promotedAt ? { promotedAt } : {}),
              ...(anyValidated ? { validated: true } : {}),
            },
          };

          result.merged.push({ original: cluster, merged: mergedMemory });

          if (!dryRun) {
            const embedding = await embeddingService.embed(
              `${mergedMemory.type}: ${mergedMemory.content}${mergedMemory.relatedTo ? ` (related to: ${mergedMemory.relatedTo})` : ''}`
            );

            // Re-embed the carried trigger description so the stored triggerEmbedding
            // is consistent with remember() (document/passage-side embed of the cue).
            // Best-effort: a failed trigger embed must not abort the merge upsert.
            if (mergedMemory.triggerDescription) {
              try {
                mergedMemory.triggerEmbedding = await embeddingService.embed(
                  mergedMemory.triggerDescription
                );
              } catch (err: any) {
                logger.debug('Trigger re-embed during merge failed; keeping donor vector', {
                  error: err?.message,
                });
              }
            }

            await vectorStore.upsert(collectionName, [
              {
                id: mergedMemory.id,
                vector: embedding,
                payload: { ...mergedMemory, project: projectName },
              },
            ]);

            // Non-destructive: mark originals as superseded (preserves audit trail
            // + lets recall skip them) instead of deleting. Mirrors runCompaction.
            const now = new Date().toISOString();
            for (const origId of cluster.map((m) => m.id)) {
              try {
                await vectorStore['client'].setPayload(collectionName, {
                  points: [origId],
                  payload: { supersededBy: mergedMemory.id, updatedAt: now },
                });
              } catch (err: any) {
                logger.debug('Failed to mark superseded during merge', {
                  origId,
                  error: err.message,
                });
              }
            }
          }

          result.totalMerged++;
        }
      }

      logger.info(
        `Memory merge: ${result.totalMerged} clusters${dryRun ? ' (dry run)' : ' merged'}`,
        { projectName }
      );
      return result;
    } catch (error: any) {
      if (error.status === 404) {
        return result;
      }
      throw error;
    }
  }

  /**
   * Use LLM to merge multiple memory contents into one consolidated entry
   */
  private async llmMergeMemories(memories: Memory[]): Promise<string> {
    const memoryTexts = memories.map((m, i) => `[${i + 1}] ${m.content}`).join('\n');

    try {
      const result = await llm.complete(
        `Merge the following ${memories.length} related memory entries into a single, concise memory that preserves all unique information:\n\n${memoryTexts}`,
        {
          systemPrompt:
            'You are a memory consolidation assistant. Merge related memories into one concise entry. Preserve all unique facts, decisions, and insights. Remove redundancy. Output only the merged text, nothing else.',
          maxTokens: 500,
          temperature: 0.3,
          think: false,
          caller: 'memory-merge',
        }
      );
      return result.text.trim();
    } catch {
      // Fallback: concatenate with dedup
      const seen = new Set<string>();
      const parts: string[] = [];
      for (const m of memories) {
        const normalized = m.content.trim().toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          parts.push(m.content.trim());
        }
      }
      return parts.join(' | ');
    }
  }

  /**
   * Convert a raw Qdrant point to a Memory object
   */
  private pointToMemory(point: { id: string; payload: Record<string, unknown> }): Memory {
    return {
      id: point.id,
      type: point.payload.type as MemoryType,
      content: point.payload.content as string,
      tags: (point.payload.tags as string[]) || [],
      relatedTo: point.payload.relatedTo as string | undefined,
      createdAt: point.payload.createdAt as string,
      updatedAt: point.payload.updatedAt as string,
      metadata: point.payload.metadata as Record<string, unknown> | undefined,
      status: point.payload.status as TodoStatus | undefined,
      statusHistory: point.payload.statusHistory as Memory['statusHistory'],
      source: point.payload.source as MemorySource | undefined,
      confidence: point.payload.confidence as number | undefined,
      validated: point.payload.validated as boolean | undefined,
      relationships: point.payload.relationships as MemoryRelation[] | undefined,
      supersededBy: point.payload.supersededBy as string | undefined,
      factCategory: point.payload.factCategory as FactCategory | undefined,
      factEntities: point.payload.factEntities as string[] | undefined,
      factDateTs: point.payload.factDateTs as number | undefined,
      triggerDescription: point.payload.triggerDescription as string | undefined,
      triggerEmbedding: point.payload.triggerEmbedding as number[] | undefined,
      pin: point.payload.pin as Memory['pin'],
    };
  }

  /**
   * Async relationship detection — called by memory-effects worker after memory is stored.
   * Runs detectRelationships and updates the stored memory with the results.
   */
  async _asyncDetectRelationships(
    projectName: string,
    memoryId: string,
    content: string,
    type: MemoryType,
    embedding: number[]
  ): Promise<void> {
    const collectionName = this.getCollectionName(projectName);
    const relationships = await this.detectRelationships(projectName, content, type, embedding);
    if (relationships.length > 0) {
      await vectorStore['client'].setPayload(collectionName, {
        points: [memoryId],
        payload: { relationships },
      });
      for (const rel of relationships.filter((r) => r.type === 'supersedes')) {
        await this.markSuperseded(collectionName, rel.targetId, memoryId);
      }
    }
  }

  /**
   * Auto-detect relationships: find similar memories and classify the relationship.
   * Uses embedding similarity + content overlap to detect supersedes/contradicts.
   */
  private async detectRelationships(
    projectName: string,
    content: string,
    type: MemoryType,
    embedding: number[]
  ): Promise<MemoryRelation[]> {
    const collectionName = this.getCollectionName(projectName);

    // Find similar existing memories
    const similar = await vectorStore.search(collectionName, embedding, 5, undefined, 0.75);
    if (similar.length === 0) return [];

    // Phase 2: LLM-powered classification when consolidation is enabled
    if (config.CONSOLIDATION_ENABLED) {
      try {
        const classified = await relationshipClassifier.classify(
          { content, type },
          similar.map((r) => ({
            id: r.id,
            content: (r.payload.content as string) ?? '',
            type: (r.payload.type as string) ?? 'note',
          }))
        );

        if (classified.length > 0) {
          return classified.slice(0, 5).map((c) => ({
            targetId: c.targetId,
            type: c.type as MemoryRelationType,
            reason: c.reason,
          }));
        }
      } catch (err: any) {
        logger.debug('LLM relationship classification failed, falling back to threshold-based', {
          error: err.message,
        });
      }
    }

    // Fallback: threshold-based detection (original logic)
    const relations: MemoryRelation[] = [];
    const contentLower = content.toLowerCase();

    for (const r of similar) {
      const existingType = r.payload.type as string;

      if (r.score > 0.85 && existingType === type) {
        relations.push({
          targetId: r.id,
          type: 'supersedes',
          reason: `High similarity (${(r.score * 100).toFixed(0)}%) with same type`,
        });
      } else if (
        r.score > 0.8 &&
        (contentLower.includes('not ') ||
          contentLower.includes('instead') ||
          contentLower.includes('wrong')) &&
        existingType === type
      ) {
        relations.push({
          targetId: r.id,
          type: 'contradicts',
          reason: `Similar topic with contradicting language`,
        });
      } else if (r.score > 0.75) {
        relations.push({
          targetId: r.id,
          type: 'relates_to',
          reason: `Semantically related (${(r.score * 100).toFixed(0)}%)`,
        });
      }
    }

    return relations.slice(0, 5);
  }

  /**
   * Mark an existing memory as superseded by a newer one.
   */
  private async markSuperseded(
    collectionName: string,
    targetId: string,
    newId: string
  ): Promise<void> {
    try {
      await vectorStore['client'].setPayload(collectionName, {
        points: [targetId],
        payload: {
          supersededBy: newId,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      logger.debug('Failed to mark memory as superseded', { targetId, error: err.message });
    }
  }

  /**
   * Get unvalidated auto-extracted memories for review
   */
  async getUnvalidatedMemories(projectName: string, limit: number = 20): Promise<Memory[]> {
    const collectionName = this.getCollectionName(projectName);

    try {
      // Search for memories that were auto-extracted and not yet validated
      const embedding = await embeddingService.embed('auto extracted memories unvalidated');

      const results = await vectorStore.search(
        collectionName,
        embedding,
        limit * 2, // Get more to filter
        {
          must: [{ key: 'validated', match: { value: false } }],
        }
      );

      return results
        .filter((r) => r.payload.source && (r.payload.source as string).startsWith('auto_'))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          type: r.payload.type as MemoryType,
          content: r.payload.content as string,
          tags: (r.payload.tags as string[]) || [],
          relatedTo: r.payload.relatedTo as string | undefined,
          createdAt: r.payload.createdAt as string,
          updatedAt: r.payload.updatedAt as string,
          metadata: r.payload.metadata as Record<string, unknown> | undefined,
          source: r.payload.source as MemorySource,
          confidence: r.payload.confidence as number,
          validated: r.payload.validated as boolean,
        }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }
}

export const memoryService = new MemoryService();
export default memoryService;
