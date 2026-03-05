/**
 * Indexing tools module - codebase indexing, status, zero-downtime reindex,
 * and alias management.
 *
 * index_codebase and reindex_zero_downtime read files locally and upload
 * them to the RAG API in batches via POST /api/index/upload. This allows
 * remote MCP clients to index codebases that aren't on the server filesystem.
 */

import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

const DEFAULT_PATTERNS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.vue",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.md",
  "**/*.sql",
  "**/*.yml",
  "**/*.yaml",
  "**/Dockerfile",
];

const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  "**/.nuxt/**",
  "**/.next/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/eval/results/**",
  "**/eval/golden-queries.json",
];

const BATCH_SIZE = 50;

/**
 * Discover files locally using glob, read their contents, and upload
 * them to the RAG API in batches.
 */
async function uploadFiles(
  ctx: ToolContext,
  projectPath: string,
  opts: {
    patterns?: string[];
    excludePatterns?: string[];
    force?: boolean;
  }
): Promise<{ totalFiles: number; indexedFiles: number; totalChunks: number; errors: number; duration: number }> {
  const patterns = opts.patterns || DEFAULT_PATTERNS;
  const excludePatterns = opts.excludePatterns || DEFAULT_EXCLUDE;

  // Discover files locally
  const files = await glob(patterns, {
    cwd: projectPath,
    ignore: excludePatterns,
    nodir: true,
    absolute: false,
  });

  if (files.length === 0) {
    return { totalFiles: 0, indexedFiles: 0, totalChunks: 0, errors: 0, duration: 0 };
  }

  let totalIndexed = 0;
  let totalChunks = 0;
  let totalErrors = 0;
  let totalDuration = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const filePayloads: Array<{ path: string; content: string }> = [];

    for (const relPath of batch) {
      try {
        const absPath = path.join(projectPath, relPath);
        const content = fs.readFileSync(absPath, "utf-8");
        filePayloads.push({ path: relPath, content });
      } catch {
        totalErrors++;
      }
    }

    if (filePayloads.length === 0) continue;

    const isFirst = i === 0;
    const isLast = i + BATCH_SIZE >= files.length;

    const response = await ctx.api.post("/api/index/upload", {
      files: filePayloads,
      force: isFirst && (opts.force ?? false),
      done: isLast,
    });

    const data = response.data;
    totalIndexed += data.filesProcessed || 0;
    totalChunks += data.chunksCreated || 0;
    totalErrors += data.errors || 0;
    totalDuration += data.duration || 0;
  }

  return {
    totalFiles: files.length,
    indexedFiles: totalIndexed,
    totalChunks,
    errors: totalErrors,
    duration: totalDuration,
  };
}

// In-memory cache for get_index_status (30 min TTL)
let _statusCache: { data: string; expiresAt: number; structured: Record<string, unknown> } | null = null;
const STATUS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Create the indexing tools module with project-specific descriptions.
 */
