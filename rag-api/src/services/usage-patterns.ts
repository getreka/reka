/**
 * Usage Pattern Service - Developer profile from tool usage data
 *
 * Simplified: analyzePatterns/summarizeContext/summarizeChanges removed (0 calls in audit).
 * Only buildDeveloperProfile retained (used by session-context auto-continuity).
 */

import { vectorStore } from './vector-store';
import { ToolUsage } from './usage-tracker';
import { logger } from '../utils/logger';

export interface DeveloperProfile {
  projectName: string;
  frequentFiles: { file: string; count: number }[];
  preferredTools: { tool: string; count: number; avgDurationMs: number }[];
  peakHours: { hour: number; count: number }[];
  commonPatterns: string[];
  totalSessions: number;
  totalToolCalls: number;
  lastActive: string;
  updatedAt: string;
}

class UsagePatternService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_tool_usage`;
  }

  /**
   * Stubs for route compatibility (return empty data).
   */
  async analyzePatterns(_projectName: string, _days: number = 7) {
    return { patterns: [], workflows: [], insights: [], recommendations: [] };
  }

  async summarizeContext(_projectName: string, _sessionId?: string) {
    return { recentTools: [], recentQueries: [], activeFeatures: [], suggestedNextSteps: [] };
  }

  async summarizeChanges(_projectName: string, _sessionId: string, _options: { includeCode?: boolean } = {}) {
    return { summary: 'Summarization disabled', toolsUsed: [], filesAffected: [], keyActions: [], duration: 0 };
  }

  /**
   * Build an aggregated developer profile from 30 days of usage data.
   * Returns persistent preferences: frequent files, preferred tools, peak hours.
   */
  async buildDeveloperProfile(projectName: string): Promise<DeveloperProfile> {
    const collectionName = this.getCollectionName(projectName);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const profile: DeveloperProfile = {
      projectName,
      frequentFiles: [],
      preferredTools: [],
      peakHours: [],
      commonPatterns: [],
      totalSessions: 0,
      totalToolCalls: 0,
      lastActive: '',
      updatedAt: new Date().toISOString(),
    };

    try {
      const usages: ToolUsage[] = [];
      let offset: string | number | undefined = undefined;

      do {
        const response = await vectorStore['client'].scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [{
              key: 'timestamp',
              range: { gte: cutoff.toISOString() },
            }],
          },
        });

        for (const point of response.points) {
          usages.push(point.payload as unknown as ToolUsage);
        }
        offset = response.next_page_offset as string | number | undefined;
      } while (offset && usages.length < 5000);

      if (usages.length === 0) return profile;

      profile.totalToolCalls = usages.length;
      profile.totalSessions = new Set(usages.map(u => u.sessionId).filter(Boolean)).size;
      profile.lastActive = usages
        .map(u => u.timestamp)
        .sort()
        .pop() || '';

      // Frequent files from metadata
      const fileCounts = new Map<string, number>();
      for (const u of usages) {
        const file = u.metadata?.file as string;
        if (file) fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
        const files = u.metadata?.files as string[];
        if (files) {
          for (const f of files) fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
        }
      }
      profile.frequentFiles = [...fileCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([file, count]) => ({ file, count }));

      // Preferred tools
      const toolStats = new Map<string, { count: number; totalDuration: number }>();
      for (const u of usages) {
        const s = toolStats.get(u.toolName) || { count: 0, totalDuration: 0 };
        s.count++;
        s.totalDuration += u.durationMs;
        toolStats.set(u.toolName, s);
      }
      profile.preferredTools = [...toolStats.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 15)
        .map(([tool, s]) => ({ tool, count: s.count, avgDurationMs: Math.round(s.totalDuration / s.count) }));

      // Peak hours
      const hourCounts = new Map<number, number>();
      for (const u of usages) {
        const hour = new Date(u.timestamp).getHours();
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      }
      profile.peakHours = [...hourCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hour, count]) => ({ hour, count }));

      // Common patterns from repeated query prefixes
      const queryCounts = new Map<string, number>();
      for (const u of usages) {
        if (u.inputSummary) {
          const key = u.inputSummary.toLowerCase().trim().slice(0, 60);
          queryCounts.set(key, (queryCounts.get(key) || 0) + 1);
        }
      }
      profile.commonPatterns = [...queryCounts.entries()]
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([query]) => query);

      return profile;
    } catch (error: any) {
      if (error.status === 404) return profile;
      logger.error('Failed to build developer profile', { error: error.message });
      return profile;
    }
  }
}

export const usagePatterns = new UsagePatternService();
export default usagePatterns;
