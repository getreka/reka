/**
 * RAG-Fusion Service — Multi-Query Retrieval with RRF Merge
 *
 * Generates multiple reformulations of a query, retrieves for each,
 * and merges results using Reciprocal Rank Fusion (RRF).
 *
 * Opt-in via `ragFusion: true` parameter in recall API.
 */

import config from '../config';
import { logger } from '../utils/logger';
import { llm } from './llm';

export interface FusionResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

class RetrievalFusionService {
  /**
   * Generate alternative search queries via Ollama (utility complexity, ~100-200ms).
   */
  async generateReformulations(query: string, count?: number): Promise<string[]> {
    const n = count || config.RAG_FUSION_REFORMULATION_COUNT;

    try {
      const result = await llm.completeWithBestProvider(
        `Generate ${n} alternative search queries for memory recall. Different wording, same intent. One per line. No numbering or bullets.\n\nOriginal: "${query}"`,
        {
          complexity: 'utility',
          maxTokens: 200,
          temperature: 0.7,
          think: false,
        }
      );

      const reformulations = result.text
        .split('\n')
        .map((l: string) => l.replace(/^\d+[\.\)]\s*[-•]?\s*/, '').trim())
        .filter((l: string) => l.length > 5 && l.length < 200)
        .slice(0, n);

      logger.debug('RAG-Fusion reformulations', {
        original: query.slice(0, 80),
        count: reformulations.length,
      });

      return reformulations;
    } catch (error: any) {
      logger.warn('RAG-Fusion reformulation failed, using original query only', {
        error: error.message?.slice(0, 80),
      });
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion — merge multiple ranked lists into one.
   * RRF_score(doc) = Σ 1/(k + rank_i(doc)) for each list i
   */
  reciprocalRankFusion<T extends FusionResult>(
    rankedLists: T[][],
    k: number = 60
  ): T[] {
    const scores = new Map<string, { score: number; result: T }>();

    for (const list of rankedLists) {
      list.forEach((result, rank) => {
        const id = result.id;
        const rrfScore = 1 / (k + rank + 1);
        const existing = scores.get(id);
        if (existing) {
          existing.score += rrfScore;
        } else {
          scores.set(id, { score: rrfScore, result: { ...result } });
        }
      });
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .map(({ result, score }) => ({ ...result, score }));
  }

  /**
   * Full RAG-Fusion pipeline: reformulate → parallel search → RRF merge.
   *
   * @param query Original query
   * @param searchFn Function that performs search for a given query string
   * @param limit Max results to return
   */
  async fusedRecall<T extends FusionResult>(
    query: string,
    searchFn: (q: string) => Promise<T[]>,
    limit: number = 10
  ): Promise<T[]> {
    const reformulations = await this.generateReformulations(query);
    const allQueries = [query, ...reformulations];

    // Parallel search for all queries
    const allResults = await Promise.all(
      allQueries.map(q => searchFn(q).catch(() => [] as T[]))
    );

    // RRF merge
    const fused = this.reciprocalRankFusion(allResults);

    logger.debug('RAG-Fusion complete', {
      queries: allQueries.length,
      totalResults: allResults.reduce((s, r) => s + r.length, 0),
      uniqueResults: fused.length,
      limit,
    });

    return fused.slice(0, limit);
  }
}

export const retrievalFusion = new RetrievalFusionService();
