/**
 * Memory tools module - Agent memory management tools.
 *
 * Tools: remember, recall, list_memories, forget, batch_remember,
 *        review_memories, promote_memory
 */

import type { ToolSpec, ToolContext } from "../types.js";
import {
  formatMemoryResults,
  truncate,
  paginationFooter,
  PREVIEW,
} from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

const typeEmojis: Record<string, string> = {
  decision: "\u{1F3AF}",
  insight: "\u{1F4A1}",
  context: "\u{1F4CC}",
  todo: "\u{1F4CB}",
  conversation: "\u{1F4AC}",
  note: "\u{1F4DD}",
  procedure: "\u{1F4D6}",
};

// ── Trigger descriptions (M2-5) ──────────────────────────────────────────────
// Prescriptive "Call this when…" + anti-trigger wording at module level, so
// every profile and the agent-runtime mirror (rag-api agent-profiles.ts
// TOOL_DEFINITIONS) share the same triggering language. Keep copies in sync.

export const REMEMBER_DESCRIPTION =
  `Call this once per work item, and only when you learned something non-obvious — a decision, a gotcha, or a new procedure — and include the WHY, not just the what. Persists to durable project memory so future sessions recall it. ` +
  `Do NOT save memories for mechanical changes (typos, renames, version bumps) or restate what the code already says — they pollute recall.`;

export const RECALL_DESCRIPTION =
  `Call this when past decisions, insights, ADRs, or notes about this project could change your approach — semantic search over agent memory. ` +
  `Do NOT use for searching code (use hybrid_search or Grep) or documentation (use search_docs).`;