export function createIndexingTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "index_codebase",
      description: `Index or re-index the ${projectName} codebase for RAG search.`,
      schema: z.object({
        path: z.string().optional().describe("Path to index (default: entire project)"),
        force: z.boolean().optional().describe("Force re-index even if already indexed"),
      }),
      annotations: TOOL_ANNOTATIONS["index_codebase"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { path: indexPath, force = false } = args as {
          path?: string;
          force?: boolean;
        };
        const projectPath = indexPath || ctx.projectPath;

        const stats = await uploadFiles(ctx, projectPath, { force });
        _statusCache = null; // Invalidate status cache after indexing

        let result = `## Indexing ${projectName}\n\n`;
        result += `- **Total files found:** ${stats.totalFiles}\n`;
        result += `- **Files indexed:** ${stats.indexedFiles}\n`;
        result += `- **Chunks created:** ${stats.totalChunks}\n`;
        result += `- **Errors:** ${stats.errors}\n`;
        result += `- **Duration:** ${stats.duration}ms\n`;

        return result;
      },
    },
    {
      name: "get_index_status",
      description: `Get the indexing status for ${projectName} codebase. Results cached for 30 minutes.`,
      schema: z.object({}),
      outputSchema: z.object({
        status: z.string(),
        totalFiles: z.coerce.number().optional(),
        indexedFiles: z.coerce.number().optional(),
        lastUpdated: z.string().optional(),
        vectorCount: z.coerce.number().optional(),
        cached: z.boolean(),
      }),
      annotations: TOOL_ANNOTATIONS["get_index_status"],
      handler: async (_args: Record<string, unknown>, ctx: ToolContext) => {
        // Return cached result if still valid
        if (_statusCache && Date.now() < _statusCache.expiresAt) {
          const remainingMin = Math.round((_statusCache.expiresAt - Date.now()) / 60000);
          return {
            text: _statusCache.data + `\n_Cached (expires in ${remainingMin}min)_`,
            structured: { ..._statusCache.structured, cached: true },
          };
        }

        const response = await ctx.api.get(
          `/api/index/status/${ctx.collectionPrefix}codebase`
        );
        const data = response.data;

        let text = `## Index Status: ${projectName}\n\n`;
        text += `- **Status:** ${data.status || "unknown"}\n`;
        text += `- **Total Files:** ${data.totalFiles ?? "N/A"}\n`;
        text += `- **Indexed Files:** ${data.indexedFiles ?? "N/A"}\n`;
        text += `- **Last Updated:** ${data.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : "Never"}\n`;
        text += `- **Vector Count:** ${data.vectorCount ?? "N/A"}\n`;

        const structured = {
          status: data.status || "unknown",
          totalFiles: data.totalFiles,
          indexedFiles: data.indexedFiles,
          lastUpdated: data.lastUpdated,
          vectorCount: data.vectorCount,
          cached: false,
        };

        // Cache for 30 minutes
        _statusCache = { data: text, expiresAt: Date.now() + STATUS_CACHE_TTL, structured };

        return { text, structured };
      },
    },
    {
      name: "reindex_zero_downtime",
      description: `Reindex ${projectName} codebase with zero downtime using alias swap.`,
      schema: z.object({
        path: z.string().optional().describe("Path to index (default: entire project)"),
        patterns: z.array(z.string()).optional().describe("File patterns to include (e.g., ['**/*.ts', '**/*.py'])"),
        excludePatterns: z.array(z.string()).optional().describe("File patterns to exclude (e.g., ['node_modules/**'])"),
      }),
      annotations: TOOL_ANNOTATIONS["reindex_zero_downtime"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { path: indexPath, patterns, excludePatterns } = args as {
          path?: string;
          patterns?: string[];
          excludePatterns?: string[];
        };
        const projectPath = indexPath || ctx.projectPath;

        const stats = await uploadFiles(ctx, projectPath, {
          patterns,
          excludePatterns,
          force: true,
        });
        _statusCache = null; // Invalidate status cache after reindex

        let result = `## Reindex: ${projectName}\n\n`;
        result += `- **Total files found:** ${stats.totalFiles}\n`;
        result += `- **Files indexed:** ${stats.indexedFiles}\n`;
        result += `- **Chunks created:** ${stats.totalChunks}\n`;
        result += `- **Errors:** ${stats.errors}\n`;
        result += `- **Duration:** ${stats.duration}ms\n`;

        return result;
      },
    },
    {
      name: "list_aliases",
      description: "List all collection aliases and their mappings.",
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["list_aliases"],
      handler: async (_args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const response = await ctx.api.get("/api/aliases");
        const aliases = response.data.aliases || response.data;

        if (!aliases || (Array.isArray(aliases) && aliases.length === 0)) {
          return "No aliases configured.";
        }

        let result = `## Collection Aliases\n\n`;
        if (Array.isArray(aliases)) {
          for (const a of aliases) {
            result += `- **${a.alias}** -> ${a.collection}\n`;
          }
        } else {
          for (const [alias, collection] of Object.entries(aliases)) {
            result += `- **${alias}** -> ${collection}\n`;
          }
        }

        return result;
      },
    },
  ];
}
