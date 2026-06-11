/**
 * Search tools module - hybrid codebase search (the retrieval canon),
 * documentation search, symbol lookup, graph search, and project statistics.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import {
  formatCodeResults,
  formatNavigationResults,
  truncate,
} from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the search tools module with project-specific descriptions.
 */
export function createSearchTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "hybrid_search",
      description:
        `Call this when you need to find code in ${projectName} and you don't already know the exact file or symbol name — conceptual questions ("how does X work", "where is Y handled") or locating the code behind a feature. ` +
        `Runs hybrid retrieval (semantic + keyword) over the indexed codebase and returns the best-matching code. ` +
        `Set mode: "navigate" for a compact map of file locations, symbols, and graph connections (no code bodies) — then use the Read tool on the returned paths. ` +
        `Prefer Grep for exact strings and find_symbol when you already know a function/class/type name.`,
      schema: z.object({
        query: z.string().describe("Search query"),
        mode: z
          .enum(["content", "navigate"])
          .optional()
          .describe(
            "content (default): return matching code. navigate: return file locations, symbols, and graph connections only",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default: 10)"),
        semanticWeight: z.coerce
          .number()
          .optional()
          .describe("Weight for semantic vs keyword (0-1, default: 0.7)"),
        language: z
          .string()
          .optional()
          .describe("Filter by language (typescript, python, vue, etc.)"),
        path: z
          .string()
          .optional()
          .describe("Filter by path pattern (e.g., 'src/modules/*')"),
        layer: z
          .string()
          .optional()
          .describe("Filter by architectural layer (api, service, util, etc.)"),
        service: z.string().optional().describe("Filter by service/class name"),
      }),
      annotations: TOOL_ANNOTATIONS["hybrid_search"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          query,
          mode = "content",
          limit = 10,
          semanticWeight = 0.7,
          language,
          path,
          layer,
          service,
        } = args as {
          query: string;
          mode?: "content" | "navigate";
          limit?: number;
          semanticWeight?: number;
          language?: string;
          path?: string;
          layer?: string;
          service?: string;
        };
        const filters: Record<string, string | undefined> = {
          language,
          path,
          layer,
          service,
        };
        const hasFilters = Object.values(filters).some((v) => v !== undefined);
        const response = await ctx.api.post("/api/search-hybrid", {
          collection: `${ctx.collectionPrefix}codebase`,
          query,
          limit,
          semanticWeight,
          mode,
          filters: hasFilters ? filters : undefined,
        });
        const results = response.data.results;
        if (!results || results.length === 0) {
          return "No results found.";
        }
        return mode === "navigate"
          ? formatNavigationResults(results)
          : formatCodeResults(results, 400);
      },
    },
    {
      name: "search_docs",
      description: `Search documentation in the ${projectName} project.`,
      schema: z.object({
        query: z.string().describe("Search query"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["search_docs"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        const response = await ctx.api.post("/api/search", {
          collection: `${ctx.collectionPrefix}docs`,
          query,
          limit,
        });
        const results = response.data.results;
        if (!results || results.length === 0) {
          return "No documentation found for this query.";
        }
        return results
          .map((r: any) => `**${r.file}**\n` + truncate(r.content, 500))
          .join("\n\n---\n\n");
      },
    },
    {
      name: "get_project_stats",
      description: `Get statistics about the ${projectName} codebase.`,
      schema: z.object({}),
      outputSchema: z.object({
        projectName: z.string(),
        totalFiles: z.coerce.number(),
        totalLines: z.coerce.number().optional(),
        vectorCount: z.coerce.number(),
        lastIndexed: z.string().optional(),
        languages: z.record(z.string(), z.coerce.number()).optional(),
      }),
      annotations: TOOL_ANNOTATIONS["get_project_stats"],
      handler: async (_args: Record<string, unknown>, ctx: ToolContext) => {
        const response = await ctx.api.get(
          `/api/stats/${ctx.collectionPrefix}codebase`,
        );
        const stats = response.data;
        let text = `**${ctx.projectName} Project Statistics**\n\n`;
        text += `- Total Files: ${stats.totalFiles}\n`;
        text += `- Total Lines: ${stats.totalLines?.toLocaleString() || "N/A"}\n`;
        text += `- Vector Count: ${stats.vectorCount}\n`;
        text += `- Last Indexed: ${stats.lastIndexed ? new Date(stats.lastIndexed).toLocaleString() : "Never"}\n`;
        if (stats.languages) {
          text += `\n**Languages:**\n`;
          for (const [lang, count] of Object.entries(stats.languages)) {
            text += `- ${lang}: ${count} files\n`;
          }
        }
        return {
          text,
          structured: {
            projectName: ctx.projectName,
            totalFiles: stats.totalFiles,
            totalLines: stats.totalLines,
            vectorCount: stats.vectorCount,
            lastIndexed: stats.lastIndexed,
            languages: stats.languages,
          },
        };
      },
    },
    {
      name: "find_symbol",
      description: `Find a function, class, type, or interface by name in ${projectName}. Fast symbol lookup without full-text search.`,
      schema: z.object({
        symbol: z
          .string()
          .describe("Symbol name to find (function, class, type, etc.)"),
        kind: z
          .string()
          .optional()
          .describe(
            "Filter by kind: function, class, interface, type, enum, const",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default: 10)"),
      }),
      outputSchema: z.object({
        symbols: z.array(
          z.object({
            kind: z.string(),
            name: z.string(),
            file: z.string(),
            startLine: z.coerce.number(),
            endLine: z.coerce.number(),
            signature: z.string(),
            exported: z.boolean(),
          }),
        ),
      }),
      annotations: TOOL_ANNOTATIONS["find_symbol"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const {
          symbol,
          kind,
          limit = 10,
        } = args as {
          symbol: string;
          kind?: string;
          limit?: number;
        };
        const response = await ctx.api.post("/api/find-symbol", {
          projectName: ctx.projectName,
          symbol,
          kind,
          limit,
        });
        const results = response.data.results;
        if (!results || results.length === 0) {
          return `No symbol "${symbol}" found.`;
        }
        const text = results
          .map(
            (r: any) =>
              `**${r.kind} ${r.name}** in \`${r.file}\` (lines ${r.startLine}-${r.endLine})\n` +
              `\`${truncate(r.signature, 150)}\`` +
              (r.exports ? " _(exported)_" : ""),
          )
          .join("\n\n");
        return {
          text,
          structured: {
            symbols: results.map((r: any) => ({
              kind: r.kind,
              name: r.name,
              file: r.file,
              startLine: r.startLine,
              endLine: r.endLine,
              signature: r.signature,
              exported: !!r.exports,
            })),
          },
        };
      },
    },
    {
      name: "search_graph",
      description: `Search ${projectName} codebase with graph expansion. Returns file locations plus connected files via import/call relationships. Use Read tool to view code.`,
      schema: z.object({
        query: z.string().describe("Search query"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max direct results (default: 5)"),
        expandHops: z.coerce
          .number()
          .optional()
          .describe("Number of graph hops to expand (default: 1)"),
      }),
      annotations: TOOL_ANNOTATIONS["search_graph"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          query,
          limit = 5,
          expandHops = 1,
        } = args as {
          query: string;
          limit?: number;
          expandHops?: number;
        };
        const response = await ctx.api.post("/api/search-graph", {
          collection: `${ctx.collectionPrefix}codebase`,
          query,
          limit,
          expandHops,
          mode: "navigate",
        });
        const { results, graphExpanded, expandedFiles } = response.data;

        if (
          (!results || results.length === 0) &&
          (!graphExpanded || graphExpanded.length === 0)
        ) {
          return "No results found.";
        }

        let output = "";

        if (results && results.length > 0) {
          output += "**Direct matches:**\n\n";
          output += formatNavigationResults(results);
        }

        if (graphExpanded && graphExpanded.length > 0) {
          output += "\n\n---\n\n**Graph-connected files:**\n\n";
          output += formatNavigationResults(graphExpanded);
        }

        if (expandedFiles && expandedFiles.length > 0) {
          output += `\n\n_Graph expanded to ${expandedFiles.length} additional files._`;
        }

        return output;
      },
    },
  ];
}
