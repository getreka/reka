/**
 * Common Zod schemas shared across tool modules.
 *
 * Import individual shapes into each tool module when migrating
 * from raw JSON Schema objects to Zod-based inputSchema definitions.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolInputSchema } from "./types.js";

// ── JSON Schema conversion ──────────────────────────────────

/**
 * Convert a Zod object schema to the MCP ToolInputSchema format.
 * Used during Phase 2 migration while ToolRegistry still expects raw JSON Schema.
 * Phase 3 passes Zod schemas directly to McpServer.registerTool().
 */
export function zodToInputSchema(schema: z.ZodObject<z.ZodRawShape>): ToolInputSchema {
  const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
  return {
    type: "object",
    properties: (jsonSchema.properties ?? {}) as Record<string, unknown>,
    ...(Array.isArray(jsonSchema.required) && jsonSchema.required.length > 0
      ? { required: jsonSchema.required as string[] }
      : {}),
  };
}

// ── Primitives ──────────────────────────────────────────────

export const QueryStr = z
  .string()
  .min(1)
  .describe("Search query or question");

export const Limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe("Maximum results to return");

export const Offset = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Pagination offset");

export const FilePath = z
  .string()
  .min(1)
  .describe("File path relative to project root");

export const FilePaths = z
  .array(FilePath)
  .min(1)
  .describe("List of file paths");

export const Content = z
  .string()
  .min(1)
  .describe("Text content");

export const CollectionSuffix = z
  .string()
  .min(1)
  .describe("Collection suffix (e.g. 'codebase', 'docs')");

// ── Enums ───────────────────────────────────────────────────

export const MemoryType = z.enum([
  "decision",
  "insight",
  "pattern",
  "adr",
  "tech_debt",
  "todo",
  "architecture",
  "convention",
  "bug_fix",
  "optimization",
]);

export const ResponseFormat = z
  .enum(["json", "markdown"])
  .default("markdown")
  .describe("Output format");

export const Importance = z
  .enum(["low", "medium", "high", "critical"])
  .default("medium")
  .describe("Importance level");

export const Priority = z
  .enum(["low", "medium", "high", "critical"])
  .describe("Priority level");

export const Severity = z
  .enum(["low", "medium", "high", "critical"])
  .describe("Severity level");

// ── Reusable object shapes ──────────────────────────────────

export const PaginationParams = z.object({
  limit: Limit.optional(),
  offset: Offset.optional(),
});

export const SearchFilters = z
  .object({
    file_type: z
      .string()
      .optional()
      .describe("Filter by file extension (e.g. 'ts', 'py')"),
    directory: z
      .string()
      .optional()
      .describe("Filter by directory prefix"),
  })
  .optional()
  .describe("Search filters");

export const Tags = z
  .array(z.string())
  .optional()
  .describe("Tags for categorization");

export const Confidence = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("Confidence score (0-1)");

// ── Composite input shapes ──────────────────────────────────

/** Base shape for search tools: query + optional limit + optional filters */
export const SearchInput = z.object({
  query: QueryStr,
  limit: Limit.optional(),
  filters: SearchFilters,
});

/** Base shape for memory record tools */
export const MemoryRecordInput = z.object({
  content: Content.describe("Content to remember"),
  type: MemoryType,
  tags: Tags,
  importance: Importance.optional(),
  context: z.string().optional().describe("Additional context"),
});
