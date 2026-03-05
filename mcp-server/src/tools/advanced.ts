/**
 * Advanced tools module - memory merging, code completion context,
 * import suggestions, type context, and behavior patterns.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { truncate, pct } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the advanced tools module with project-specific descriptions.
 */
export function createAdvancedTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "merge_memories",
      description: `Consolidate duplicate memories for ${projectName}. Finds similar memories and merges them using LLM to reduce clutter.`,
      schema: z.object({
        type: z.string().optional().describe("Filter by memory type (decision, insight, context, todo, conversation, note, or all). Default: all"),
        threshold: z.coerce.number().optional().describe("Similarity threshold for merging (0.5-1.0, default: 0.9). Lower = more aggressive merging."),
        dryRun: z.boolean().optional().describe("If true, preview merge candidates without making changes (default: true)."),
        limit: z.coerce.number().optional().describe("Max clusters to process (default: 50)."),
      }),
      annotations: TOOL_ANNOTATIONS["merge_memories"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { type = "all", threshold = 0.9, dryRun = true, limit = 50 } =
          args as {
            type?: string;
            threshold?: number;
            dryRun?: boolean;
            limit?: number;
          };

        const response = await ctx.api.post("/api/memory/merge", {
          type,
          threshold,
          dryRun,
          limit,
        });
        const data = response.data;

        let result = `## Memory Merge${dryRun ? " (Dry Run)" : ""}\n\n`;
        result += `- **Memories Scanned:** ${data.totalFound ?? 0}\n`;
        result += `- **Merge Clusters Found:** ${data.totalMerged ?? 0}\n`;
        result += `- **Threshold:** ${threshold}\n`;

        if (dryRun) {
          result += `\n*This was a dry run. Set dryRun=false to apply merges.*\n`;
        }

        if (data.merged && data.merged.length > 0) {
          result += `\n### Merge Candidates\n\n`;
          for (const cluster of data.merged.slice(0, 10)) {
            const origCount = cluster.original?.length ?? 0;
            result += `**Cluster (${origCount} memories → 1):**\n`;
            if (cluster.original) {
              for (const orig of cluster.original.slice(0, 3)) {
                result += `  - ${truncate(orig.content || "", 80)}\n`;
              }
              if (origCount > 3) {
                result += `  - ... and ${origCount - 3} more\n`;
              }
            }
            result += `  **→ Merged:** ${truncate(cluster.merged?.content || "", 120)}\n\n`;
          }

          if (data.merged.length > 10) {
            result += `... and ${data.merged.length - 10} more clusters\n`;
          }
        }

        return result;
      },
    },

    {
      name: "get_completion_context",
      description: `Get code completion context for ${projectName}. Finds similar patterns, imports, and symbols from the codebase to aid code completion.`,
      schema: z.object({
        currentFile: z.string().describe("Path of the file being edited"),
        currentCode: z.string().describe("Current code snippet or file content"),
        language: z.string().optional().describe("Programming language filter (optional)"),
        limit: z.coerce.number().optional().describe("Max results (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_completion_context"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { currentFile, currentCode, language, limit = 5 } = args as {
          currentFile: string;
          currentCode: string;
          language?: string;
          limit?: number;
        };

        const response = await ctx.api.post("/api/code/completion-context", {
          currentFile,
          currentCode,
          language,
          limit,
        });
        const data = response.data;

        let result = `## Completion Context\n\n`;

        if (data.patterns && data.patterns.length > 0) {
          result += `### Similar Patterns (${data.patterns.length})\n\n`;
          for (const p of data.patterns) {
            result += `**${p.file}** (${pct(p.score)} match)\n`;
            result += "```\n" + truncate(p.content, 300) + "\n```\n\n";
          }
        } else {
          result += "No similar patterns found.\n\n";
        }

        if (data.imports && data.imports.length > 0) {
          result += `### Imports from Similar Files\n`;
          result += data.imports.map((i: string) => `- \`${i}\``).join("\n");
          result += "\n\n";
        }

        if (data.symbols && data.symbols.length > 0) {
          result += `### Available Symbols\n`;
          result += data.symbols.map((s: string) => `- \`${s}\``).join("\n");
          result += "\n";
        }

        return result;
      },
    },

    {
      name: "get_import_suggestions",
      description: `Suggest missing imports for ${projectName}. Analyzes similar files to find commonly used imports not present in your current file.`,
      schema: z.object({
        currentFile: z.string().describe("Path of the file being edited"),
        currentCode: z.string().describe("Current code content"),
        language: z.string().optional().describe("Programming language filter (optional)"),
        limit: z.coerce.number().optional().describe("Max suggestions (default: 10)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_import_suggestions"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { currentFile, currentCode, language, limit = 10 } = args as {
          currentFile: string;
          currentCode: string;
          language?: string;
          limit?: number;
        };

        const response = await ctx.api.post("/api/code/import-suggestions", {
          currentFile,
          currentCode,
          language,
          limit,
        });
        const data = response.data;

        let result = `## Import Suggestions\n\n`;

        if (data.currentImports && data.currentImports.length > 0) {
          result += `**Current Imports (${data.currentImports.length}):** ${data.currentImports.map((i: string) => `\`${i}\``).join(", ")}\n\n`;
        }

        if (data.suggestions && data.suggestions.length > 0) {
          result += `### Suggested Imports\n\n`;
          for (const s of data.suggestions) {
            result += `- **\`${s.importPath}\`** — used in ${s.frequency} similar files`;
            if (s.usedBy && s.usedBy.length > 0) {
              result += ` (${s.usedBy.map((f: string) => truncate(f, 40)).join(", ")})`;
            }
            result += "\n";
          }
        } else {
          result += "No additional imports suggested.\n";
        }

        return result;
      },
    },

    {
      name: "get_type_context",
      description: `Look up type/interface/class definitions and usage in ${projectName}. Finds where a type is defined and how it's used across the codebase.`,
      schema: z.object({
        typeName: z.string().optional().describe("Name of the type/interface/class to look up"),
        code: z.string().optional().describe("Code containing types to look up (alternative to typeName)"),
        currentFile: z.string().optional().describe("Current file to exclude from results"),
        limit: z.coerce.number().optional().describe("Max results per category (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_type_context"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { typeName, code, currentFile, limit = 5 } = args as {
          typeName?: string;
          code?: string;
          currentFile?: string;
          limit?: number;
        };

        if (!typeName && !code) {
          return "Error: Either typeName or code is required.";
        }

        const response = await ctx.api.post("/api/code/type-context", {
          typeName,
          code,
          currentFile,
          limit,
        });
        const data = response.data;

        let result = `## Type Context${typeName ? `: ${typeName}` : ""}\n\n`;

        if (data.definitions && data.definitions.length > 0) {
          result += `### Definitions (${data.definitions.length})\n\n`;
          for (const d of data.definitions) {
            result += `**${d.file}** (${pct(d.score)} match)\n`;
            result += "```\n" + truncate(d.content, 400) + "\n```\n\n";
          }
        } else {
          result += "No type definitions found.\n\n";
        }

        if (data.usages && data.usages.length > 0) {
          result += `### Usage Examples (${data.usages.length})\n\n`;
          for (const u of data.usages) {
            result += `**${u.file}** (${pct(u.score)} match)\n`;
            result += "```\n" + truncate(u.content, 300) + "\n```\n\n";
          }
        }

        return result;
      },
    },

    {
      name: "get_behavior_patterns",
      description: `Analyze user workflow patterns for ${projectName}. Shows peak hours, tool preferences, common sequences, and session statistics.`,
      schema: z.object({
        days: z.coerce.number().optional().describe("Number of days to analyze (default: 7)"),
        sessionId: z.string().optional().describe("Filter to a specific session (optional)"),
      }),
      annotations: TOOL_ANNOTATIONS["get_behavior_patterns"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { days = 7, sessionId } = args as {
          days?: number;
          sessionId?: string;
        };

        const params = new URLSearchParams();
        params.set("days", String(days));
        if (sessionId) params.set("sessionId", sessionId);

        const response = await ctx.api.get(
          `/api/behavior-patterns?${params.toString()}`
        );
        const data = response.data;

        let result = `## Behavior Patterns (last ${days} days)\n\n`;

        // Session stats
        const ss = data.sessionStats;
        if (ss) {
          result += `### Session Statistics\n`;
          result += `- **Total Sessions:** ${ss.totalSessions}\n`;
          result += `- **Avg Tools/Session:** ${ss.avgToolsPerSession}\n`;
          result += `- **Avg Duration:** ${ss.avgDurationMinutes} min\n\n`;
        }

        // Peak hours
        if (data.peakHours && data.peakHours.length > 0) {
          result += `### Peak Hours\n`;
          const top5 = data.peakHours.slice(0, 5);
          for (const h of top5) {
            result += `- **${String(h.hour).padStart(2, "0")}:00** — ${h.count} calls\n`;
          }
          result += "\n";
        }

        // Tool preferences
        if (data.toolPreferences && data.toolPreferences.length > 0) {
          result += `### Tool Preferences\n`;
          for (const t of data.toolPreferences.slice(0, 10)) {
            result += `- **${t.tool}**: ${t.count} calls (avg ${t.avgDuration}ms)\n`;
          }
          result += "\n";
        }

        // Workflows
        if (data.workflows && data.workflows.length > 0) {
          result += `### Common Workflows\n`;
          for (const w of data.workflows.slice(0, 10)) {
            result += `- ${w.sequence.join(" → ")} (${w.count}x)\n`;
          }
          result += "\n";
        }

        return result;
      },
    },
  ];
}
