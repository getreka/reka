/**
 * Predictive Loader Service - Prefetch likely-needed embeddings and search results
 *
 * Analyzes session activity and prefetches resources in the background,
 * making subsequent tool calls faster via cache hits.
 *
 * Prediction strategies:
 * - File-based: Current files -> find related files via vector similarity -> prefetch embeddings
 * - Query-based: Recent queries -> detect patterns -> pre-warm search cache
 * - Tool chain: Tools used -> predict next tool in workflow -> prefetch its likely inputs
 * - Feature context: Active features -> preload related code/docs
 */

import { vectorStore, SearchResult } from './vector-store';
import { embeddingService } from './embedding';
import { cacheService } from './cache';
import { usagePatterns } from './usage-patterns';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface Prediction {
  type: 'file' | 'query' | 'tool_input' | 'feature';
  resource: string;
  confidence: number;
  strategy: 'file_similarity' | 'query_pattern' | 'tool_chain' | 'feature_context';
  reason: string;
}

export interface PrefetchResult {
  sessionId: string;
  predictionsGenerated: number;
  prefetchedCount: number;
  skippedCount: number;
  durationMs: number;
  predictions: Array<{
    resource: string;
    type: string;
    confidence: number;
    prefetched: boolean;
  }>;
}

export interface PredictionStats {
  totalPredictions: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  byStrategy: Record<string, { predictions: number; hits: number; hitRate: number }>;
}

// ============================================
// Constants
// ============================================

const MIN_CONFIDENCE = 0.6;
const MAX_PREDICTIONS_PER_TRIGGER = 10;
const MAX_CONCURRENT_PREFETCHES = 5;
const RATE_LIMIT_MS = 30_000; // 30 seconds per session

// Tool chain predictions: if tool A is used, predict tool B needs these inputs
const TOOL_CHAIN_MAP: Record<string, { nextTool: string; inputType: string }[]> = {
  search_codebase: [
    { nextTool: 'ask_codebase', inputType: 'query' },
    { nextTool: 'explain_code', inputType: 'query' },
  ],
  find_feature: [
    { nextTool: 'search_codebase', inputType: 'query' },
    { nextTool: 'get_feature_status', inputType: 'query' },
  ],
  ask_codebase: [{ nextTool: 'search_codebase', inputType: 'query' }],
  recall: [{ nextTool: 'search_codebase', inputType: 'query' }],
  start_session: [
    { nextTool: 'search_codebase', inputType: 'query' },
    { nextTool: 'recall', inputType: 'query' },
  ],
};

// ============================================
// Service
// ============================================

class PredictiveLoaderService {
  private lastPrefetchTime: Map<string, number> = new Map();
  private statsCache: Map<string, PredictionStats> = new Map();

  /**
   * Analyze session context and generate predictions of likely-needed resources
   */
  async predict(
    projectName: string,
    sessionId: string,
    context: {
      currentFiles?: string[];
      recentQueries?: string[];
      toolsUsed?: string[];
      activeFeatures?: string[];
    }
  ): Promise<Prediction[]> {
    const predictions: Prediction[] = [];

    try {
      // Strategy 1: File-based predictions
      const filePredictions = await this.predictFromFiles(projectName, context.currentFiles || []);
      predictions.push(...filePredictions);

      // Strategy 2: Query-based predictions
      const queryPredictions = this.predictFromQueries(context.recentQueries || []);
      predictions.push(...queryPredictions);

      // Strategy 3: Tool chain predictions
      const toolPredictions = this.predictFromToolChain(
        context.toolsUsed || [],
        context.recentQueries || []
      );
      predictions.push(...toolPredictions);

      // Strategy 4: Feature context predictions
      const featurePredictions = this.predictFromFeatures(
        projectName,
        context.activeFeatures || []
      );
      predictions.push(...featurePredictions);

      // Filter by confidence and deduplicate
      const filtered = predictions
        .filter((p) => p.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence);

      // Deduplicate by resource
      const seen = new Set<string>();
      const deduped: Prediction[] = [];
      for (const p of filtered) {
        if (!seen.has(p.resource)) {
          seen.add(p.resource);
          deduped.push(p);
        }
      }

      return deduped.slice(0, MAX_PREDICTIONS_PER_TRIGGER);
    } catch (error: any) {
      logger.warn('Prediction generation failed', { error: error.message, sessionId });
      return [];
    }
  }

