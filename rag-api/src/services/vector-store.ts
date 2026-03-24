/**
 * Vector Store Service - Qdrant client with multi-project support
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { logger } from '../utils/logger';

export interface VectorPoint {
  id?: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface SparseVectorData {
  indices: number[];
  values: number[];
}

export interface SparseVectorPoint {
  id?: string;
  vectors: {
    dense: number[];
    sparse: SparseVectorData;
  };
  payload: Record<string, unknown>;
}

export interface CollectionInfo {
  name: string;
  vectorsCount: number;
  status: string;
  indexedFields?: string[];
  config?: {
    vectorSize: number;
    distance: string;
  };
  segmentsCount?: number;
  optimizerStatus?: string;
}

// Payload fields to index for fast filtering
const INDEXED_FIELDS: Array<{ fieldName: string; type: 'keyword' | 'integer' | 'float' | 'bool' }> = [
  { fieldName: 'language', type: 'keyword' },
  { fieldName: 'file', type: 'keyword' },
  { fieldName: 'type', type: 'keyword' },
  { fieldName: 'spaceKey', type: 'keyword' },
  { fieldName: 'project', type: 'keyword' },
  { fieldName: 'pageId', type: 'keyword' },
  { fieldName: 'source', type: 'keyword' },
  { fieldName: 'validated', type: 'keyword' },
  { fieldName: 'symbols', type: 'keyword' },
  { fieldName: 'chunkType', type: 'keyword' },
  { fieldName: 'fromFile', type: 'keyword' },
  { fieldName: 'toFile', type: 'keyword' },
  { fieldName: 'edgeType', type: 'keyword' },
  { fieldName: 'layer', type: 'keyword' },
  { fieldName: 'service', type: 'keyword' },
  { fieldName: 'gitCommit', type: 'keyword' },
  // Phase 2: LTM fields
  { fieldName: 'sessionId', type: 'keyword' },
  { fieldName: 'subtype', type: 'keyword' },
  { fieldName: 'memoryLayer', type: 'keyword' },
  { fieldName: 'accessCount', type: 'integer' },
  { fieldName: 'stability', type: 'float' },
];

class VectorStoreService {
  private client: QdrantClient;
  private initialized: boolean = false;

  constructor() {
    this.client = new QdrantClient({
      url: config.QDRANT_URL,
      apiKey: config.QDRANT_API_KEY,
      checkCompatibility: false,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.client.getCollections();
      this.initialized = true;
      logger.info('Vector store initialized', { url: config.QDRANT_URL });
    } catch (error) {
      logger.error('Failed to connect to Qdrant', { error });
      throw error;
    }
  }

  /**
   * Check if a name is used by an alias (not a real collection)
   */
  private async isAlias(name: string): Promise<{ isAlias: boolean; collection?: string }> {
    try {
      const aliases = await this.listAliases();
      const found = aliases.find(a => a.alias === name);
      return found ? { isAlias: true, collection: found.collection } : { isAlias: false };
    } catch {
      return { isAlias: false };
    }
  }

  /**
   * Resolve an orphaned alias left by a failed zero-downtime reindex.
   * Deletes the alias and its backing temp collection, so a real collection can be created.
   */
  async resolveOrphanedAlias(name: string): Promise<boolean> {
    const { isAlias, collection } = await this.isAlias(name);
    if (!isAlias) return false;

    logger.warn(`Resolving orphaned alias: ${name} -> ${collection}`);
    await this.deleteAlias(name);
    if (collection) {
      try {
        await this.deleteCollection(collection);
      } catch {
        // temp collection may already be gone
      }
    }
    return true;
  }

  /**
   * Ensure a collection exists, create if not
   */
  async ensureCollection(name: string): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === name);

      if (!exists) {
        // An alias with this name blocks collection creation — clean it up
        await this.resolveOrphanedAlias(name);

        await this.client.createCollection(name, {
          vectors: {
            size: config.VECTOR_SIZE,
            distance: 'Cosine',
          },
          optimizers_config: {
            default_segment_number: 2,
          },
        });
        logger.info(`Created collection: ${name}`);

        // Create payload indexes for fast filtering
        await this.createPayloadIndexes(name);
      }
    } catch (error) {
      logger.error(`Failed to ensure collection: ${name}`, { error });
      throw error;
    }
  }

  /**
   * Create payload indexes on a collection for fast filtering
   */
  async createPayloadIndexes(collection: string): Promise<void> {
    for (const field of INDEXED_FIELDS) {
      try {
        await this.client.createPayloadIndex(collection, {
          field_name: field.fieldName,
          field_schema: field.type,
          wait: true,
        });
        logger.debug(`Created index on ${collection}.${field.fieldName}`);
      } catch (error: any) {
        // Index might already exist, that's ok
        if (!error.message?.includes('already exists')) {
          logger.warn(`Failed to create index on ${collection}.${field.fieldName}`, { error: error.message });
        }
      }
    }
    logger.info(`Created payload indexes on collection: ${collection}`);
  }

  /**
   * Ensure indexes exist on an existing collection (for migrations)
   */
  async ensurePayloadIndexes(collection: string): Promise<void> {
    try {
      const info = await this.client.getCollection(collection);
      if (info.status === 'green') {
        await this.createPayloadIndexes(collection);
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.error(`Failed to ensure indexes on ${collection}`, { error });
      }
    }
  }

  /**
   * Delete a collection
   */
  async deleteCollection(name: string): Promise<void> {
    try {
      await this.client.deleteCollection(name);
      logger.info(`Deleted collection: ${name}`);
    } catch (error) {
      logger.error(`Failed to delete collection: ${name}`, { error });
      throw error;
    }
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<string[]> {
    const collections = await this.client.getCollections();
    return collections.collections.map(c => c.name);
  }

  /**
   * List collections for a specific project
   */
  async listProjectCollections(projectName: string): Promise<string[]> {
    const collections = await this.listCollections();
    const prefix = `${projectName}_`;
    return collections.filter(c => c.startsWith(prefix));
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    try {
      const info = await this.client.getCollection(name);

      // Extract indexed field names from payload schema
      const indexedFields: string[] = [];
      if (info.payload_schema) {
        for (const [fieldName, schema] of Object.entries(info.payload_schema)) {
          if (schema && typeof schema === 'object' && 'data_type' in schema) {
            indexedFields.push(fieldName);
          }
        }
      }

      // Extract vector config
      let vectorSize = 0;
      let distance = 'unknown';
      if (info.config?.params?.vectors) {
        const vectors = info.config.params.vectors as any;
        if (typeof vectors === 'object' && 'size' in vectors) {
          vectorSize = vectors.size;
          distance = vectors.distance || 'Cosine';
        }
      }

      return {
        name,
        vectorsCount: info.points_count || 0,
        status: info.status,
        indexedFields,
        config: {
          vectorSize,
          distance,
        },
        segmentsCount: info.segments_count,
        optimizerStatus: typeof info.optimizer_status === 'object' ? (info.optimizer_status as any)?.status : undefined,
      };
    } catch (error: any) {
      if (error.status === 404) {
        return { name, vectorsCount: 0, status: 'not_found' };
      }
      throw error;
    }
  }

  /**
   * Upsert vectors
   */
  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    await this.ensureCollection(collection);

    const formattedPoints = points.map(p => ({
      id: p.id || uuidv4(),
      vector: p.vector,
      payload: p.payload,
    }));

    // Sub-batch to avoid Qdrant payload size limit (32MB)
    const BATCH_SIZE = 100;
    for (let i = 0; i < formattedPoints.length; i += BATCH_SIZE) {
      const batch = formattedPoints.slice(i, i + BATCH_SIZE);
      await this.client.upsert(collection, {
        wait: true,
        points: batch,
      });
    }

    logger.debug(`Upserted ${points.length} points to ${collection}`);
  }

  /**
   * Ensure a collection exists with named vectors (dense + sparse).
   */
  async ensureCollectionWithSparse(name: string): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === name);

      if (!exists) {
        // An alias with this name blocks collection creation — clean it up
        await this.resolveOrphanedAlias(name);

        await this.client.createCollection(name, {
          vectors: {
            dense: {
              size: config.VECTOR_SIZE,
              distance: 'Cosine',
            },
          },
          sparse_vectors: {
            sparse: {},
          },
          optimizers_config: {
            default_segment_number: 2,
          },
        });
        logger.info(`Created sparse collection: ${name}`);
        await this.createPayloadIndexes(name);
      }
    } catch (error) {
      logger.error(`Failed to ensure sparse collection: ${name}`, { error });
      throw error;
    }
  }

  /**
   * Upsert vectors with named dense + sparse vectors.
   */
  async upsertSparse(collection: string, points: SparseVectorPoint[]): Promise<void> {
    await this.ensureCollectionWithSparse(collection);

    const formattedPoints = points.map(p => ({
      id: p.id || uuidv4(),
      vector: {
        dense: p.vectors.dense,
        sparse: {
          indices: p.vectors.sparse.indices,
          values: p.vectors.sparse.values,
        },
      },
      payload: p.payload,
    }));

    // Sparse vectors are large — use smaller batches to stay under Qdrant's 32MB limit
    const BATCH_SIZE = 50;
    for (let i = 0; i < formattedPoints.length; i += BATCH_SIZE) {
      const batch = formattedPoints.slice(i, i + BATCH_SIZE);
      await this.client.upsert(collection, {
        wait: true,
        points: batch,
      });
    }

    logger.debug(`Upserted ${points.length} sparse points to ${collection}`);
  }

  /**
   * Native hybrid search using Qdrant Query API with prefetch + RRF fusion.
   * Requires Qdrant v1.10+ and @qdrant/js-client-rest ^1.10.0.
   *
   * Falls back to client-side RRF with two separate searches if the Query API
   * is not available.
   */
  async searchHybridNative(
    collection: string,
    denseVector: number[],
    sparseVector: SparseVectorData,
    limit: number = 10,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    try {
      // Try native Query API with prefetch + RRF fusion
      const response = await (this.client as any).query(collection, {
        prefetch: [
          {
            query: { name: 'dense', vector: denseVector },
            using: 'dense',
            limit: limit * 2,
            ...(filter ? { filter: filter as any } : {}),
          },
          {
            query: {
              name: 'sparse',
              vector: {
                indices: sparseVector.indices,
                values: sparseVector.values,
              },
            },
            using: 'sparse',
            limit: limit * 2,
            ...(filter ? { filter: filter as any } : {}),
          },
        ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
      });

      const points = response.points || response;
      return (Array.isArray(points) ? points : []).map((r: any) => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as Record<string, unknown>,
      }));
    } catch (error: any) {
      logger.debug('Native Query API unavailable, falling back to client-side RRF', {
        error: error.message,
      });
      return this.searchHybridClientSideRRF(collection, denseVector, sparseVector, limit, filter);
    }
  }

  /**
   * Client-side RRF fallback: two separate searches + Reciprocal Rank Fusion.
   */
  private async searchHybridClientSideRRF(
    collection: string,
    denseVector: number[],
    sparseVector: SparseVectorData,
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    const k = 60; // RRF constant

    // Dense search (try named vector first, fall back to anonymous)
    let denseResults: SearchResult[] = [];
    try {
      denseResults = await this.search(collection, denseVector, limit * 2, filter);
    } catch {
      // Collection might not support this vector config
    }

    // Sparse search (using named vector)
    let sparseResults: SearchResult[] = [];
    try {
      const response = await this.client.search(collection, {
        vector: {
          name: 'sparse',
          vector: {
            indices: sparseVector.indices,
            values: sparseVector.values,
          },
        } as any,
        limit: limit * 2,
        with_payload: true,
        filter: filter as any,
      });
      sparseResults = response.map(r => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as Record<string, unknown>,
      }));
    } catch {
      // Sparse search may not be available
    }

    // RRF fusion
    const scores = new Map<string, { score: number; result: SearchResult }>();

    for (let i = 0; i < denseResults.length; i++) {
      const r = denseResults[i];
      const rrfScore = 1 / (k + i + 1);
      scores.set(r.id, { score: rrfScore, result: r });
    }

    for (let i = 0; i < sparseResults.length; i++) {
      const r = sparseResults[i];
      const rrfScore = 1 / (k + i + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.id, { score: rrfScore, result: r });
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, result }) => ({ ...result, score }));
  }

  /**
   * Search vectors
   */
  async search(
    collection: string,
    vector: number[],
    limit: number = 10,
    filter?: Record<string, unknown>,
    scoreThreshold?: number
  ): Promise<SearchResult[]> {
    const searchParams = {
      limit,
      with_payload: true,
      filter: filter as any,
      score_threshold: scoreThreshold,
    };

    try {
      // Try named vector first (for collections with sparse vector support)
      const namedVector = { name: 'dense', vector } as any;
      const results = await this.client.search(collection, {
        vector: namedVector,
        ...searchParams,
      });

      return results.map(r => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as Record<string, unknown>,
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      // Fall back to anonymous vector (collections without named vectors)
      if (error.message?.includes('Bad Request') || error.status === 400) {
        const results = await this.client.search(collection, {
          vector,
          ...searchParams,
        });
        return results.map(r => ({
          id: r.id as string,
          score: r.score,
          payload: r.payload as Record<string, unknown>,
        }));
      }
      throw error;
    }
  }

  /**
   * Search vectors with grouping (returns one result per group)
   */
  async searchGroups(
    collection: string,
    vector: number[],
    groupBy: string,
    limit: number = 10,
    groupSize: number = 1,
    filter?: Record<string, unknown>,
    scoreThreshold?: number
  ): Promise<{ group: string; results: SearchResult[] }[]> {
    try {
      const namedVector = { name: 'dense', vector } as any;
      const response = await this.client.searchPointGroups(collection, {
        vector: namedVector,
        group_by: groupBy,
        limit,
        group_size: groupSize,
        with_payload: true,
        filter: filter as any,
        score_threshold: scoreThreshold,
      });

      return response.groups.map(group => ({
        group: String(group.id),
        results: group.hits.map(hit => ({
          id: hit.id as string,
          score: hit.score,
          payload: hit.payload as Record<string, unknown>,
        })),
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      // Fallback if groups API not supported - use regular search and group client-side
      logger.warn('searchPointGroups failed, falling back to client-side grouping', { error: error.message });
      const results = await this.search(collection, vector, limit * groupSize, filter, scoreThreshold);
      return this.groupResultsClientSide(results, groupBy, limit, groupSize);
    }
  }

  /**
   * Client-side grouping fallback
   */
  private groupResultsClientSide(
    results: SearchResult[],
    groupBy: string,
    limit: number,
    groupSize: number
  ): { group: string; results: SearchResult[] }[] {
    const groups = new Map<string, SearchResult[]>();

    for (const result of results) {
      const groupValue = String(result.payload[groupBy] || 'unknown');
      if (!groups.has(groupValue)) {
        groups.set(groupValue, []);
      }
      const groupResults = groups.get(groupValue)!;
      if (groupResults.length < groupSize) {
        groupResults.push(result);
      }
    }

    return Array.from(groups.entries())
      .slice(0, limit)
      .map(([group, results]) => ({ group, results }));
  }

  /**
   * Delete vectors by IDs
   */
  async delete(collection: string, ids: string[]): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      points: ids,
    });
  }

  /**
   * Delete vectors by filter
   */
  async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      filter: filter as any,
    });
  }

  /**
   * Count vectors in collection
   */
  async count(collection: string, filter?: Record<string, unknown>): Promise<number> {
    try {
      if (filter) {
        // Use count endpoint with filter (efficient with indexed fields)
        const result = await this.client.count(collection, {
          filter: filter as any,
          exact: true,
        });
        return result.count;
      }

      const info = await this.client.getCollection(collection);
      return info.points_count || 0;
    } catch (error: any) {
      if (error.status === 404) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Get faceted counts for a field (uses indexed field for efficiency)
   */
  async getFacetCounts(collection: string, field: string, values: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    // Run count queries in parallel for each value
    const promises = values.map(async (value) => {
      const filter = {
        must: [{ key: field, match: { value } }],
      };
      const count = await this.count(collection, filter);
      return { value, count };
    });

    const results = await Promise.all(promises);
    for (const { value, count } of results) {
      if (count > 0) {
        counts[value] = count;
      }
    }

    return counts;
  }

  /**
   * Aggregate counts by a specific payload field
   */
  async aggregateByField(collection: string, field: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    try {
      let offset: string | number | undefined = undefined;

      do {
        const response = await this.client.scroll(collection, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
        });

        for (const point of response.points) {
          const payload = point.payload as Record<string, unknown>;
          const value = payload[field];
          if (value && typeof value === 'string') {
            counts[value] = (counts[value] || 0) + 1;
          }
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset);

      return counts;
    } catch (error: any) {
      if (error.status === 404) {
        return {};
      }
      throw error;
    }
  }

  /**
   * Scroll collection with optional vectors for frontend visualization
   */
  async scrollCollection(collection: string, limit = 100, offset?: string, withVectors = false): Promise<{
    points: Array<{ id: string | number; payload: Record<string, unknown>; vector?: number[] }>;
    nextOffset?: string | number;
  }> {
    try {
      const response = await this.client.scroll(collection, {
        limit,
        offset: offset || undefined,
        with_payload: true,
        with_vector: withVectors,
      });

      const points = response.points.map((p: any) => ({
        id: p.id,
        payload: p.payload as Record<string, unknown>,
        vector: withVectors ? (Array.isArray(p.vector) ? p.vector : p.vector?.dense || undefined) : undefined,
      }));

      return {
        points,
        nextOffset: response.next_page_offset as string | number | undefined,
      };
    } catch (error: any) {
      if (error.status === 404) {
        return { points: [] };
      }
      throw error;
    }
  }

  /**
   * Get aggregated stats using indexed fields for efficiency
   * Falls back to scroll for unique file count (unavoidable for uniqueness)
   */
  async aggregateStats(collection: string): Promise<{
    totalFiles: number;
    totalVectors: number;
    languages: Record<string, number>;
    lastIndexed?: string;
  }> {
    try {
      // Get total vector count (fast)
      const totalVectors = await this.count(collection);
      if (totalVectors === 0) {
        return { totalFiles: 0, totalVectors: 0, languages: {}, lastIndexed: undefined };
      }

      // Get language counts using indexed facets
      // Common languages to check - uses indexed field
      const commonLanguages = [
        'typescript', 'javascript', 'python', 'vue', 'html', 'css', 'scss',
        'json', 'yaml', 'markdown', 'sql', 'shell', 'dockerfile', 'go',
        'java', 'rust', 'c', 'cpp', 'csharp', 'php', 'ruby', 'swift', 'kotlin'
      ];
      const languages = await this.getFacetCounts(collection, 'language', commonLanguages);

      // For unique files and lastIndexed, we need a limited scroll
      // Only scan first batch to get lastIndexed (newest entries are typically at end)
      let totalFiles = 0;
      let lastIndexed: string | undefined;
      const files = new Set<string>();

      // Scroll to count unique files (limit to 5000 for performance)
      let offset: string | number | undefined = undefined;
      let scanned = 0;
      const maxScan = 5000;

      do {
        const response = await this.client.scroll(collection, {
          limit: 1000,
          offset,
          with_payload: { include: ['file', 'indexedAt'] },
          with_vector: false,
        });

        for (const point of response.points) {
          const payload = point.payload as Record<string, unknown>;

          if (payload.file) {
            files.add(payload.file as string);
          }

          if (payload.indexedAt) {
            const indexedAt = payload.indexedAt as string;
            if (!lastIndexed || indexedAt > lastIndexed) {
              lastIndexed = indexedAt;
            }
          }
        }

        scanned += response.points.length;
        offset = response.next_page_offset as string | number | undefined;
      } while (offset && scanned < maxScan);

      totalFiles = files.size;
      // Estimate if we hit the limit
      if (scanned >= maxScan && totalVectors > maxScan) {
        // Rough estimate: unique files ratio
        const ratio = files.size / scanned;
        totalFiles = Math.round(totalVectors * ratio);
      }

      return {
        totalFiles,
        totalVectors,
        languages,
        lastIndexed,
      };
    } catch (error: any) {
      if (error.status === 404) {
        return { totalFiles: 0, totalVectors: 0, languages: {}, lastIndexed: undefined };
      }
      throw error;
    }
  }

  /**
   * Clear all vectors in a collection (but keep the collection)
   */
  async clearCollection(collection: string): Promise<void> {
    try {
      // Delete all points by scrolling and deleting in batches
      let offset: string | undefined = undefined;

      do {
        const response = await this.client.scroll(collection, {
          limit: 1000,
          offset,
          with_payload: false,
          with_vector: false,
        });

        const ids = response.points.map(p => p.id as string);
        if (ids.length > 0) {
          await this.delete(collection, ids);
        }

        offset = response.next_page_offset as string | undefined;
      } while (offset);

      logger.info(`Cleared collection: ${collection}`);
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  // ============================================
  // Alias Management (for zero-downtime operations)
  // ============================================

  /**
   * Create an alias for a collection
   */
  async createAlias(aliasName: string, collectionName: string): Promise<void> {
    try {
      await this.client.updateCollectionAliases({
        actions: [
          { create_alias: { alias_name: aliasName, collection_name: collectionName } },
        ],
      });
      logger.info(`Created alias: ${aliasName} -> ${collectionName}`);
    } catch (error: any) {
      logger.error(`Failed to create alias: ${aliasName}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Update an alias to point to a different collection (atomic swap)
   */
  async updateAlias(aliasName: string, newCollectionName: string): Promise<void> {
    try {
      // Get current collection for the alias
      const collections = await this.client.getCollections();
      const currentCollection = collections.collections.find(c =>
        c.name === aliasName || (c as any).aliases?.includes(aliasName)
      );

      // Atomic swap: delete old alias and create new one in single operation
      const actions: any[] = [
        { create_alias: { alias_name: aliasName, collection_name: newCollectionName } },
      ];

      await this.client.updateCollectionAliases({ actions });
      logger.info(`Updated alias: ${aliasName} -> ${newCollectionName}`);
    } catch (error: any) {
      logger.error(`Failed to update alias: ${aliasName}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Delete an alias
   */
  async deleteAlias(aliasName: string): Promise<void> {
    try {
      await this.client.updateCollectionAliases({
        actions: [
          { delete_alias: { alias_name: aliasName } },
        ],
      });
      logger.info(`Deleted alias: ${aliasName}`);
    } catch (error: any) {
      logger.error(`Failed to delete alias: ${aliasName}`, { error: error.message });
      throw error;
    }
  }

  /**
   * List all aliases across all collections
   */
  async listAliases(): Promise<{ alias: string; collection: string }[]> {
    try {
      const aliases: { alias: string; collection: string }[] = [];
      const collections = await this.client.getCollections();

      // Get aliases for each collection
      for (const collection of collections.collections) {
        const response = await this.client.getCollectionAliases(collection.name);
        for (const alias of response.aliases || []) {
          aliases.push({
            alias: (alias as any).alias_name,
            collection: collection.name,
          });
        }
      }

      return aliases;
    } catch (error: any) {
      logger.error('Failed to list aliases', { error: error.message });
      return [];
    }
  }

  // ============================================
  // Clustering & Similarity Analysis
  // ============================================

  /**
   * Find clusters of similar vectors
   */
  async findClusters(
    collection: string,
    seedIds: string[],
    limit: number = 10,
    scoreThreshold: number = 0.8
  ): Promise<{ seedId: string; similar: SearchResult[] }[]> {
    const clusters: { seedId: string; similar: SearchResult[] }[] = [];

    for (const seedId of seedIds) {
      try {
        // Use recommend API to find similar vectors
        const results = await this.client.recommend(collection, {
          positive: [seedId],
          limit,
          with_payload: true,
          score_threshold: scoreThreshold,
        });

        clusters.push({
          seedId,
          similar: results.map(r => ({
            id: r.id as string,
            score: r.score,
            payload: r.payload as Record<string, unknown>,
          })),
        });
      } catch (error: any) {
        logger.warn(`Failed to find cluster for ${seedId}`, { error: error.message });
      }
    }

    return clusters;
  }

  /**
   * Find potential duplicates in a collection
   */
  async findDuplicates(
    collection: string,
    limit: number = 100,
    threshold: number = 0.95
  ): Promise<{ group: SearchResult[]; similarity: number }[]> {
    const duplicates: { group: SearchResult[]; similarity: number }[] = [];
    const processed = new Set<string>();

    try {
      // Sample vectors to check for duplicates
      let offset: string | number | undefined = undefined;
      let checked = 0;

      do {
        const response = await this.client.scroll(collection, {
          limit: 100,
          offset,
          with_payload: true,
          with_vector: true,
        });

        for (const point of response.points) {
          if (processed.has(point.id as string)) continue;
          if (checked >= limit) break;

          const rawVector = point.vector;
          const vector = Array.isArray(rawVector)
            ? rawVector as number[]
            : (rawVector as any)?.dense as number[] | undefined;
          if (!vector || !Array.isArray(vector)) continue;

          // Find similar vectors
          const similar = await this.search(collection, vector, 5, undefined, threshold);

          // Filter out self and already processed
          const dupes = similar.filter(s =>
            s.id !== point.id && !processed.has(s.id)
          );

          if (dupes.length > 0) {
            const group = [
              { id: point.id as string, score: 1, payload: point.payload as Record<string, unknown> },
              ...dupes,
            ];
            duplicates.push({
              group,
              similarity: dupes[0].score,
            });

            // Mark all as processed
            group.forEach(g => processed.add(g.id));
          }

          processed.add(point.id as string);
          checked++;
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && checked < limit);

      return duplicates;
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get recommend (similar) vectors based on positive/negative examples
   */
  async recommend(
    collection: string,
    positiveIds: string[],
    negativeIds: string[] = [],
    limit: number = 10,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    try {
      const results = await this.client.recommend(collection, {
        positive: positiveIds,
        negative: negativeIds,
        limit,
        with_payload: true,
        filter: filter as any,
      });

      return results.map(r => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as Record<string, unknown>,
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  // ============================================
  // Quantization (Memory Optimization)
  // ============================================

  /**
   * Enable scalar quantization on a collection to reduce memory usage ~4x
   */
  async enableQuantization(collection: string, quantile: number = 0.99): Promise<void> {
    try {
      await this.client.updateCollection(collection, {
        quantization_config: {
          scalar: {
            type: 'int8',
            quantile,
            always_ram: true, // Keep quantized vectors in RAM for speed
          },
        },
      });
      logger.info(`Enabled quantization on collection: ${collection}`);
    } catch (error: any) {
      logger.error(`Failed to enable quantization on ${collection}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Disable quantization on a collection
   */
  async disableQuantization(collection: string): Promise<void> {
    try {
      await this.client.updateCollection(collection, {
        quantization_config: null as any,
      });
      logger.info(`Disabled quantization on collection: ${collection}`);
    } catch (error: any) {
      logger.error(`Failed to disable quantization on ${collection}`, { error: error.message });
      throw error;
    }
  }

  // ============================================
  // Snapshots (Backup & Restore)
  // ============================================

  /**
   * Create a snapshot of a collection
   */
  async createSnapshot(collection: string): Promise<{ name: string; createdAt: string }> {
    try {
      const result = await this.client.createSnapshot(collection);
      const snapshotName = result?.name || `snapshot_${Date.now()}`;
      logger.info(`Created snapshot for ${collection}: ${snapshotName}`);
      return {
        name: snapshotName,
        createdAt: new Date().toISOString(),
      };
    } catch (error: any) {
      logger.error(`Failed to create snapshot for ${collection}`, { error: error.message });
      throw error;
    }
  }

  /**
   * List snapshots for a collection
   */
  async listSnapshots(collection: string): Promise<Array<{ name: string; size: number; createdAt: string }>> {
    try {
      const snapshots = await this.client.listSnapshots(collection);
      return snapshots.map((s: any) => ({
        name: s.name,
        size: s.size || 0,
        createdAt: s.creation_time || new Date().toISOString(),
      }));
    } catch (error: any) {
      logger.error(`Failed to list snapshots for ${collection}`, { error: error.message });
      return [];
    }
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(collection: string, snapshotName: string): Promise<void> {
    try {
      await this.client.deleteSnapshot(collection, snapshotName);
      logger.info(`Deleted snapshot ${snapshotName} from ${collection}`);
    } catch (error: any) {
      logger.error(`Failed to delete snapshot ${snapshotName}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Recover collection from a snapshot
   */
  async recoverFromSnapshot(collection: string, snapshotName: string): Promise<void> {
    try {
      // Note: Qdrant's recover requires the snapshot to be accessible
      // This is a simplified implementation - full recovery may need file system access
      await (this.client as any).recoverSnapshot(collection, {
        location: snapshotName,
      });
      logger.info(`Recovered ${collection} from snapshot ${snapshotName}`);
    } catch (error: any) {
      logger.error(`Failed to recover from snapshot ${snapshotName}`, { error: error.message });
      throw error;
    }
  }

  // ============================================
  // Analytics & Telemetry
  // ============================================

  /**
   * Get detailed collection analytics
   */
  async getCollectionAnalytics(collection: string): Promise<{
    vectorCount: number;
    segmentsCount: number;
    memoryUsageBytes: number;
    diskUsageBytes: number;
    indexedFieldsCount: number;
    optimizerStatus: string;
    quantizationEnabled: boolean;
    avgVectorDensity?: number;
    languageBreakdown: Record<string, number>;
    fileCount: number;
    lastIndexed?: string;
  }> {
    try {
      const info = await this.client.getCollection(collection);
      const stats = await this.aggregateStats(collection);

      // Extract memory info from collection info
      const memoryUsageBytes = (info as any).vectors_count * config.VECTOR_SIZE * 4; // Estimate: 4 bytes per float
      const diskUsageBytes = (info as any).points_count * (config.VECTOR_SIZE * 4 + 500); // Estimate with payload

      return {
        vectorCount: info.points_count || 0,
        segmentsCount: info.segments_count || 0,
        memoryUsageBytes,
        diskUsageBytes,
        indexedFieldsCount: Object.keys((info.config?.params as any)?.payload_schema || {}).length,
        optimizerStatus: typeof info.optimizer_status === 'object'
          ? (info.optimizer_status as any).status || 'unknown'
          : String(info.optimizer_status || 'ok'),
        quantizationEnabled: !!(info.config?.quantization_config),
        languageBreakdown: stats.languages,
        fileCount: stats.totalFiles,
        lastIndexed: stats.lastIndexed,
      };
    } catch (error: any) {
      if (error.status === 404) {
        return {
          vectorCount: 0,
          segmentsCount: 0,
          memoryUsageBytes: 0,
          diskUsageBytes: 0,
          indexedFieldsCount: 0,
          optimizerStatus: 'not_found',
          quantizationEnabled: false,
          languageBreakdown: {},
          fileCount: 0,
        };
      }
      throw error;
    }
  }

  /**
   * Get cluster health and performance info
   */
  async getClusterInfo(): Promise<{
    status: string;
    collectionsCount: number;
    totalVectors: number;
    totalMemoryBytes: number;
  }> {
    try {
      const collections = await this.client.getCollections();
      let totalVectors = 0;
      let totalMemoryBytes = 0;

      for (const col of collections.collections) {
        try {
          const info = await this.client.getCollection(col.name);
          totalVectors += info.points_count || 0;
          totalMemoryBytes += (info.points_count || 0) * config.VECTOR_SIZE * 4;
        } catch {
          // Skip inaccessible collections
        }
      }

      return {
        status: 'ok',
        collectionsCount: collections.collections.length,
        totalVectors,
        totalMemoryBytes,
      };
    } catch (error: any) {
      logger.error('Failed to get cluster info', { error: error.message });
      return {
        status: 'error',
        collectionsCount: 0,
        totalVectors: 0,
        totalMemoryBytes: 0,
      };
    }
  }
}

export const vectorStore = new VectorStoreService();
export default vectorStore;
