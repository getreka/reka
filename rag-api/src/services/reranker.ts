/**
 * Cross-Encoder Reranker Service
 *
 * Uses BGE-Reranker-v2-M3 (via BGE-M3 server) to re-score search results
 * after initial vector retrieval. Blends reranker score with original
 * vector similarity for robust ranking.
 *
 * Features:
 * - Graceful fallback (returns original order if reranker unavailable)
 * - Configurable blend weight, timeout, min results threshold
 * - Content truncation (512 chars per doc for efficiency)
 */

import axios from 'axios';
import config from '../config';
import { logger } from '../utils/logger';

export interface RerankableResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

class RerankerService {
  private url: string;
  private enabled: boolean;
  private minResults: number;
  private blendWeight: number;
  private timeout: number;
  private available: boolean = true;
  private lastCheckTime: number = 0;

  constructor() {
    this.url = config.RERANKER_URL;
    this.enabled = config.RERANKER_ENABLED;
    this.minResults = config.RERANKER_MIN_RESULTS;
    this.blendWeight = config.RERANKER_BLEND_WEIGHT;
    this.timeout = config.RERANKER_TIMEOUT_MS;
  }

  /**
   * Rerank search results using cross-encoder.
   * Returns original order if reranker unavailable or below threshold.
   */
  async rerank<T extends RerankableResult>(
    query: string,
    results: T[],
    topK?: number
  ): Promise<T[]> {
    if (!this.enabled || results.length < this.minResults) {
      return topK ? results.slice(0, topK) : results;
    }

    // Circuit breaker: skip if recently unavailable (check every 60s)
    if (!this.available && Date.now() - this.lastCheckTime < 60000) {
      return topK ? results.slice(0, topK) : results;
    }

    const documents = results.map((r) => String(r.payload?.content || '').slice(0, 512));

    // Skip if documents are empty (no content to rerank)
    if (documents.every((d) => d.length === 0)) {
      return topK ? results.slice(0, topK) : results;
    }

    try {
      const response = await axios.post(
        `${this.url}/rerank`,
        { query, documents },
        { timeout: this.timeout }
      );

      const scores: number[] = response.data.scores;

      if (!scores || scores.length !== results.length) {
        logger.warn('Reranker returned unexpected scores count', {
          expected: results.length,
          got: scores?.length,
        });
        return topK ? results.slice(0, topK) : results;
      }

      this.available = true;

      // Blend: rerankerWeight * rerankerScore + (1 - rerankerWeight) * originalScore
      const reranked = results
        .map((r, i) => ({
          ...r,
          score: scores[i] * this.blendWeight + r.score * (1 - this.blendWeight),
        }))
        .sort((a, b) => b.score - a.score);

      return topK ? reranked.slice(0, topK) : reranked;
    } catch (error: any) {
      this.available = false;
      this.lastCheckTime = Date.now();
      logger.debug('Reranker unavailable, using original ranking', {
        error: error.message?.slice(0, 80),
      });
      return topK ? results.slice(0, topK) : results;
    }
  }
}

export const reranker = new RerankerService();