  /**
   * Execute background prefetch for a session
   */
  async prefetch(
    projectName: string,
    sessionId: string,
    predictions?: Prediction[]
  ): Promise<PrefetchResult> {
    const start = Date.now();

    // Rate limit check
    const lastTime = this.lastPrefetchTime.get(sessionId) || 0;
    if (Date.now() - lastTime < RATE_LIMIT_MS) {
      return {
        sessionId,
        predictionsGenerated: 0,
        prefetchedCount: 0,
        skippedCount: 0,
        durationMs: Date.now() - start,
        predictions: [],
      };
    }
    this.lastPrefetchTime.set(sessionId, Date.now());

    // Generate predictions if not provided
    if (!predictions) {
      // We need context — caller should provide predictions or we return empty
      return {
        sessionId,
        predictionsGenerated: 0,
        prefetchedCount: 0,
        skippedCount: 0,
        durationMs: Date.now() - start,
        predictions: [],
      };
    }

    let prefetchedCount = 0;
    let skippedCount = 0;
    const resultDetails: PrefetchResult['predictions'] = [];

    // Process predictions in batches with concurrency limit
    const batches = this.chunk(predictions, MAX_CONCURRENT_PREFETCHES);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (prediction) => {
          try {
            const prefetched = await this.prefetchPrediction(projectName, sessionId, prediction);
            return { prediction, prefetched };
          } catch (error: any) {
            logger.debug('Prefetch failed for prediction', {
              resource: prediction.resource,
              error: error.message,
            });
            return { prediction, prefetched: false };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { prediction, prefetched } = result.value;
          if (prefetched) {
            prefetchedCount++;
          } else {
            skippedCount++;
          }
          resultDetails.push({
            resource: prediction.resource,
            type: prediction.type,
            confidence: prediction.confidence,
            prefetched,
          });
        } else {
          skippedCount++;
        }
      }
    }

    const durationMs = Date.now() - start;
    logger.info('Prefetch completed', {
      sessionId,
      predictions: predictions.length,
      prefetched: prefetchedCount,
      skipped: skippedCount,
      durationMs,
    });

