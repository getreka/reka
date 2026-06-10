/**
 * Quality tools module - LLM quality monitoring and reporting.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the quality tools module.
 */
export function createQualityTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "get_quality_report",
      description: `Get LLM quality metrics for ${projectName}. Shows JSON parse rates, latency percentiles, thinking trace rates, and alerts.`,
      schema: z.object({
        endpoint: z
          .string()
          .optional()
          .describe("Filter by specific endpoint (e.g., '/api/ask')"),
      }),
      annotations: TOOL_ANNOTATIONS["get_quality_report"] || {
        title: "Get Quality Report",
        readOnlyHint: true,
        openWorldHint: false,
      },
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const params = args.endpoint
          ? `?endpoint=${encodeURIComponent(args.endpoint as string)}`
          : "";
        const response = await ctx.api.get(`/api/quality/report${params}`);
        const data = response.data;

        let result = `## Quality Report\n\n`;
        result += `**Total Metrics:** ${data.total}\n\n`;

        if (data.total === 0) {
          result += `No quality metrics recorded yet.\n`;
          return result;
        }

        const m = data.metrics;
        result += `### Aggregate Metrics\n`;
        result += `- **Avg Latency:** ${m.avgLatencyMs}ms\n`;
        result += `- **P95 Latency:** ${m.p95LatencyMs}ms\n`;
        result += `- **JSON Parse Rate:** ${(m.jsonParseRate * 100).toFixed(1)}%\n`;
        result += `- **Thinking Rate:** ${(m.thinkingRate * 100).toFixed(1)}%\n`;
        result += `- **Avg Output Length:** ${m.avgOutputLength} chars\n`;
        result += `- **Avg Thinking Length:** ${m.avgThinkingLength} chars\n`;
        result += `- **Avg Tokens:** ${m.avgTokens}\n\n`;

        if (data.alerts.length > 0) {
          result += `### ⚠ Alerts\n`;
          for (const alert of data.alerts) {
            result += `- ${alert}\n`;
          }
          result += `\n`;
        }

        if (Object.keys(data.byEndpoint).length > 0) {
          result += `### By Endpoint\n`;
          for (const [ep, stats] of Object.entries(data.byEndpoint) as Array<
            [string, any]
          >) {
            result += `- **${ep}**: ${stats.count} calls, ${stats.avgLatencyMs}ms avg, `;
            result += `JSON: ${(stats.jsonParseRate * 100).toFixed(0)}%, `;
            result += `Thinking: ${(stats.thinkingRate * 100).toFixed(0)}%\n`;
          }
        }

        return result;
      },
    },
  ];
}
