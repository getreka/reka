/**
 * Feedback tools module - search feedback, memory feedback, query suggestions,
 * and quality metrics.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { pct } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the feedback tools module with project-specific descriptions.
 */
export function createFeedbackTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "feedback_search",
      description: `Provide feedback on a search result quality for ${projectName}. Helps improve future search results.`,
      schema: z.object({
        query: z.string().describe("The original search query"),
        feedbackType: z
          .enum(["helpful", "not_helpful", "partially"])
          .describe("How helpful the results were"),
        file: z
          .string()
          .optional()
          .describe("The file from results being rated"),
        suggestedQuery: z
          .string()
          .optional()
          .describe("A better query that would have found the right results"),
      }),
      annotations: TOOL_ANNOTATIONS["feedback_search"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { query, feedbackType, file, suggestedQuery } = args as {
          query: string;
          feedbackType: string;
          file?: string;
          suggestedQuery?: string;
        };
        const response = await ctx.api.post("/api/feedback/search", {
          projectName: ctx.projectName,
          query,
          feedbackType,
          file,
          suggestedQuery,
        });

        const emojis: Record<string, string> = {
          helpful: "\ud83d\udc4d",
          not_helpful: "\ud83d\udc4e",
          partially: "\ud83e\udd14",
        };
        const emoji = emojis[feedbackType] || "";

        let result = `${emoji} **Search Feedback Recorded**\n\n`;
        result += `- **Query:** ${query}\n`;
        result += `- **Feedback:** ${feedbackType}\n`;
        if (file) result += `- **File:** ${file}\n`;
        if (suggestedQuery)
          result += `- **Suggested Query:** ${suggestedQuery}\n`;

        return result;
      },
    },
    {
      name: "feedback_memory",
      description: `Provide feedback on a memory's accuracy for ${projectName}. Helps keep memory quality high.`,
      schema: z.object({
        memoryId: z.string().describe("The memory ID to provide feedback on"),
        feedback: z
          .enum(["accurate", "outdated", "incorrect"])
          .describe("Feedback on the memory's accuracy"),
        correction: z
          .string()
          .optional()
          .describe("Corrected information if the memory is wrong"),
      }),
      annotations: TOOL_ANNOTATIONS["feedback_memory"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { memoryId, feedback, correction } = args as {
          memoryId: string;
          feedback: string;
          correction?: string;
        };
        const response = await ctx.api.post("/api/feedback/memory", {
          projectName: ctx.projectName,
          memoryId,
          feedback,
          correction,
        });

        const emojis: Record<string, string> = {
          accurate: "\u2705",
          outdated: "\u23f0",
          incorrect: "\u274c",
        };
        const emoji = emojis[feedback] || "";

        let result = `${emoji} **Memory Feedback Recorded**\n\n`;
        result += `- **Memory ID:** ${memoryId}\n`;
        result += `- **Feedback:** ${feedback}\n`;
        if (correction) result += `- **Correction:** ${correction}\n`;

        return result;
      },
    },
    {
      name: "suggest_better_query",
      description: `Get query improvement suggestions based on feedback patterns for ${projectName}.`,
      schema: z.object({
        query: z.string().describe("The query to get suggestions for"),
        context: z
          .string()
          .optional()
          .describe("Additional context about what you are looking for"),
      }),
      annotations: TOOL_ANNOTATIONS["suggest_better_query"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { query, context } = args as { query: string; context?: string };

        let suggestions: any[] = [];
        try {
          const response = await ctx.api.post("/api/query/suggest", {
            projectName: ctx.projectName,
            query,
            context,
          });
          suggestions = response.data.suggestions || [];
        } catch {
          // Fallback to query analyze
        }

        if (!suggestions || suggestions.length === 0) {
          try {
            const fallback = await ctx.api.post("/api/query/analyze", {
              projectName: ctx.projectName,
              query,
              context,
            });
            suggestions = fallback.data.suggestions || [];
          } catch {
            return "No query suggestions available.";
          }
        }

        if (!suggestions || suggestions.length === 0) {
          return "No query suggestions available.";
        }

        const sourceEmojis: Record<string, string> = {
          feedback: "\ud83d\udcca",
          pattern: "\ud83d\udd04",
          ai: "\ud83e\udd16",
        };

        let result = `## Query Suggestions\n\n`;
        for (const s of suggestions) {
          const emoji = sourceEmojis[s.source] || "";
          result += `- ${emoji} **${s.query || s.suggestion}**`;
          if (s.confidence) result += ` (confidence: ${pct(s.confidence)})`;
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "get_quality_metrics",
      description: `Get search and memory quality metrics for ${projectName}.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_quality_metrics"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const response = await ctx.api.get(`/api/quality/${ctx.projectName}`);
        const data = response.data;

        let result = `## Quality Metrics: ${projectName}\n\n`;

        if (data.searchQuality) {
          const sq = data.searchQuality;
          result += `### Search Quality\n`;
          result += `- Helpful: ${pct(sq.helpfulRate || 0)}\n`;
          result += `- Partially Helpful: ${pct(sq.partialRate || 0)}\n`;
          result += `- Not Helpful: ${pct(sq.notHelpfulRate || 0)}\n\n`;
        }

        if (data.memoryQuality) {
          const mq = data.memoryQuality;
          result += `### Memory Quality\n`;
          result += `- Accuracy: ${pct(mq.accuracyRate || 0)}\n`;
          result += `- Outdated: ${pct(mq.outdatedRate || 0)}\n`;
          result += `- Incorrect: ${pct(mq.incorrectRate || 0)}\n\n`;
        }

        if (data.trends) {
          const trendEmojis: Record<string, string> = {
            up: "\ud83d\udcc8",
            down: "\ud83d\udcc9",
            flat: "\u27a1\ufe0f",
          };
          result += `### Trends\n`;
          for (const [metric, direction] of Object.entries(data.trends)) {
            const emoji = trendEmojis[direction as string] || "\u27a1\ufe0f";
            result += `- ${emoji} ${metric}: ${direction}\n`;
          }
          result += "\n";
        }

        if (data.problematicQueries && data.problematicQueries.length > 0) {
          result += `### Problematic Queries\n`;
          for (const q of data.problematicQueries) {
            result += `- "${q.query}" (${q.count || 0} times)\n`;
          }
        }

        return result;
      },
    },
  ];
}
