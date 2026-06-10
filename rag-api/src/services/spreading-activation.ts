/**
 * Spreading Activation — graph-aware memory recall.
 *
 * Like neural activation spreading through synaptic connections:
 * 1. Seed memories (from vector search) get initial activation = search score
 * 2. Activation spreads along typed relationship edges with weights
 * 3. Each hop decays activation by a factor
 * 4. Below threshold = stop propagating
 *
 * Edge weights encode relationship importance:
 *   supersedes: 0.9, caused_by: 0.8, follow_up/refines: 0.7,
 *   contradicts: 0.6, alternative_to: 0.5, relates_to: 0.3
 */

import { memoryGraph, type GraphNode } from './memory-graph';
import { cacheService } from './cache';
import { logger } from '../utils/logger';
import config from '../config';
import crypto from 'crypto';
import type { MemoryRelationType } from './memory';

// ── Types ─────────────────────────────────────────────────

export interface ActivationSeed {
  id: string;
  activation: number;
}

export interface ActivatedMemory {
  id: string;
  content: string;
  type: string;
  activation: number;
  hop: number; // 0 = seed, 1 = 1-hop neighbor, etc.
  activatedVia?: string; // edge type that activated this node
}

export interface ActivationOptions {
  maxHops?: number;
  threshold?: number;
  crossGraph?: boolean; // reserved for code-graph bridging (Phase 4+)
}

// ── Edge Weights ──────────────────────────────────────────

const EDGE_WEIGHTS: Record<string, number> = {
  supersedes: 0.9,
  caused_by: 0.8,
  follow_up: 0.7,
  refines: 0.7,
  extends: 0.7,
  contradicts: 0.6,
  alternative_to: 0.5,
  relates_to: 0.3,
};

function getEdgeWeight(type: string): number {
  return EDGE_WEIGHTS[type] ?? 0.3;
}

// ── Service ───────────────────────────────────────────────

class SpreadingActivationService {
  /**
   * Run spreading activation from seed memories.
   * Returns all activated memories (seeds + neighbors) sorted by activation.
   */
  async activate(
    projectName: string,
    seeds: ActivationSeed[],
    opts?: ActivationOptions
  ): Promise<ActivatedMemory[]> {
    const maxHops = opts?.maxHops ?? config.SPREADING_ACTIVATION_MAX_HOPS;
    const threshold = opts?.threshold ?? config.SPREADING_ACTIVATION_THRESHOLD;

    if (seeds.length === 0) return [];

    // Check cache
    const cacheKey = this.cacheKey(projectName, seeds);
    const cached = await this.getFromCache(cacheKey);
    if (cached) return cached;

    // Activation map: memoryId → { activation, hop, activatedVia, content, type }
    const activated = new Map<string, ActivatedMemory>();

    // Initialize seeds
    const seedNodes = await memoryGraph.getNodes(
      projectName,
      seeds.map((s) => s.id)
    );
    const nodeMap = new Map(seedNodes.map((n) => [n.id, n]));

    for (const seed of seeds) {
      const node = nodeMap.get(seed.id);
      activated.set(seed.id, {
        id: seed.id,
        content: node?.content ?? '',
        type: node?.type ?? 'unknown',
        activation: seed.activation,
        hop: 0,
      });
    }

    // BFS: spread activation hop by hop
    let frontier = [...seeds];

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: ActivationSeed[] = [];

      for (const current of frontier) {
        const node = nodeMap.get(current.id);
        if (!node?.relationships) continue;

        for (const rel of node.relationships) {
          const edgeWeight = getEdgeWeight(rel.type);
          const propagated =
            current.activation * edgeWeight * config.SPREADING_ACTIVATION_HOP_DECAY;

          if (propagated < threshold) continue;

          const existing = activated.get(rel.targetId);
          if (existing && existing.activation >= propagated) continue;

          // Fetch neighbor node if not yet known
          if (!nodeMap.has(rel.targetId)) {
            const neighbor = await memoryGraph.getNode(projectName, rel.targetId);
            if (neighbor) nodeMap.set(neighbor.id, neighbor);
          }

          const neighborNode = nodeMap.get(rel.targetId);

          const entry: ActivatedMemory = {
            id: rel.targetId,
            content: neighborNode?.content ?? '',
            type: neighborNode?.type ?? 'unknown',
            activation: propagated,
            hop,
            activatedVia: rel.type,
          };

          activated.set(rel.targetId, entry);
          nextFrontier.push({ id: rel.targetId, activation: propagated });
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    const result = [...activated.values()].sort((a, b) => b.activation - a.activation);

    // Cache result
    await this.setCache(cacheKey, result);

    return result;
  }

  // ── Cache ─────────────────────────────────────────────────

  private cacheKey(projectName: string, seeds: ActivationSeed[]): string {
    const seedStr = seeds
      .map((s) => `${s.id}:${s.activation.toFixed(3)}`)
      .sort()
      .join('|');
    const hash = crypto.createHash('md5').update(seedStr).digest('hex');
    return `sa_cache:${projectName}:${hash}`;
  }

  private async getFromCache(key: string): Promise<ActivatedMemory[] | null> {
    return cacheService.get<ActivatedMemory[]>(key);
  }

  private async setCache(key: string, result: ActivatedMemory[]): Promise<void> {
    await cacheService.set(key, result, config.SPREADING_ACTIVATION_CACHE_TTL);
  }
}

export const spreadingActivation = new SpreadingActivationService();