    return {
      sessionId,
      predictionsGenerated: predictions.length,
      prefetchedCount,
      skippedCount,
      durationMs,
      predictions: resultDetails,
    };
  }

  /**
   * Track whether a prediction was actually used (cache hit)
   */
  async trackHit(projectName: string, sessionId: string, resource: string): Promise<void> {
    const statsKey = this.getStatsKey(projectName, sessionId);
    const stats = this.statsCache.get(statsKey) || this.emptyStats();

    stats.totalHits++;
    stats.hitRate = stats.totalPredictions > 0 ? stats.totalHits / stats.totalPredictions : 0;

    this.statsCache.set(statsKey, stats);

    // Also persist to cache for cross-process access
    await cacheService.set(`prediction_stats:${projectName}:${sessionId}`, stats, 3600);
  }

  /**
   * Track a prediction miss
   */
  async trackMiss(projectName: string, sessionId: string, resource: string): Promise<void> {
    const statsKey = this.getStatsKey(projectName, sessionId);
    const stats = this.statsCache.get(statsKey) || this.emptyStats();

    stats.totalMisses++;
    stats.hitRate = stats.totalPredictions > 0 ? stats.totalHits / stats.totalPredictions : 0;

    this.statsCache.set(statsKey, stats);

    await cacheService.set(`prediction_stats:${projectName}:${sessionId}`, stats, 3600);
  }

  /**
   * Get prediction accuracy stats
   */
  async getStats(projectName: string, sessionId?: string): Promise<PredictionStats> {
    if (sessionId) {
      // Try in-memory first
      const statsKey = this.getStatsKey(projectName, sessionId);
      const inMemory = this.statsCache.get(statsKey);
      if (inMemory) return inMemory;

      // Try cache
      const cached = await cacheService.get<PredictionStats>(
        `prediction_stats:${projectName}:${sessionId}`
      );
      if (cached) return cached;

      return this.emptyStats();
    }

    // Aggregate stats across all sessions for project
    const allStats = this.emptyStats();
    for (const [key, stats] of this.statsCache.entries()) {
      if (key.startsWith(`${projectName}:`)) {
        allStats.totalPredictions += stats.totalPredictions;
        allStats.totalHits += stats.totalHits;
        allStats.totalMisses += stats.totalMisses;

        for (const [strategy, strategyStats] of Object.entries(stats.byStrategy)) {
          if (!allStats.byStrategy[strategy]) {
            allStats.byStrategy[strategy] = { predictions: 0, hits: 0, hitRate: 0 };
          }
          allStats.byStrategy[strategy].predictions += strategyStats.predictions;
          allStats.byStrategy[strategy].hits += strategyStats.hits;
        }
      }
    }

    allStats.hitRate =
      allStats.totalPredictions > 0 ? allStats.totalHits / allStats.totalPredictions : 0;

    for (const strategyStats of Object.values(allStats.byStrategy)) {
      strategyStats.hitRate =
        strategyStats.predictions > 0 ? strategyStats.hits / strategyStats.predictions : 0;
    }

    return allStats;
  }

  // ============================================
  // Prediction Strategies
  // ============================================

  /**
   * Strategy 1: Find files related to currently active files via vector similarity
   */
  private async predictFromFiles(
    projectName: string,
    currentFiles: string[]
  ): Promise<Prediction[]> {
    if (currentFiles.length === 0) return [];

    const predictions: Prediction[] = [];
    const collection = `${projectName}_codebase`;

    // Take the most recent files (up to 3) and find similar ones
    const recentFiles = currentFiles.slice(-3);

    for (const file of recentFiles) {
      try {
        const embedding = await embeddingService.embed(file);
        const results = await vectorStore.search(collection, embedding, 5, undefined, 0.5);

        for (const result of results) {
          const resultFile = result.payload.file as string;
          if (resultFile && !currentFiles.includes(resultFile)) {
            predictions.push({
              type: 'file',
              resource: resultFile,
              confidence: Math.min(result.score * 1.1, 1.0), // Boost similarity score slightly
              strategy: 'file_similarity',
              reason: `Similar to ${file}`,
            });
          }
        }
      } catch {
        // Skip files that fail to embed
      }
    }

    return predictions;
  }

  /**
   * Strategy 2: Predict future queries from recent query patterns
   */
  private predictFromQueries(recentQueries: string[]): Prediction[] {
    if (recentQueries.length < 2) return [];

    const predictions: Prediction[] = [];

    // Look for progressive patterns (e.g., exploring related concepts)
    const lastQuery = recentQueries[recentQueries.length - 1];
    const secondLastQuery = recentQueries[recentQueries.length - 2];

    // If recent queries share keywords, predict more queries with those keywords
    const lastWords = new Set(
      lastQuery
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
    const secondLastWords = new Set(
      secondLastQuery
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );

    const sharedKeywords = [...lastWords].filter((w) => secondLastWords.has(w));

    if (sharedKeywords.length > 0) {
      // User is exploring a topic — predict they'll search for related terms
      const topicTerms = sharedKeywords.slice(0, 2).join(' ');
      predictions.push({
        type: 'query',
        resource: topicTerms,
        confidence: 0.7,
        strategy: 'query_pattern',
        reason: `Repeated keywords: ${sharedKeywords.join(', ')}`,
      });
    }

    // Predict re-queries of recent queries (users often refine searches)
    for (const query of recentQueries.slice(-3)) {
      predictions.push({
        type: 'query',
        resource: query,
        confidence: 0.65,
        strategy: 'query_pattern',
        reason: 'Recent query likely to be refined',
      });
    }

    return predictions;
  }

  /**
   * Strategy 3: Predict next tool inputs based on tool chain patterns
   */
  private predictFromToolChain(toolsUsed: string[], recentQueries: string[]): Prediction[] {
    if (toolsUsed.length === 0) return [];

    const predictions: Prediction[] = [];
    const lastTool = toolsUsed[toolsUsed.length - 1];
    const chainEntries = TOOL_CHAIN_MAP[lastTool];

    if (chainEntries && recentQueries.length > 0) {
      const lastQuery = recentQueries[recentQueries.length - 1];

      for (const entry of chainEntries) {
        predictions.push({
          type: 'tool_input',
          resource: lastQuery,
          confidence: 0.75,
          strategy: 'tool_chain',
          reason: `${lastTool} often followed by ${entry.nextTool}`,
        });
      }
    }

    return predictions;
  }

  /**
   * Strategy 4: Predict resources needed for active features
   */
  private predictFromFeatures(projectName: string, activeFeatures: string[]): Prediction[] {
    if (activeFeatures.length === 0) return [];

    const predictions: Prediction[] = [];

    for (const feature of activeFeatures.slice(0, 3)) {
      // Predict that the user will search for this feature
      predictions.push({
        type: 'feature',
        resource: feature,
        confidence: 0.7,
        strategy: 'feature_context',
        reason: `Active feature: ${feature}`,
      });

      // Predict docs/implementation queries
      predictions.push({
        type: 'query',
        resource: `${feature} implementation`,
        confidence: 0.65,
        strategy: 'feature_context',
        reason: `Implementation details for active feature: ${feature}`,
      });
    }

    return predictions;
  }

  // ============================================
  // Prefetch Execution
  // ============================================

  /**
   * Prefetch a single prediction's resources into cache
   */
  private async prefetchPrediction(
    projectName: string,
    sessionId: string,
    prediction: Prediction
  ): Promise<boolean> {
    const cacheOptions = { sessionId, projectName };

    switch (prediction.type) {
      case 'file':
      case 'feature': {
        // Prefetch embedding for the resource (with session caching)
        const embedding = await embeddingService.embedWithSession(
          prediction.resource,
          cacheOptions
        );

        // Also prefetch search results for codebase
        const collection = `${projectName}_codebase`;
        const results = await vectorStore.search(collection, embedding, 5);

        if (results.length > 0) {
          await cacheService.setSessionSearchResults(
            collection,
            prediction.resource,
            results,
            cacheOptions
          );
        }

        // Track prediction
        this.trackPredictionMade(projectName, sessionId, prediction.strategy);
        return true;
      }

      case 'query':
      case 'tool_input': {
        // Prefetch embedding for the query (with session caching)
        const embedding = await embeddingService.embedWithSession(
          prediction.resource,
          cacheOptions
        );

        // Prefetch search results in codebase collection
        const collection = `${projectName}_codebase`;
        const results = await vectorStore.search(collection, embedding, 5);

        if (results.length > 0) {
          await cacheService.setSessionSearchResults(
            collection,
            prediction.resource,
            results,
            cacheOptions
          );
        }

        this.trackPredictionMade(projectName, sessionId, prediction.strategy);
        return true;
      }

      default:
        return false;
    }
  }

  // ============================================
  // Helpers
  // ============================================

  private trackPredictionMade(projectName: string, sessionId: string, strategy: string): void {
    const statsKey = this.getStatsKey(projectName, sessionId);
    const stats = this.statsCache.get(statsKey) || this.emptyStats();

    stats.totalPredictions++;
    if (!stats.byStrategy[strategy]) {
      stats.byStrategy[strategy] = { predictions: 0, hits: 0, hitRate: 0 };
    }
    stats.byStrategy[strategy].predictions++;

    this.statsCache.set(statsKey, stats);
  }

  private getStatsKey(projectName: string, sessionId: string): string {
    return `${projectName}:${sessionId}`;
  }

  private emptyStats(): PredictionStats {
    return {
      totalPredictions: 0,
      totalHits: 0,
      totalMisses: 0,
      hitRate: 0,
      byStrategy: {},
    };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

export const predictiveLoader = new PredictiveLoaderService();
export default predictiveLoader;