export function createMemoryTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "remember",
      description: REMEMBER_DESCRIPTION,
      schema: z.object({
        content: z.string().describe("Information to remember"),
        type: z
          .enum([
            "decision",
            "insight",
            "context",
            "todo",
            "conversation",
            "note",
            "procedure",
          ])
          .optional()
          .describe("Type of memory (default: note)"),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Tags for categorization (e.g., ['feature-x', 'important'])",
          ),
        relatedTo: z.string().optional().describe("Related feature or topic"),
        triggerDescription: z
          .string()
          .optional()
          .describe(
            "WHEN to recall this memory \u2014 a retrieval cue embedded separately from the content (e.g. 'when changing auth middleware or session handling'). Improves recall matching for the situations where the memory matters.",
          ),
        pin: z
          .enum(["repo", "all"])
          .optional()
          .describe(
            "Set pin when the user says 'always remember this' / 'load this every session'. 'repo' = always loaded for this project; 'all' = always loaded everywhere.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["remember"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const content = args.content as string;
        const type = (args.type as string) || "note";
        const tags = (args.tags as string[]) || [];
        const relatedTo = args.relatedTo as string | undefined;
        const triggerDescription = args.triggerDescription as
          | string
          | undefined;
        const pin = args.pin as string | undefined;

        const response = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          content,
          type,
          tags,
          relatedTo,
          // M2-6: backend already validates/stores both (createMemorySchema);
          // forwarding them gives the trigger-embedding feature a producer and
          // `pin` its first writer for the M3 session digest.
          triggerDescription,
          pin,
        });

        const memory = response.data.memory;
        return (
          `\u2705 **Memory stored**\n\n` +
          `- **ID:** ${memory.id}\n` +
          `- **Type:** ${memory.type}\n` +
          `- **Content:** ${truncate(content, 200)}\n` +
          (tags.length > 0 ? `- **Tags:** ${tags.join(", ")}\n` : "") +
          (relatedTo ? `- **Related to:** ${relatedTo}\n` : "") +
          (triggerDescription
            ? `- **Trigger:** ${truncate(triggerDescription, 120)}\n`
            : "") +
          (pin ? `- **Pinned:** ${pin}\n` : "") +
          `- **Created:** ${new Date(memory.createdAt).toLocaleString()}`
        );
      },
    },

    {
      name: "recall",
      description: RECALL_DESCRIPTION,
      schema: z.object({
        query: z.string().describe("What to recall (semantic search)"),
        type: z
          .enum([
            "decision",
            "insight",
            "context",
            "todo",
            "conversation",
            "note",
            "procedure",
            "all",
          ])
          .optional()
          .describe("Filter by memory type (default: all)"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max memories to retrieve (default: 5)"),
        graphRecall: z
          .boolean()
          .optional()
          .describe(
            "Enable graph-aware recall with spreading activation (default: false)",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["recall"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const query = args.query as string;
        const type = (args.type as string) || "all";
        const limit = (args.limit as number) || 5;
        const graphRecall = (args.graphRecall as boolean) || false;

        const response = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query,
          type,
          limit,
          graphRecall,
        });

        const results = response.data.results || [];
        if (results.length === 0) {
          return `\u{1F50D} No memories found for: "${query}"`;
        }

        const header = `\u{1F9E0} **Recalled Memories** (${results.length} found)\n\n`;
        return header + formatMemoryResults(results);
      },
    },

    {
      name: "list_memories",
      description:
        "List recent memories or filter by type/tags. Shows what the agent has remembered.",
      schema: z.object({
        type: z
          .enum([
            "decision",
            "insight",
            "context",
            "todo",
            "conversation",
            "note",
            "all",
          ])
          .optional()
          .describe("Filter by type"),
        tag: z.string().optional().describe("Filter by tag"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default: 10)"),
        offset: z.coerce
          .number()
          .optional()
          .describe("Pagination offset (default: 0)"),
      }),
      annotations: TOOL_ANNOTATIONS["list_memories"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const type = (args.type as string) || "all";
        const tag = args.tag as string | undefined;
        const limit = (args.limit as number) || 10;
        const offset = (args.offset as number) || 0;

        const params = new URLSearchParams({
          projectName: ctx.projectName,
          limit: limit.toString(),
          offset: offset.toString(),
        });
        if (type && type !== "all") params.append("type", type);
        if (tag) params.append("tag", tag);

        const response = await ctx.api.get(`/api/memory/list?${params}`);
        const memories = response.data.memories || [];

        if (memories.length === 0) {
          return `\u{1F4ED} No memories found${type !== "all" ? ` of type "${type}"` : ""}`;
        }

        let result = `\u{1F4DA} **Agent Memories** (${memories.length})\n\n`;

        memories.forEach(
          (
            m: {
              id: string;
              type: string;
              status?: string;
              content: string;
              createdAt: string;
            },
            i: number,
          ) => {
            const emoji = typeEmojis[m.type] || "\u{1F4DD}";
            const statusStr = m.status ? ` [${m.status}]` : "";
            result += `${offset + i + 1}. ${emoji} **${m.type}**${statusStr}: ${truncate(m.content, PREVIEW.SHORT)}\n`;
            result += `   ID: \`${m.id}\` | ${new Date(m.createdAt).toLocaleDateString()}\n\n`;
          },
        );

        result += paginationFooter(memories.length, limit, offset);
        return result;
      },
    },

    {
      name: "forget",
      description: "Delete a specific memory by ID or clear memories by type.",
      schema: z.object({
        memoryId: z
          .string()
          .optional()
          .describe("Specific memory ID to delete"),
        type: z
          .enum([
            "decision",
            "insight",
            "context",
            "todo",
            "conversation",
            "note",
          ])
          .optional()
          .describe("Delete all memories of this type"),
        olderThanDays: z.coerce
          .number()
          .optional()
          .describe("Delete memories older than N days"),
      }),
      annotations: TOOL_ANNOTATIONS["forget"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const memoryId = args.memoryId as string | undefined;
        const type = args.type as string | undefined;
        const olderThanDays = args.olderThanDays as number | undefined;

        if (memoryId) {
          const response = await ctx.api.delete(
            `/api/memory/${memoryId}?projectName=${ctx.projectName}`,
          );
          return response.data.success
            ? `\u{1F5D1}\uFE0F Memory deleted: ${memoryId}`
            : `\u274C Failed to delete memory: ${memoryId}`;
        }

        if (type) {
          await ctx.api.delete(
            `/api/memory/type/${type}?projectName=${ctx.projectName}`,
          );
          return `\u{1F5D1}\uFE0F Deleted all memories of type: ${type}`;
        }

        if (olderThanDays) {
          const response = await ctx.api.post("/api/memory/forget-older", {
            projectName: ctx.projectName,
            olderThanDays,
          });
          return `\u{1F5D1}\uFE0F Deleted ${response.data.deleted} memories older than ${olderThanDays} days`;
        }

        return "Please specify memoryId, type, or olderThanDays to delete.";
      },
    },

    {
      name: "batch_remember",
      description: `Efficiently store multiple memories at once in ${projectName}. Faster than individual remember calls.`,
      schema: z.object({
        items: z
          .array(
            z.object({
              content: z.string().describe("Content to remember"),
              type: z
                .enum([
                  "decision",
                  "insight",
                  "context",
                  "todo",
                  "conversation",
                  "note",
                  "procedure",
                ])
                .optional()
                .describe("Memory type (default: note)"),
              tags: z
                .array(z.string())
                .optional()
                .describe("Tags for categorization"),
              relatedTo: z
                .string()
                .optional()
                .describe("Related feature or topic"),
              metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Custom metadata (factEntities, factDateTs, etc.)"),
              factCategory: z
                .enum([
                  "personal_info",
                  "preference",
                  "event",
                  "temporal",
                  "update",
                  "plan",
                ])
                .optional()
                .describe("Structured fact category for temporal retrieval"),
              factEntities: z
                .array(z.string())
                .optional()
                .describe(
                  "Named entities: file names, service names, external systems",
                ),
              factDateTs: z
                .number()
                .optional()
                .describe("Unix timestamp (seconds) for temporal filtering"),
              triggerDescription: z
                .string()
                .optional()
                .describe(
                  "WHEN to recall this memory — a retrieval cue embedded separately from the content. Improves recall matching.",
                ),
              pin: z
                .enum(["repo", "all"])
                .optional()
                .describe(
                  "Set pin when the user says 'always remember this' / 'load this every session'. 'repo' = always loaded for this project; 'all' = everywhere.",
                ),
            }),
          )
          .describe("Array of memories to store"),
      }),
      annotations: TOOL_ANNOTATIONS["batch_remember"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const items = args.items as Array<{
          content: string;
          type?: string;
          tags?: string[];
          relatedTo?: string;
          metadata?: Record<string, unknown>;
          factCategory?: string;
          factEntities?: string[];
          factDateTs?: number;
          // M2-6: forwarded as-is — batchItemSchema validates/stores both.
          triggerDescription?: string;
          pin?: "repo" | "all";
        }>;

        const response = await ctx.api.post("/api/memory/batch", {
          projectName: ctx.projectName,
          items,
        });

        const { savedCount, errors, memories } = response.data;

        let result = `# \u{1F4E6} Batch Memory Result\n\n`;
        result += `**Saved**: ${savedCount} memories\n\n`;

        if (memories && memories.length > 0) {
          result += `## Stored Memories\n`;
          memories.forEach(
            (m: { id: string; type: string; content: string }) => {
              result += `- [${m.type}] ${truncate(m.content, 80)}\n`;
              result += `  ID: \`${m.id}\`\n`;
            },
          );
        }

        if (errors && errors.length > 0) {
          result += `\n## \u26A0\uFE0F Errors\n`;
          errors.forEach((e: string) => {
            result += `- ${e}\n`;
          });
        }

        return result;
      },
    },

    {
      name: "review_memories",
      description: `Get auto-extracted memories pending review in ${projectName}. Shows unvalidated learnings that need human confirmation.`,
      schema: z.object({
        limit: z.coerce
          .number()
          .optional()
          .describe("Max memories to return (default: 20)"),
        offset: z.coerce
          .number()
          .optional()
          .describe("Pagination offset (default: 0)"),
      }),
      annotations: TOOL_ANNOTATIONS["review_memories"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const limit = (args.limit as number) || 20;
        const offset = (args.offset as number) || 0;

        const response = await ctx.api.get(
          `/api/memory/quarantine?limit=${limit}&offset=${offset}`,
        );
        const { memories, count } = response.data;

        if (count === 0) {
          return "No unvalidated memories to review. All auto-extracted learnings have been reviewed.";
        }

        let result = `# \u{1F4CB} Memories Pending Review (${count} total)\n\n`;
        result += `These are auto-extracted learnings that need validation.\n\n`;

        memories.forEach(
          (
            m: {
              id: string;
              type: string;
              content: string;
              confidence: number;
              source: string;
              tags: string[];
            },
            i: number,
          ) => {
            result += `## ${offset + i + 1}. ${m.type.toUpperCase()}\n`;
            result += `**ID**: \`${m.id}\`\n`;
            result += `**Confidence**: ${((m.confidence || 0) * 100).toFixed(0)}%\n`;
            result += `**Source**: ${m.source || "unknown"}\n`;
            result += `**Content**: ${m.content}\n`;
            if (m.tags && m.tags.length > 0) {
              result += `**Tags**: ${m.tags.join(", ")}\n`;
            }
            result += `\nTo keep: \`promote_memory(memoryId="${m.id}", reason="human_validated")\`\n`;
            result += `To reject: \`forget(memoryId="${m.id}")\`\n\n`;
          },
        );

        result += paginationFooter(memories.length, limit, offset);
        return result;
      },
    },

    {
      name: "promote_memory",
      description: `Promote a quarantine memory to durable storage in ${projectName}. Requires a reason for promotion. Optionally runs quality gates before promotion.`,
      schema: z.object({
        memoryId: z.string().describe("ID of the memory to promote"),
        reason: z
          .enum(["human_validated", "pr_merged", "tests_passed"])
          .describe("Reason for promotion"),
        evidence: z
          .string()
          .optional()
          .describe("Optional evidence supporting the promotion"),
        runGates: z
          .boolean()
          .optional()
          .describe("Run quality gates before promotion (default: false)"),
        affectedFiles: z
          .array(z.string())
          .optional()
          .describe(
            "Files affected by this memory (for quality gate checking)",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["promote_memory"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const memoryId = args.memoryId as string;
        const reason = args.reason as string;
        const evidence = args.evidence as string | undefined;
        const runGates = args.runGates as boolean | undefined;
        const affectedFiles = args.affectedFiles as string[] | undefined;

        const response = await ctx.api.post("/api/memory/promote", {
          projectName: ctx.projectName,
          memoryId,
          reason,
          evidence,
          runGates: runGates || false,
          projectPath: runGates ? ctx.projectPath : undefined,
          affectedFiles: runGates ? affectedFiles : undefined,
        });

        const { memory } = response.data;

        return (
          `\u2705 **Memory promoted to durable storage**\n\n` +
          `- **ID:** ${memory.id}\n` +
          `- **Type:** ${memory.type}\n` +
          `- **Reason:** ${reason}\n` +
          (evidence ? `- **Evidence:** ${evidence}\n` : "") +
          (runGates ? `- **Quality Gates:** passed\n` : "") +
          `- **Content:** ${truncate(memory.content, 200)}`
        );
      },
    },
  ];
}
