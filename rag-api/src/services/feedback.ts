/**
 * Feedback Service - Collect and analyze feedback for continuous improvement
 *
 * Features:
 * - Search result feedback (helpful/not helpful)
 * - Memory accuracy feedback (accurate/outdated/incorrect)
 * - Feedback analytics and trends
 * - Learning from feedback patterns
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { logger } from '../utils/logger';

export type SearchFeedbackType = 'helpful' | 'not_helpful' | 'partially_helpful';
export type MemoryFeedbackType = 'accurate' | 'outdated' | 'incorrect';

export interface SearchFeedback {
  id: string;
  projectName: string;
  queryId: string;
  query: string;
  resultId: string;
  resultFile?: string;
  feedbackType: SearchFeedbackType;
  betterQuery?: string;
  comment?: string;
  timestamp: string;
  sessionId?: string;
}

export interface MemoryFeedback {
  id: string;
  projectName: string;
  memoryId: string;
  memoryContent: string;
  feedbackType: MemoryFeedbackType;
  correction?: string;
  comment?: string;
  timestamp: string;
  sessionId?: string;
}

export interface FeedbackStats {
  totalSearchFeedback: number;
  searchHelpfulRate: number;
  totalMemoryFeedback: number;
  memoryAccuracyRate: number;
  recentTrend: 'improving' | 'stable' | 'declining';
  topIssues: Array<{ type: string; count: number }>;
}

export interface QualityMetrics {
  searchQuality: {
    helpfulRate: number;
    partiallyHelpfulRate: number;
    notHelpfulRate: number;
    totalFeedback: number;
  };
  memoryQuality: {
    accuracyRate: number;
    outdatedRate: number;
    incorrectRate: number;
    totalFeedback: number;
  };
  trends: {
    last7Days: number;
    last30Days: number;
    trend: 'up' | 'down' | 'stable';
  };
  topProblematicQueries: Array<{ query: string; notHelpfulCount: number }>;
}

class FeedbackService {
  private getSearchFeedbackCollection(projectName: string): string {
    return `${projectName}_search_feedback`;
  }

  private getMemoryFeedbackCollection(projectName: string): string {
    return `${projectName}_memory_feedback`;
  }

  /**
   * Submit feedback for a search result
   */
  async submitSearchFeedback(options: {
    projectName: string;
    queryId: string;
    query: string;
    resultId: string;
    resultFile?: string;
    feedbackType: SearchFeedbackType;
    betterQuery?: string;
    comment?: string;
    sessionId?: string;
  }): Promise<SearchFeedback> {
    const {
      projectName,
      queryId,
      query,
      resultId,
      resultFile,
      feedbackType,
      betterQuery,
      comment,
      sessionId,
    } = options;

    const collection = this.getSearchFeedbackCollection(projectName);

    const feedback: SearchFeedback = {
      id: uuidv4(),
      projectName,
      queryId,
      query,
      resultId,
      resultFile,
      feedbackType,
      betterQuery,
      comment,
      timestamp: new Date().toISOString(),
      sessionId,
    };

    try {
      // Create embedding from query for similarity search
      const embedding = await embeddingService.embed(
        `${query} ${feedbackType} ${betterQuery || ''}`
      );

      const point: VectorPoint = {
        id: feedback.id,
        vector: embedding,
        payload: feedback as unknown as Record<string, unknown>,
      };

      await vectorStore.upsert(collection, [point]);
      logger.info(`Search feedback submitted: ${feedbackType}`, { queryId, resultId });

      return feedback;
    } catch (error: any) {
      logger.error('Failed to submit search feedback', { error: error.message });
      throw error;
    }
  }

  /**
   * Submit feedback for a memory
   */
  async submitMemoryFeedback(options: {
    projectName: string;
    memoryId: string;
    memoryContent: string;
    feedbackType: MemoryFeedbackType;
    correction?: string;
    comment?: string;
    sessionId?: string;
  }): Promise<MemoryFeedback> {
    const { projectName, memoryId, memoryContent, feedbackType, correction, comment, sessionId } =
      options;

    const collection = this.getMemoryFeedbackCollection(projectName);

    const feedback: MemoryFeedback = {
      id: uuidv4(),
      projectName,
      memoryId,
      memoryContent,
      feedbackType,
      correction,
      comment,
      timestamp: new Date().toISOString(),
      sessionId,
    };

    try {
      const embedding = await embeddingService.embed(
        `${memoryContent} ${feedbackType} ${correction || ''}`
      );

      const point: VectorPoint = {
        id: feedback.id,
        vector: embedding,
        payload: feedback as unknown as Record<string, unknown>,
      };

      await vectorStore.upsert(collection, [point]);
      logger.info(`Memory feedback submitted: ${feedbackType}`, { memoryId });

      return feedback;
    } catch (error: any) {
      logger.error('Failed to submit memory feedback', { error: error.message });
      throw error;
    }
  }

  /**
   * Get feedback statistics for a project
   */
  async getStats(projectName: string, days: number = 30): Promise<FeedbackStats> {
    const searchCollection = this.getSearchFeedbackCollection(projectName);
    const memoryCollection = this.getMemoryFeedbackCollection(projectName);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let totalSearchFeedback = 0;
    let helpfulCount = 0;
    let totalMemoryFeedback = 0;
    let accurateCount = 0;
    const issues: Record<string, number> = {};

    try {
      // Get search feedback
      const searchFeedback = await this.scrollFeedback(searchCollection, cutoffDate);
      totalSearchFeedback = searchFeedback.length;
      helpfulCount = searchFeedback.filter((f) => f.feedbackType === 'helpful').length;

      for (const f of searchFeedback) {
        if (f.feedbackType === 'not_helpful') {
          issues['search_not_helpful'] = (issues['search_not_helpful'] || 0) + 1;
        }
      }

      // Get memory feedback
      const memoryFeedback = await this.scrollFeedback(memoryCollection, cutoffDate);
      totalMemoryFeedback = memoryFeedback.length;
      accurateCount = memoryFeedback.filter((f) => f.feedbackType === 'accurate').length;

      for (const f of memoryFeedback) {
        if (f.feedbackType === 'outdated') {
          issues['memory_outdated'] = (issues['memory_outdated'] || 0) + 1;
        }
        if (f.feedbackType === 'incorrect') {
          issues['memory_incorrect'] = (issues['memory_incorrect'] || 0) + 1;
        }
      }

      // Calculate trend (compare last 7 days to previous 7 days)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 7);
      const recentSearch = searchFeedback.filter((f) => new Date(f.timestamp) >= recentDate);
      const recentHelpful = recentSearch.filter((f) => f.feedbackType === 'helpful').length;
      const recentRate = recentSearch.length > 0 ? recentHelpful / recentSearch.length : 0;
      const overallRate = totalSearchFeedback > 0 ? helpfulCount / totalSearchFeedback : 0;

      let trend: 'improving' | 'stable' | 'declining' = 'stable';
      if (recentRate > overallRate + 0.1) trend = 'improving';
      else if (recentRate < overallRate - 0.1) trend = 'declining';

      return {
        totalSearchFeedback,
        searchHelpfulRate: totalSearchFeedback > 0 ? helpfulCount / totalSearchFeedback : 0,
        totalMemoryFeedback,
        memoryAccuracyRate: totalMemoryFeedback > 0 ? accurateCount / totalMemoryFeedback : 0,
        recentTrend: trend,
        topIssues: Object.entries(issues)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([type, count]) => ({ type, count })),
      };
    } catch (error: any) {
      logger.error('Failed to get feedback stats', { error: error.message });
      return {
        totalSearchFeedback: 0,
        searchHelpfulRate: 0,
        totalMemoryFeedback: 0,
        memoryAccuracyRate: 0,
        recentTrend: 'stable',
        topIssues: [],
      };
    }
  }

  /**
   * Get detailed quality metrics
   */
  async getQualityMetrics(projectName: string): Promise<QualityMetrics> {
    const searchCollection = this.getSearchFeedbackCollection(projectName);
    const memoryCollection = this.getMemoryFeedbackCollection(projectName);

    const now = new Date();
    const date7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const date30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    try {
      // Get all search feedback (last 90 days)
      const date90Days = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const searchFeedback = await this.scrollFeedback(searchCollection, date90Days);
      const memoryFeedback = await this.scrollFeedback(memoryCollection, date90Days);

      // Search quality metrics
      const helpful = searchFeedback.filter((f) => f.feedbackType === 'helpful').length;
      const partial = searchFeedback.filter((f) => f.feedbackType === 'partially_helpful').length;
      const notHelpful = searchFeedback.filter((f) => f.feedbackType === 'not_helpful').length;
      const totalSearch = searchFeedback.length;

      // Memory quality metrics
      const accurate = memoryFeedback.filter((f) => f.feedbackType === 'accurate').length;
      const outdated = memoryFeedback.filter((f) => f.feedbackType === 'outdated').length;
      const incorrect = memoryFeedback.filter((f) => f.feedbackType === 'incorrect').length;
      const totalMemory = memoryFeedback.length;

      // Trends
      const last7 = searchFeedback.filter((f) => new Date(f.timestamp) >= date7Days).length;
      const last30 = searchFeedback.filter((f) => new Date(f.timestamp) >= date30Days).length;

      const rate7 =
        last7 > 0
          ? searchFeedback.filter(
              (f) => new Date(f.timestamp) >= date7Days && f.feedbackType === 'helpful'
            ).length / last7
          : 0;
      const rate30 =
        last30 > 0
          ? searchFeedback.filter(
              (f) => new Date(f.timestamp) >= date30Days && f.feedbackType === 'helpful'
            ).length / last30
          : 0;

      // Top problematic queries
      const queryIssues: Record<string, number> = {};
      for (const f of searchFeedback) {
        if (f.feedbackType === 'not_helpful' && f.query) {
          const key = f.query.slice(0, 50);
          queryIssues[key] = (queryIssues[key] || 0) + 1;
        }
      }

      return {
        searchQuality: {
          helpfulRate: totalSearch > 0 ? helpful / totalSearch : 0,
          partiallyHelpfulRate: totalSearch > 0 ? partial / totalSearch : 0,
          notHelpfulRate: totalSearch > 0 ? notHelpful / totalSearch : 0,
          totalFeedback: totalSearch,
        },
        memoryQuality: {
          accuracyRate: totalMemory > 0 ? accurate / totalMemory : 0,
          outdatedRate: totalMemory > 0 ? outdated / totalMemory : 0,
          incorrectRate: totalMemory > 0 ? incorrect / totalMemory : 0,
          totalFeedback: totalMemory,
        },
        trends: {
          last7Days: last7,
          last30Days: last30,
          trend: rate7 > rate30 + 0.05 ? 'up' : rate7 < rate30 - 0.05 ? 'down' : 'stable',
        },
        topProblematicQueries: Object.entries(queryIssues)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([query, notHelpfulCount]) => ({ query, notHelpfulCount })),
      };
    } catch (error: any) {
      logger.error('Failed to get quality metrics', { error: error.message });
      return {
        searchQuality: {
          helpfulRate: 0,
          partiallyHelpfulRate: 0,
          notHelpfulRate: 0,
          totalFeedback: 0,
        },
        memoryQuality: { accuracyRate: 0, outdatedRate: 0, incorrectRate: 0, totalFeedback: 0 },
        trends: { last7Days: 0, last30Days: 0, trend: 'stable' },
        topProblematicQueries: [],
      };
    }
  }

  /**
   * Get suggested better queries based on feedback
   */
  async getSuggestedQueries(
    projectName: string,
    query: string,
    limit: number = 5
  ): Promise<Array<{ betterQuery: string; score: number }>> {
    const collection = this.getSearchFeedbackCollection(projectName);

    try {
      // Find similar queries that have better alternatives
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(collection, embedding, limit * 2, {
        must: [{ key: 'feedbackType', match: { value: 'not_helpful' } }],
      });

      const suggestions: Array<{ betterQuery: string; score: number }> = [];
      for (const r of results) {
        const feedback = r.payload as unknown as SearchFeedback;
        if (feedback.betterQuery && feedback.betterQuery !== query) {
          suggestions.push({
            betterQuery: feedback.betterQuery,
            score: r.score,
          });
        }
      }

      return suggestions.slice(0, limit);
    } catch (error: any) {
      logger.error('Failed to get suggested queries', { error: error.message });
      return [];
    }
  }

  /**
   * Get feedback-based score adjustments for search results.
   * Returns a map of filePath → boost multiplier (>1 = boost, <1 = penalty).
   */
  async getFileBoostScores(projectName: string, query: string): Promise<Map<string, number>> {
    const collection = this.getSearchFeedbackCollection(projectName);
    const boosts = new Map<string, number>();

    try {
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(collection, embedding, 50, undefined, 0.5);

      // Group feedback by file
      const fileStats: Record<string, { helpful: number; notHelpful: number }> = {};
      for (const r of results) {
        const feedback = r.payload as unknown as SearchFeedback;
        const file = feedback.resultFile;
        if (!file) continue;

        if (!fileStats[file]) fileStats[file] = { helpful: 0, notHelpful: 0 };
        if (feedback.feedbackType === 'helpful') fileStats[file].helpful++;
        else if (feedback.feedbackType === 'not_helpful') fileStats[file].notHelpful++;
      }

      // Calculate boost multipliers
      for (const [file, stats] of Object.entries(fileStats)) {
        const total = stats.helpful + stats.notHelpful;
        if (total === 0) continue;

        // Boost helpful files by up to 20%, penalize not_helpful by up to 15%
        const ratio = (stats.helpful - stats.notHelpful) / total;
        boosts.set(file, 1 + ratio * 0.2);
      }

      return boosts;
    } catch (error: any) {
      if (error.status === 404) return boosts;
      logger.error('Failed to get file boost scores', { error: error.message });
      return boosts;
    }
  }

  /**
   * Get memory IDs grouped by feedback type.
   * Used by auto-promote (accurate) and auto-prune (incorrect).
   */
  async getMemoryFeedbackCounts(
    projectName: string
  ): Promise<Map<string, { accurate: number; outdated: number; incorrect: number }>> {
    const collection = this.getMemoryFeedbackCollection(projectName);
    const counts = new Map<string, { accurate: number; outdated: number; incorrect: number }>();

    try {
      const feedback = await this.scrollFeedback(collection, new Date(0));

      for (const f of feedback) {
        const payload = f as unknown as MemoryFeedback;
        const memoryId = payload.memoryId;
        if (!memoryId) continue;

        if (!counts.has(memoryId)) {
          counts.set(memoryId, { accurate: 0, outdated: 0, incorrect: 0 });
        }
        const stats = counts.get(memoryId)!;
        if (payload.feedbackType === 'accurate') stats.accurate++;
        else if (payload.feedbackType === 'outdated') stats.outdated++;
        else if (payload.feedbackType === 'incorrect') stats.incorrect++;
      }

      return counts;
    } catch (error: any) {
      if (error.status === 404) return counts;
      logger.error('Failed to get memory feedback counts', { error: error.message });
      return counts;
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async scrollFeedback(
    collection: string,
    cutoffDate: Date
  ): Promise<Array<{ feedbackType: string; timestamp: string; query?: string }>> {
    const feedback: Array<{ feedbackType: string; timestamp: string; query?: string }> = [];

    try {
      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collection, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              {
                key: 'timestamp',
                range: { gte: cutoffDate.toISOString() },
              },
            ],
          },
        });

        for (const point of response.points) {
          feedback.push(point.payload as any);
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && feedback.length < 10000);

      return feedback;
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }
}

export const feedbackService = new FeedbackService();
export default feedbackService;
