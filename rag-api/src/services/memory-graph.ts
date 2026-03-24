/**
 * Memory Graph Service — graph operations over memory relationships.
 *
 * Relationships are stored as `relationships[]` arrays on memory payloads.
 * This service provides traversal and query operations over that implicit graph.
 */

import { vectorStore } from './vector-store';
import { logger } from '../utils/logger';
import type { MemoryRelation, MemoryRelationType } from './memory';

// ── Types ─────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  content: string;
  type: string;
  relationships: MemoryRelation[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: MemoryRelationType;
  reason?: string;
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Service ───────────────────────────────────────────────

class MemoryGraphService {
  /**
   * Get neighbors of a memory (outgoing relationships).
   */
  async getNeighbors(
    projectName: string,
    memoryId: string,
    edgeTypes?: MemoryRelationType[]
  ): Promise<{ neighbors: GraphNode[]; edges: GraphEdge[] }> {
    const node = await this.getNode(projectName, memoryId);
    if (!node || !node.relationships?.length) {
      return { neighbors: [], edges: [] };
    }

    const edges: GraphEdge[] = [];
    const neighborIds: string[] = [];

    for (const rel of node.relationships) {
      if (edgeTypes && !edgeTypes.includes(rel.type)) continue;
      edges.push({
        from: memoryId,
        to: rel.targetId,
        type: rel.type,
        reason: rel.reason,
      });
      neighborIds.push(rel.targetId);
    }

    const neighbors = await this.getNodes(projectName, neighborIds);
    return { neighbors, edges };
  }

  /**
   * Extract subgraph around given memory IDs (1-hop neighborhood).
   */
  async getSubgraph(projectName: string, memoryIds: string[]): Promise<Subgraph> {
    const nodes: Map<string, GraphNode> = new Map();
    const edges: GraphEdge[] = [];

    // Get all seed nodes
    const seedNodes = await this.getNodes(projectName, memoryIds);
    for (const node of seedNodes) {
      nodes.set(node.id, node);
    }

    // Expand 1-hop from each seed
    for (const node of seedNodes) {
      if (!node.relationships) continue;
      for (const rel of node.relationships) {
        edges.push({
          from: node.id,
          to: rel.targetId,
          type: rel.type,
          reason: rel.reason,
        });

        if (!nodes.has(rel.targetId)) {
          const neighbor = await this.getNode(projectName, rel.targetId);
          if (neighbor) nodes.set(neighbor.id, neighbor);
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges,
    };
  }

  /**
   * Get a single node from any memory collection.
   */
  async getNode(projectName: string, memoryId: string): Promise<GraphNode | null> {
    const nodes = await this.getNodes(projectName, [memoryId]);
    return nodes[0] ?? null;
  }

  /**
   * Get multiple nodes by ID across all memory collections.
   */
  async getNodes(projectName: string, ids: string[]): Promise<GraphNode[]> {
    if (ids.length === 0) return [];

    const collections = [
      `${projectName}_memory_semantic`,
      `${projectName}_memory_episodic`,
      `${projectName}_agent_memory`,
    ];

    const foundIds = new Set<string>();
    const nodes: GraphNode[] = [];

    for (const collection of collections) {
      const remaining = ids.filter(id => !foundIds.has(id));
      if (remaining.length === 0) break;

      try {
        const client = (vectorStore as any).client;
        const retrieved = await client.retrieve(collection, {
          ids: remaining,
          with_payload: true,
        });

        for (const point of retrieved) {
          if (foundIds.has(point.id as string)) continue;
          foundIds.add(point.id as string);

          const p = point.payload as Record<string, unknown>;
          nodes.push({
            id: point.id as string,
            content: ((p.content as string) ?? '').slice(0, 300),
            type: (p.subtype ?? p.type ?? 'unknown') as string,
            relationships: (p.relationships as MemoryRelation[]) ?? [],
          });
        }
      } catch {
        // Collection may not exist, continue
      }
    }

    return nodes;
  }
}

export const memoryGraph = new MemoryGraphService();
