/**
 * Cache Management Tools
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

export function createCacheTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "get_cache_stats",
      description: `Get cache statistics for ${projectName}. Shows hit rates, cache levels, and memory usage.`,
      schema: z.object({
        sessionId: z
          .string()
          .optional()
          .describe("Optional session ID for session-specific stats"),
      }),
      annotations: TOOL_ANNOTATIONS["get_cache_stats"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId } = args as { sessionId?: string };

        if (sessionId) {
          const response = await ctx.api.get(`/api/cache/session/${sessionId}`);
          const stats = response.data;

          let result = `# 📊 Cache Stats for Session\n\n`;
          result += `**Session ID**: ${sessionId}\n\n`;
          result += `## Hit Rates\n`;
          result += `- **Total Hits**: ${stats.hits}\n`;
          result += `- **Misses**: ${stats.misses}\n`;
          result += `- **Hit Rate**: ${(stats.hitRate * 100).toFixed(1)}%\n\n`;
          result += `## Cache Level Distribution\n`;
          result += `- **L1 (Session)**: ${stats.l1Hits} hits\n`;
          result += `- **L2 (Project)**: ${stats.l2Hits} hits\n`;
          result += `- **L3 (Global)**: ${stats.l3Hits} hits\n`;
          return result;
        }

        const response = await ctx.api.get("/api/cache/analytics");
        const analytics = response.data;

        let result = `# 📊 Global Cache Analytics\n\n`;
        result += `**Status**: ${analytics.enabled ? (analytics.connected ? "🟢 Connected" : "🟡 Disconnected") : "🔴 Disabled"}\n\n`;

        if (analytics.connected) {
          result += `## Keys\n`;
          result += `- **Total**: ${analytics.totalKeys?.toLocaleString() || "N/A"}\n`;
          result += `- **Embeddings**: ${analytics.embeddingKeys?.toLocaleString() || "N/A"}\n`;
          result += `- **Search**: ${analytics.searchKeys?.toLocaleString() || "N/A"}\n`;
          result += `- **Sessions**: ${analytics.sessionKeys?.toLocaleString() || "N/A"}\n\n`;
          result += `## Memory\n`;
          result += `- **Used**: ${analytics.memoryUsage || "N/A"}\n`;
        }

        return result;
      },
    },
    {
      name: "warm_cache",
      description: `Warm the embedding cache for ${projectName}. Pre-loads frequently used embeddings for faster responses.`,
      schema: z.object({
        sessionId: z.string().describe("Session ID to warm cache for"),
        previousSessionId: z
          .string()
          .optional()
          .describe(
            "Previous session to copy cache from (for session resumption)",
          ),
        recentQueries: z
          .array(z.string())
          .optional()
          .describe("Recent queries to pre-warm in cache"),
      }),
      annotations: TOOL_ANNOTATIONS["warm_cache"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId, previousSessionId, recentQueries } = args as {
          sessionId: string;
          previousSessionId?: string;
          recentQueries?: string[];
        };

        const response = await ctx.api.post("/api/cache/warm", {
          sessionId,
          previousSessionId,
          recentQueries,
        });

        const { warmedCount } = response.data;

        let result = `🔥 **Cache Warmed**\n\n`;
        result += `- **Session ID**: ${sessionId}\n`;
        result += `- **Pre-loaded**: ${warmedCount} embeddings\n`;
        if (previousSessionId) {
          result += `- **Resumed from**: ${previousSessionId}\n`;
        }
        if (recentQueries && recentQueries.length > 0) {
          result += `- **Queries warmed**: ${recentQueries.length}\n`;
        }
        result += `\nThe session cache is now primed for faster responses!`;
        return result;
      },
    },
  ];
}
