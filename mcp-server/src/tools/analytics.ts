/**
 * Analytics tools module - tool analytics, knowledge gaps, collection analytics,
 * and platform stats.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { pct } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the analytics tools module with project-specific descriptions.
 */
export function createAnalyticsTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "get_tool_analytics",
      description: `Get tool usage analytics for ${projectName}. Shows call counts, success rates, and performance.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_tool_analytics"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const response = await ctx.api.get("/api/tool-analytics");
        const data = response.data;

        let result = `## Tool Analytics\n\n`;
        result += `- **Total Calls:** ${data.totalCalls ?? "N/A"}\n`;
        result += `- **Success Rate:** ${data.successRate !== undefined ? pct(data.successRate) : "N/A"}\n`;
        result += `- **Avg Duration:** ${data.avgDurationMs ? data.avgDurationMs + "ms" : "N/A"}\n\n`;

        if (data.topTools && data.topTools.length > 0) {
          result += `### Top Tools\n`;
          for (const t of data.topTools) {
            result += `- **${t.tool || t.name}**: ${t.count ?? t.calls} calls`;
            if (t.avgDurationMs || t.avgDuration)
              result += ` (avg ${t.avgDurationMs || t.avgDuration}ms)`;
            result += "\n";
          }
          result += "\n";
        }

        if (data.errorsByTool && Object.keys(data.errorsByTool).length > 0) {
          result += `### Errors by Tool\n`;
          for (const [tool, count] of Object.entries(data.errorsByTool)) {
            result += `- **${tool}**: ${count} errors\n`;
          }
        }

        return result;
      },
    },
    {
      name: "get_knowledge_gaps",
      description: `Get knowledge gaps for ${projectName}. Shows queries that returned few or no results.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_knowledge_gaps"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const response = await ctx.api.get("/api/knowledge-gaps");
        const data = response.data;
        const queries = data.queries || data.gaps || data;

        if (!queries || (Array.isArray(queries) && queries.length === 0)) {
          return "No knowledge gaps identified.";
        }

        let result = `## Knowledge Gaps\n\n`;
        result += `Queries with low or no results:\n\n`;
        for (const q of Array.isArray(queries) ? queries : []) {
          result += `- **"${q.query}"**`;
          if (q.count) result += ` (${q.count} times)`;
          if (q.avgResultCount !== undefined)
            result += ` - avg results: ${q.avgResultCount}`;
          if (q.toolName) result += ` [${q.toolName}]`;
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "get_analytics",
      description: `Get detailed analytics for a ${projectName} collection. Shows vectors, storage, language breakdown, and more.`,
      schema: z.object({
        collectionName: z
          .string()
          .describe(
            "Collection name to get analytics for (e.g., 'codebase', 'docs', 'memory')",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["get_analytics"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { collectionName } = args as { collectionName: string };
        const fullName = collectionName.startsWith(ctx.collectionPrefix)
          ? collectionName
          : `${ctx.collectionPrefix}${collectionName}`;
        const response = await ctx.api.get(`/api/analytics/${fullName}`);
        const data = response.data;

        let result = `## Collection Analytics: ${collectionName}\n\n`;
        result += `- **Vectors:** ${data.vectorCount ?? data.vectors ?? "N/A"}\n`;
        result += `- **Files:** ${data.totalFiles ?? data.files ?? "N/A"}\n`;
        result += `- **Segments:** ${data.segments ?? "N/A"}\n`;
        result += `- **Optimizer:** ${data.optimizerStatus || data.optimizer || "N/A"}\n`;
        result += `- **Quantization:** ${data.quantization || "none"}\n`;
        result += `- **RAM Usage:** ${data.ramUsage || "N/A"}\n`;
        result += `- **Disk Usage:** ${data.diskUsage || "N/A"}\n`;

        if (data.languages && Object.keys(data.languages).length > 0) {
          result += `\n### Language Breakdown\n`;
          for (const [lang, count] of Object.entries(data.languages)) {
            result += `- ${lang}: ${count} files\n`;
          }
        }

        result += `\n- **Last Indexed:** ${data.lastIndexed ? new Date(data.lastIndexed).toLocaleString() : "Never"}\n`;

        return result;
      },
    },
    {
      name: "get_platform_stats",
      description: `Get cross-project platform statistics. Shows all projects, their collections, and aggregated metrics.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_platform_stats"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const response = await ctx.api.get("/api/platform/stats");
        const data = response.data;

        let result = `## Platform Statistics\n\n`;
        result += `- **Total Projects:** ${data.totalProjects ?? 0}\n`;
        result += `- **Total Collections:** ${data.totalCollections ?? 0}\n\n`;

        if (data.projects && data.projects.length > 0) {
          result += `### Projects\n`;
          for (const p of data.projects) {
            result += `- **${p.project}**: ${p.collections} collections, ${p.totalVectors} vectors\n`;
          }
        }

        return result;
      },
    },
  ];
}
