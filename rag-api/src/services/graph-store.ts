/**
 * Graph Store Service - Stores and queries code dependency edges in Qdrant.
 *
 * Each point in {project}_graph represents an edge between code entities.
 * Supports N-hop expansion, dependents/dependencies, and blast radius analysis.
 *
 * Vectors: graph edges are structural data, not semantic. A zero vector is stored
 * per point so Qdrant collection requirements are satisfied while all queries use
 * payload filter/scroll — never vector similarity search.
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { cacheService } from './cache';
import { logger } from '../utils/logger';
import { graphEdgesTotal, graphExpansionDuration } from '../utils/metrics';
import config from '../config';
import type { GraphEdge } from './parsers/ast-parser';

const GRAPH_EXPAND_CACHE_TTL = 300; // 5 minutes

const CONFIDENCE_RANK: Record<string, number> = {
  lsp: 4,
  scip: 3,
  'tree-sitter': 2,
  heuristic: 1,
};

function shouldUpgrade(existing: string | undefined, incoming: string | undefined): boolean {
  return (CONFIDENCE_RANK[incoming || ''] || 0) > (CONFIDENCE_RANK[existing || ''] || 0);
}

/** Returns a zero vector of the configured dimension. */
function zeroVector(): number[] {
  return new Array(config.VECTOR_SIZE).fill(0);
}

