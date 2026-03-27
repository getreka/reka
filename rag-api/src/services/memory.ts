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
import { reconsolidation } from './reconsolidation';
import { spreadingActivation, type ActivatedMemory } from './spreading-activation';
import { logger } from '../utils/logger';
import config from '../config';

export type MemoryType = 'decision' | 'insight' | 'context' | 'todo' | 'conversation' | 'note' | 'procedure';
export type MemorySource = 'manual' | 'auto_conversation' | 'auto_pattern' | 'auto_feedback';
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export type MemoryRelationType =
  | 'supersedes' | 'relates_to' | 'contradicts' | 'extends'
  | 'caused_by' | 'follow_up' | 'refines' | 'alternative_to';

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
}

export interface SearchMemoryOptions {
  projectName: string;
  query: string;
  type?: MemoryType | 'all';
  limit?: number;
  tag?: string;
  graphRecall?: boolean;  // Phase 4: enable spreading activation after vector search
  ragFusion?: boolean;    // RAG-Fusion: multi-query + RRF merge
  recencyBoost?: number;  // 0-1: weight for recency scoring (0=disabled)
}

export interface ListMemoryOptions {
  projectName: string;
  type?: MemoryType | 'all';
  tag?: string;
  limit?: number;
}

class MemoryService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_agent_memory`;
  }

  /**
   * Store a new memory
   */
  async remember(options: CreateMemoryOptions): Promise<Memory> {
    const { projectName, content, type = 'note', tags = [], relatedTo, metadata } = options;
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

    // Auto-detect relationships with existing memories
    try {
      const relationships = await this.detectRelationships(projectName, content, type, embedding);
      if (relationships.length > 0) {
        memory.relationships = relationships;
        // Mark superseded memories
        for (const rel of relationships.filter(r => r.type === 'supersedes')) {
          await this.markSuperseded(collectionName, rel.targetId, memory.id);
        }
      }
    } catch (err: any) {
      logger.debug('Relationship detection failed', { error: err.message });
    }

    const point: VectorPoint = {
      id: memory.id,
      vector: embedding,
      payload: {
        ...memory,
        project: projectName,
      },
    };

    await vectorStore.upsert(collectionName, [point]);

    logger.info(`Memory stored: ${type}`, { id: memory.id, project: projectName, relationships: memory.relationships?.length || 0 });
    return memory;
  }

  /**
   * Recall memories by semantic search
   */
  async recall(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    const { projectName, query, type = 'all', limit = 5, tag, graphRecall, ragFusion, recencyBoost = 0 } = options;
    const collectionName = this.getCollectionName(projectName);

    // Build Qdrant filter
    const mustConditions: Record<string, unknown>[] = [];
    if (type && type !== 'all') {
      mustConditions.push({ key: 'type', match: { value: type } });
    }
    if (tag) {
      mustConditions.push({ key: 'tags', match: { any: [tag] } });
    }
    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

    let results;

    // RAG-Fusion path: multi-query + RRF merge
    if (ragFusion && config.RAG_FUSION_ENABLED) {
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
      // Standard path: single query
      const embedding = config.EMBEDDING_INSTRUCTION_ENABLED
        ? await embeddingService.embedQuery(query, 'memory_recall')
        : await embeddingService.embed(query);
      results = await vectorStore.search(collectionName, embedding, limit * 3, filter);
    }

    // Cross-encoder reranking (before aging/superseded filter to rank all candidates)
    const { reranker } = await import('./reranker');
    results = await reranker.rerank(query, results, limit * 2);

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    let mappedResults = results
      .filter(r => !r.payload.supersededBy) // Exclude superseded memories
      .map(r => {
        let score = r.score;

        // Memory aging: penalize memories older than 30 days without validation
        const createdAt = r.payload.createdAt as string;
        if (createdAt) {
          const ageMs = now - new Date(createdAt).getTime();
          if (ageMs > THIRTY_DAYS) {
            const validated = r.payload.validated as boolean | undefined;
            const promoted = !!(r.payload.metadata as Record<string, unknown> | undefined)?.promotedAt;
            // Validated/promoted memories keep their score; others decay
            if (!validated && !promoted) {
              // Decay: configurable rate per 30 days past the first 30
              const periodsOld = Math.floor(ageMs / THIRTY_DAYS) - 1;
              const decay = Math.min(config.MEMORY_DECAY_MAX, periodsOld * config.MEMORY_DECAY_RATE);
              score *= (1 - decay);
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

    // Fire-and-forget reconsolidation: strengthen recalled memories + track co-recalls
    if (config.RECONSOLIDATION_ENABLED && mappedResults.length > 0) {
      reconsolidation.onRecall(
        projectName,
        mappedResults.map(r => ({
          id: r.memory.id,
          content: r.memory.content,
          type: r.memory.type,
          tags: r.memory.tags,
          collection: 'durable' as const,
        })),
        query
      ).catch(() => {});
    }

    // Phase 4: Spreading activation — enrich results with graph-connected memories
    if (config.GRAPH_RECALL_ENABLED && graphRecall && mappedResults.length > 0) {
      try {
        const seeds = mappedResults.map(r => ({ id: r.memory.id, activation: r.score }));
        const activated = await spreadingActivation.activate(projectName, seeds);

        // Merge: add graph-discovered memories that weren't in vector search results
        const existingIds = new Set(mappedResults.map(r => r.memory.id));
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
            },
            score: act.activation,
          });
        }

        // Re-sort and re-limit
        mappedResults.sort((a, b) => b.score - a.score);
        mappedResults = mappedResults.slice(0, limit);
      } catch (err: any) {
        logger.debug('Spreading activation failed, returning vector-only results', { error: err.message });
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

    const results = await vectorStore.search(
      collectionName,
      embedding,
      limit,
      filter
    );

    return results.map(r => ({
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
    }));
  }

  /**
   * Delete a specific memory
   */
  async forget(projectName: string, memoryId: string): Promise<boolean> {
    const collectionName = this.getCollectionName(projectName);

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
  async forgetOlderThan(projectName: string, olderThanDays: number, tier: 'durable' | 'quarantine' = 'durable'): Promise<number> {
    const collectionName = tier === 'quarantine'
      ? `${projectName}_memory_pending`
      : this.getCollectionName(projectName);
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

      logger.info(`Deleted ${deleted} memories older than ${olderThanDays} days`, { project: projectName });
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

    const todo = results.find(r => r.memory.id === todoId);
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
      const { content, type = 'note', tags = [], relatedTo, metadata } = item;

      const memory: Memory = {
        id: uuidv4(),
        type,
        content,
        tags,
        relatedTo,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata,
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
  async validateMemory(projectName: string, memoryId: string, validated: boolean): Promise<Memory | null> {
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
    const {
      projectName,
      type = 'all',
      threshold = 0.9,
      dryRun = true,
      limit = 50,
    } = options;

    const collectionName = this.getCollectionName(projectName);
    const result: { merged: Array<{ original: Memory[]; merged: Memory }>; totalFound: number; totalMerged: number } = {
      merged: [],
      totalFound: 0,
      totalMerged: 0,
    };

    try {
      // Scroll through memories to find candidates
      const mustConditions: Record<string, unknown>[] = [];
      if (type && type !== 'all') {
        mustConditions.push({ key: 'type', match: { value: type } });
      }
      const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

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
          memories.push({ id: point.id as string, payload: point.payload as Record<string, unknown> });
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
          const similar = await vectorStore.recommend(
            collectionName,
            [mem.id],
            [],
            10
          );

          const cluster: Memory[] = [this.pointToMemory(mem)];
          processed.add(mem.id);

          for (const s of similar) {
            if (s.score >= threshold && !processed.has(s.id)) {
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
          batch.map(cluster =>
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
          const mergedContent = mergeResult.status === 'fulfilled'
            ? mergeResult.value
            : [...new Set(cluster.map(m => m.content.trim()))].join(' | ');

          const mergedMemory: Memory = {
            id: uuidv4(),
            type: cluster[0].type,
            content: mergedContent,
            tags: [...new Set(cluster.flatMap(m => m.tags))],
            relatedTo: cluster.find(m => m.relatedTo)?.relatedTo,
            createdAt: cluster.reduce((earliest, m) =>
              m.createdAt < earliest ? m.createdAt : earliest, cluster[0].createdAt),
            updatedAt: new Date().toISOString(),
            metadata: {
              mergedFrom: cluster.map(m => m.id),
              mergedAt: new Date().toISOString(),
              originalCount: cluster.length,
            },
          };

          result.merged.push({ original: cluster, merged: mergedMemory });

          if (!dryRun) {
            const embedding = await embeddingService.embed(
              `${mergedMemory.type}: ${mergedMemory.content}${mergedMemory.relatedTo ? ` (related to: ${mergedMemory.relatedTo})` : ''}`
            );

            await vectorStore.upsert(collectionName, [{
              id: mergedMemory.id,
              vector: embedding,
              payload: { ...mergedMemory, project: projectName },
            }]);

            const idsToDelete = cluster.map(m => m.id);
            await vectorStore.delete(collectionName, idsToDelete);
          }

          result.totalMerged++;
        }
      }

      logger.info(`Memory merge: ${result.totalMerged} clusters${dryRun ? ' (dry run)' : ' merged'}`, { projectName });
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
          systemPrompt: 'You are a memory consolidation assistant. Merge related memories into one concise entry. Preserve all unique facts, decisions, and insights. Remove redundancy. Output only the merged text, nothing else.',
          maxTokens: 500,
          temperature: 0.3,
          think: false,
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
    };
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
          similar.map(r => ({
            id: r.id,
            content: (r.payload.content as string) ?? '',
            type: (r.payload.type as string) ?? 'note',
          }))
        );

        if (classified.length > 0) {
          return classified.slice(0, 5).map(c => ({
            targetId: c.targetId,
            type: c.type as MemoryRelationType,
            reason: c.reason,
          }));
        }
      } catch (err: any) {
        logger.debug('LLM relationship classification failed, falling back to threshold-based', { error: err.message });
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
        (contentLower.includes('not ') || contentLower.includes('instead') || contentLower.includes('wrong')) &&
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
  private async markSuperseded(collectionName: string, targetId: string, newId: string): Promise<void> {
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
          must: [
            { key: 'validated', match: { value: false } },
          ],
        }
      );

      return results
        .filter(r => r.payload.source && (r.payload.source as string).startsWith('auto_'))
        .slice(0, limit)
        .map(r => ({
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
