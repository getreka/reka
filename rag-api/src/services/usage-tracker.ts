/**
 * Usage Tracker Service - Track MCP tool invocations for analytics
 *
 * Tracks:
 * - Tool name, timestamp, duration
 * - Query/input summary
 * - Result count, success/error
 * - Session ID
 * - Patterns and trends
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { logger } from '../utils/logger';

export interface ToolUsage {
  id: string;
  projectName: string;
  sessionId: string;
  toolName: string;
  timestamp: string;
  durationMs: number;
  inputSummary: string;
  resultCount: number;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageStats {
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: { tool: string; count: number }[];
  callsByHour: Record<number, number>;
  errorsByTool: Record<string, number>;
}

export interface TrackOptions {
  projectName: string;
  sessionId?: string;
  toolName: string;
  inputSummary: string;
  startTime: number;
  resultCount?: number;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

class UsageTrackerService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_tool_usage`;
  }

  /**
   * Track a tool invocation
   */
  async track(options: TrackOptions): Promise<ToolUsage> {
    const {
      projectName,
      sessionId = 'unknown',
      toolName,
      inputSummary,
      startTime,
      resultCount = 0,
      success,
      errorMessage,
      metadata,
    } = options;

    const collectionName = this.getCollectionName(projectName);
    const now = Date.now();

    const usage: ToolUsage = {
      id: uuidv4(),
      projectName,
      sessionId,
      toolName,
      timestamp: new Date().toISOString(),
      durationMs: now - startTime,
      inputSummary: inputSummary.slice(0, 500), // Limit size
      resultCount,
      success,
      errorMessage,
      metadata,
    };

    try {
      // Create embedding from tool+input for pattern analysis
      const embeddingText = `${toolName}: ${inputSummary}`;
      const embedding = await embeddingService.embed(embeddingText);

      const point: VectorPoint = {
        id: usage.id,
        vector: embedding,
        payload: {
          ...usage,
          timestampMs: Date.now(),
          hour: new Date().getHours(),
          dayOfWeek: new Date().getDay(),
        },
      };

      await vectorStore.upsert(collectionName, [point]);
      logger.debug(`Tracked tool usage: ${toolName}`, { durationMs: usage.durationMs, success });
    } catch (error: any) {
      // Don't fail the main operation if tracking fails
      logger.warn('Failed to track tool usage', { error: error.message });
    }

    return usage;
  }

  /**
   * Get usage statistics for a project
   */
  async getStats(projectName: string, days: number = 7): Promise<UsageStats> {
    const collectionName = this.getCollectionName(projectName);
    const cutoffMs = Date.now() - days * 86400000;

    try {
      // Get all usage records (limited to recent)
      const usages: ToolUsage[] = [];
      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              {
                key: 'timestampMs',
                range: { gte: cutoffMs },
              },
            ],
          },
        });

        for (const point of response.points) {
          usages.push(point.payload as unknown as ToolUsage);
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && usages.length < 10000);

      // Calculate stats
      const totalCalls = usages.length;
      const successCount = usages.filter((u) => u.success).length;
      const successRate = totalCalls > 0 ? successCount / totalCalls : 0;
      const avgDurationMs =
        totalCalls > 0 ? usages.reduce((sum, u) => sum + u.durationMs, 0) / totalCalls : 0;

      // Top tools
      const toolCounts: Record<string, number> = {};
      const errorsByTool: Record<string, number> = {};
      const callsByHour: Record<number, number> = {};

      for (const usage of usages) {
        toolCounts[usage.toolName] = (toolCounts[usage.toolName] || 0) + 1;
        if (!usage.success) {
          errorsByTool[usage.toolName] = (errorsByTool[usage.toolName] || 0) + 1;
        }
        const hour = new Date(usage.timestamp).getHours();
        callsByHour[hour] = (callsByHour[hour] || 0) + 1;
      }

      const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tool, count]) => ({ tool, count }));

      return {
        totalCalls,
        successRate,
        avgDurationMs,
        topTools,
        callsByHour,
        errorsByTool,
      };
    } catch (error: any) {
      if (error.status === 404) {
        return {
          totalCalls: 0,
          successRate: 0,
          avgDurationMs: 0,
          topTools: [],
          callsByHour: {},
          errorsByTool: {},
        };
      }
      throw error;
    }
  }

  /**
   * Find similar queries (for pattern analysis)
   */
  async findSimilarQueries(
    projectName: string,
    query: string,
    limit: number = 5
  ): Promise<{ usage: ToolUsage; score: number }[]> {
    const collectionName = this.getCollectionName(projectName);

    try {
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(collectionName, embedding, limit);

      return results.map((r) => ({
        usage: r.payload as unknown as ToolUsage,
        score: r.score,
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Analyze user behavior patterns from tool usage data
   */
  async getBehaviorPatterns(
    projectName: string,
    options: {
      days?: number;
      sessionId?: string;
    } = {}
  ): Promise<{
    peakHours: Array<{ hour: number; count: number }>;
    toolPreferences: Array<{ tool: string; count: number; avgDuration: number }>;
    workflows: Array<{ sequence: string[]; count: number }>;
    sessionStats: { totalSessions: number; avgToolsPerSession: number; avgDurationMinutes: number };
  }> {
    const { days = 7, sessionId } = options;
    const collectionName = this.getCollectionName(projectName);
    const cutoffMs = Date.now() - days * 86400000;

    const result = {
      peakHours: [] as Array<{ hour: number; count: number }>,
      toolPreferences: [] as Array<{ tool: string; count: number; avgDuration: number }>,
      workflows: [] as Array<{ sequence: string[]; count: number }>,
      sessionStats: { totalSessions: 0, avgToolsPerSession: 0, avgDurationMinutes: 0 },
    };

    try {
      // Scroll all usage records in time range
      const usages: ToolUsage[] = [];
      let offset: string | number | undefined = undefined;
      const mustConditions: Record<string, unknown>[] = [
        { key: 'timestampMs', range: { gte: cutoffMs } },
      ];
      if (sessionId) {
        mustConditions.push({ key: 'sessionId', match: { value: sessionId } });
      }

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
          filter: { must: mustConditions },
        });

        for (const point of response.points) {
          usages.push(point.payload as unknown as ToolUsage);
        }

        offset = response.next_page_offset as string | number | undefined;
      } while (offset && usages.length < 10000);

      if (usages.length === 0) return result;

      // Peak hours
      const hourCounts: Record<number, number> = {};
      for (const u of usages) {
        const hour = new Date(u.timestamp).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
      result.peakHours = Object.entries(hourCounts)
        .map(([h, c]) => ({ hour: parseInt(h), count: c }))
        .sort((a, b) => b.count - a.count);

      // Tool preferences with avg duration
      const toolStats = new Map<string, { count: number; totalDuration: number }>();
      for (const u of usages) {
        const existing = toolStats.get(u.toolName) || { count: 0, totalDuration: 0 };
        existing.count++;
        existing.totalDuration += u.durationMs;
        toolStats.set(u.toolName, existing);
      }
      result.toolPreferences = Array.from(toolStats.entries())
        .map(([tool, stats]) => ({
          tool,
          count: stats.count,
          avgDuration: Math.round(stats.totalDuration / stats.count),
        }))
        .sort((a, b) => b.count - a.count);

      // Group by session to find workflows (tool sequences)
      const sessions = new Map<string, ToolUsage[]>();
      for (const u of usages) {
        const sid = u.sessionId || 'unknown';
        if (!sessions.has(sid)) sessions.set(sid, []);
        sessions.get(sid)!.push(u);
      }

      // Sort each session by timestamp
      for (const [, sessionUsages] of sessions) {
        sessionUsages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      }

      // Extract 2-gram and 3-gram tool sequences
      const ngramCounts = new Map<string, { sequence: string[]; count: number }>();
      for (const [, sessionUsages] of sessions) {
        const tools = sessionUsages.map((u) => u.toolName);
        for (let n = 2; n <= 3; n++) {
          for (let i = 0; i <= tools.length - n; i++) {
            const ngram = tools.slice(i, i + n);
            const key = ngram.join(' -> ');
            const existing = ngramCounts.get(key) || { sequence: ngram, count: 0 };
            existing.count++;
            ngramCounts.set(key, existing);
          }
        }
      }

      result.workflows = Array.from(ngramCounts.values())
        .filter((w) => w.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      // Session stats
      result.sessionStats.totalSessions = sessions.size;
      const sessionSizes = Array.from(sessions.values()).map((s) => s.length);
      result.sessionStats.avgToolsPerSession =
        sessionSizes.length > 0
          ? Math.round(sessionSizes.reduce((a, b) => a + b, 0) / sessionSizes.length)
          : 0;

      const sessionDurations = Array.from(sessions.values()).map((s) => {
        if (s.length < 2) return 0;
        const first = new Date(s[0].timestamp).getTime();
        const last = new Date(s[s.length - 1].timestamp).getTime();
        return (last - first) / 60000; // minutes
      });
      result.sessionStats.avgDurationMinutes =
        sessionDurations.length > 0
          ? Math.round(sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length)
          : 0;

      return result;
    } catch (error: any) {
      if (error.status === 404) {
        return result;
      }
      throw error;
    }
  }

  /**
   * Get knowledge gaps (queries with no/low results)
   */
  async getKnowledgeGaps(
    projectName: string,
    limit: number = 20
  ): Promise<
    {
      query: string;
      toolName: string;
      count: number;
      avgResultCount: number;
    }[]
  > {
    const collectionName = this.getCollectionName(projectName);
    const gaps: Map<string, { toolName: string; count: number; totalResults: number }> = new Map();

    try {
      let offset: string | number | undefined = undefined;
      let scanned = 0;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: 'resultCount', range: { lte: 2 } },
              { key: 'success', match: { value: true } },
            ],
          },
        });

        for (const point of response.points) {
          const usage = point.payload as unknown as ToolUsage;
          const key = usage.inputSummary.slice(0, 100);
          const existing = gaps.get(key) || { toolName: usage.toolName, count: 0, totalResults: 0 };
          existing.count++;
          existing.totalResults += usage.resultCount;
          gaps.set(key, existing);
        }

        scanned += response.points.length;
        offset = response.next_page_offset as string | number | undefined;
      } while (offset && scanned < 5000);

      return Array.from(gaps.entries())
        .filter(([_, data]) => data.count >= 2) // At least 2 occurrences
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([query, data]) => ({
          query,
          toolName: data.toolName,
          count: data.count,
          avgResultCount: data.totalResults / data.count,
        }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }
}

export const usageTracker = new UsageTrackerService();
export default usageTracker;