class GraphStoreService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_graph`;
  }

  /**
   * Ensure keyword payload indexes exist on the graph collection.
   * Called after collection creation; safe to call repeatedly.
   */
  async ensureIndexes(projectName: string): Promise<void> {
    const collection = this.getCollectionName(projectName);
    await vectorStore.ensurePayloadIndexes(collection);
  }

  /**
   * Index edges for a file (replaces existing edges for that file).
   */
  async indexFileEdges(projectName: string, filePath: string, edges: GraphEdge[]): Promise<void> {
    const collection = this.getCollectionName(projectName);

    // Clear existing edges for this file
    await this.clearFileEdges(projectName, filePath);

    if (edges.length === 0) return;

    const dummy = zeroVector();
    const points: VectorPoint[] = edges.map((edge) => {
      graphEdgesTotal.inc({ project: projectName, edge_type: edge.edgeType });

      const payload: Record<string, unknown> = {
        fromFile: edge.fromFile,
        fromSymbol: edge.fromSymbol,
        toFile: edge.toFile,
        toSymbol: edge.toSymbol,
        edgeType: edge.edgeType,
        project: projectName,
      };

      if (edge.confidence !== undefined) {
        payload.confidence = edge.confidence;
      }
      if (edge.symbolDescriptor !== undefined) {
        payload.symbolDescriptor = edge.symbolDescriptor;
      }

      return { id: uuidv4(), vector: dummy, payload };
    });

    await vectorStore.upsert(collection, points);
    logger.debug(`Indexed ${edges.length} edges for ${filePath}`, { project: projectName });
  }

  /**
   * Merge SCIP edges into existing graph edges for a file.
   * Instead of replacing all edges, this:
   * 1. Reads existing edges for the file
   * 2. Upgrades matching edges (same fromSymbol+edgeType) with SCIP toFile/toSymbol/confidence
   * 3. Appends SCIP-only edges that have no tree-sitter counterpart
   * 4. Preserves tree-sitter edges that SCIP didn't touch (e.g. calls, extends)
   */
  async mergeFileEdges(
    projectName: string,
    filePath: string,
    scipEdges: GraphEdge[]
  ): Promise<void> {
    const collection = this.getCollectionName(projectName);

    // Read existing edges for this file
    const existing = await this.getEdges(collection, 'fromFile', filePath);

    // Build SCIP lookup: (fromSymbol, edgeType) → edge
    const scipByKey = new Map<string, GraphEdge>();
    for (const edge of scipEdges) {
      const key = `${edge.fromSymbol}::${edge.edgeType}`;
      scipByKey.set(key, edge);
    }

    // Merge: upgrade existing edges with SCIP data, keep unmatched tree-sitter edges
    const merged: GraphEdge[] = [];
    const usedScipKeys = new Set<string>();

    for (const edge of existing) {
      const key = `${edge.fromSymbol}::${edge.edgeType}`;
      const incoming = scipByKey.get(key);
      if (incoming && shouldUpgrade(edge.confidence, incoming.confidence)) {
        // Upgrade with higher-confidence resolution
        merged.push({
          ...edge,
          toFile: incoming.toFile,
          toSymbol: incoming.toSymbol,
          confidence: incoming.confidence,
          symbolDescriptor: incoming.symbolDescriptor,
        });
        usedScipKeys.add(key);
      } else {
        // Keep existing edge as-is (already equal or higher confidence)
        merged.push(edge);
      }
    }

    // Append SCIP-only edges (no tree-sitter counterpart)
    for (const edge of scipEdges) {
      const key = `${edge.fromSymbol}::${edge.edgeType}`;
      if (!usedScipKeys.has(key)) {
        merged.push(edge);
      }
    }

    // Replace file edges with merged set
    await this.clearFileEdges(projectName, filePath);
    if (merged.length === 0) return;

    const dummy = zeroVector();
    const points: VectorPoint[] = merged.map((edge) => {
      const payload: Record<string, unknown> = {
        fromFile: edge.fromFile,
        fromSymbol: edge.fromSymbol,
        toFile: edge.toFile,
        toSymbol: edge.toSymbol,
        edgeType: edge.edgeType,
        project: projectName,
      };
      if (edge.confidence) payload.confidence = edge.confidence;
      if (edge.symbolDescriptor) payload.symbolDescriptor = edge.symbolDescriptor;
      return { id: uuidv4(), vector: dummy, payload };
    });

    await vectorStore.upsert(collection, points);
    logger.debug(
      `Merged ${merged.length} edges for ${filePath} (${usedScipKeys.size} upgraded by incoming edges)`,
      {
        project: projectName,
      }
    );
  }

  /**
   * Clear all edges originating from a file.
   */
  async clearFileEdges(projectName: string, filePath: string): Promise<void> {
    const collection = this.getCollectionName(projectName);

    try {
      await vectorStore.deleteByFilter(collection, {
        must: [{ key: 'fromFile', match: { value: filePath } }],
      });
    } catch (error: any) {
      if (error.status !== 404) {
        logger.warn(`Failed to clear edges for ${filePath}`, { error: error.message });
      }
    }
  }

  /**
   * N-hop expansion: given seed files, find connected files up to N hops.
   */
  async expand(projectName: string, files: string[], hops: number = 1): Promise<string[]> {
    const startTime = Date.now();

    // Check cache first
    const cacheKey = `graph:expand:${projectName}:${files.sort().join(',')}:${hops}`;
    const cached = await cacheService.get<string[]>(cacheKey);
    if (cached) {
      graphExpansionDuration.observe({ project: projectName }, (Date.now() - startTime) / 1000);
      return cached;
    }

    const collection = this.getCollectionName(projectName);
    const visited = new Set<string>(files);
    let frontier = [...files];

    try {
      for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
        const nextFrontier: string[] = [];

        for (const file of frontier) {
          // Get outgoing edges
          const deps = await this.getEdgesByFile(collection, 'fromFile', file);
          for (const dep of deps) {
            if (!visited.has(dep)) {
              visited.add(dep);
              nextFrontier.push(dep);
            }
          }

          // Get incoming edges
          const dependents = await this.getEdgesByFile(collection, 'toFile', file);
          for (const dep of dependents) {
            if (!visited.has(dep)) {
              visited.add(dep);
              nextFrontier.push(dep);
            }
          }
        }

        frontier = nextFrontier;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.warn('Graph expansion failed', { error: error.message });
      }
    }

    const result = [...visited];
    await cacheService.set(cacheKey, result, GRAPH_EXPAND_CACHE_TTL);

    graphExpansionDuration.observe({ project: projectName }, (Date.now() - startTime) / 1000);
    return result;
  }

  /**
   * Get files that depend on (import/call) the given file.
   */
  async getDependents(projectName: string, filePath: string): Promise<GraphEdge[]> {
    const collection = this.getCollectionName(projectName);
    return this.getEdges(collection, 'toFile', filePath);
  }

  /**
   * Get files that the given file depends on.
   */
  async getDependencies(projectName: string, filePath: string): Promise<GraphEdge[]> {
    const collection = this.getCollectionName(projectName);
    return this.getEdges(collection, 'fromFile', filePath);
  }

  /**
   * Transitive impact analysis: find all files affected by changes to given files.
   */
  async getBlastRadius(
    projectName: string,
    filePaths: string[],
    maxDepth: number = 3
  ): Promise<{ affectedFiles: string[]; depth: number; edgeCount: number }> {
    const collection = this.getCollectionName(projectName);
    const affected = new Set<string>(filePaths);
    let frontier = [...filePaths];
    let depth = 0;
    let edgeCount = 0;

    try {
      for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
        depth = d + 1;
        const nextFrontier: string[] = [];

        for (const file of frontier) {
          // Only follow incoming edges (who depends on this file)
          const results = await vectorStore['client'].scroll(collection, {
            limit: 100,
            with_payload: true,
            filter: {
              must: [{ key: 'toFile', match: { value: file } }],
            },
          });

          for (const point of results.points) {
            const payload = point.payload as Record<string, unknown>;
            const fromFile = payload.fromFile as string;
            edgeCount++;

            if (!affected.has(fromFile)) {
              affected.add(fromFile);
              nextFrontier.push(fromFile);
            }
          }
        }

        frontier = nextFrontier;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.warn('Blast radius analysis failed', { error: error.message });
      }
    }

    return {
      affectedFiles: [...affected],
      depth,
      edgeCount,
    };
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async getEdges(
    collection: string,
    field: 'fromFile' | 'toFile',
    filePath: string
  ): Promise<GraphEdge[]> {
    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 100,
        with_payload: true,
        filter: {
          must: [{ key: field, match: { value: filePath } }],
        },
      });

      return results.points.map((p) => {
        const payload = p.payload as Record<string, unknown>;
        const edge: GraphEdge = {
          fromFile: payload.fromFile as string,
          fromSymbol: payload.fromSymbol as string,
          toFile: payload.toFile as string,
          toSymbol: payload.toSymbol as string,
          edgeType: payload.edgeType as GraphEdge['edgeType'],
        };
        if (payload.confidence !== undefined) {
          edge.confidence = payload.confidence as GraphEdge['confidence'];
        }
        if (payload.symbolDescriptor !== undefined) {
          edge.symbolDescriptor = payload.symbolDescriptor as string;
        }
        return edge;
      });
    } catch (error: any) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  private async getEdgesByFile(
    collection: string,
    field: 'fromFile' | 'toFile',
    filePath: string
  ): Promise<string[]> {
    const otherField = field === 'fromFile' ? 'toFile' : 'fromFile';

    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 100,
        with_payload: { include: [otherField] },
        filter: {
          must: [{ key: field, match: { value: filePath } }],
        },
      });

      return results.points
        .map((p) => (p.payload as Record<string, unknown>)[otherField] as string)
        .filter(Boolean);
    } catch (error: any) {
      if (error.status === 404) return [];
      throw error;
    }
  }
}

export const graphStore = new GraphStoreService();
export default graphStore;
