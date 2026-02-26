/**
 * Memory tools module - Agent memory management tools.
 *
 * Tools: remember, recall, list_memories, forget, update_todo,
 *        batch_remember, validate_memory, review_memories,
 *        promote_memory, run_quality_gates, memory_maintenance
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { formatMemoryResults, truncate, paginationFooter, PREVIEW } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

const typeEmojis: Record<string, string> = {
  decision: "\u{1F3AF}",
  insight: "\u{1F4A1}",
  context: "\u{1F4CC}",
  todo: "\u{1F4CB}",
  conversation: "\u{1F4AC}",
  note: "\u{1F4DD}",
};

const statusEmojis: Record<string, string> = {
  pending: "\u23F3",
  in_progress: "\u{1F504}",
  done: "\u2705",
  cancelled: "\u274C",
};

export function createMemoryTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "remember",
      description:
        "Store important information in agent memory. Use this to save decisions, insights, context, todos, or important conversations for future reference.",
      schema: z.object({
        content: z.string().describe("Information to remember"),
        type: z.enum(["decision", "insight", "context", "todo", "conversation", "note"]).optional().describe("Type of memory (default: note)"),
        tags: z.array(z.string()).optional().describe("Tags for categorization (e.g., ['feature-x', 'important'])"),
        relatedTo: z.string().optional().describe("Related feature or topic"),
      }),
      annotations: TOOL_ANNOTATIONS["remember"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const content = args.content as string;
        const type = (args.type as string) || "note";
        const tags = (args.tags as string[]) || [];
        const relatedTo = args.relatedTo as string | undefined;

        const response = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          content,
          type,
          tags,
          relatedTo,
        });

        const memory = response.data.memory;
        return (
          `\u2705 **Memory stored**\n\n` +
          `- **ID:** ${memory.id}\n` +
          `- **Type:** ${memory.type}\n` +
          `- **Content:** ${truncate(content, 200)}\n` +
          (tags.length > 0 ? `- **Tags:** ${tags.join(", ")}\n` : "") +
          (relatedTo ? `- **Related to:** ${relatedTo}\n` : "") +
          `- **Created:** ${new Date(memory.createdAt).toLocaleString()}`
        );
      },
    },

    {
      name: "recall",
      description:
        "Retrieve relevant memories based on context. Searches agent memory for past decisions, insights, and notes related to the query.",
      schema: z.object({
        query: z.string().describe("What to recall (semantic search)"),
        type: z.enum(["decision", "insight", "context", "todo", "conversation", "note", "all"]).optional().describe("Filter by memory type (default: all)"),
        limit: z.number().optional().describe("Max memories to retrieve (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["recall"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const query = args.query as string;
        const type = (args.type as string) || "all";
        const limit = (args.limit as number) || 5;

        const response = await ctx.api.post("/api/memory/recall", {
          projectName: ctx.projectName,
          query,
          type,
          limit,
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
        type: z.enum(["decision", "insight", "context", "todo", "conversation", "note", "all"]).optional().describe("Filter by type"),
        tag: z.string().optional().describe("Filter by tag"),
        limit: z.number().optional().describe("Max results (default: 10)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
      }),
      annotations: TOOL_ANNOTATIONS["list_memories"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
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
        memoryId: z.string().optional().describe("Specific memory ID to delete"),
        type: z.enum(["decision", "insight", "context", "todo", "conversation", "note"]).optional().describe("Delete all memories of this type"),
        olderThanDays: z.number().optional().describe("Delete memories older than N days"),
      }),
      annotations: TOOL_ANNOTATIONS["forget"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const memoryId = args.memoryId as string | undefined;
        const type = args.type as string | undefined;

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

        return "Please specify memoryId or type to delete.";
      },
    },

    {
      name: "update_todo",
      description: "Update status of a todo/task in memory.",
      schema: z.object({
        todoId: z.string().describe("Todo memory ID"),
        status: z.enum(["pending", "in_progress", "done", "cancelled"]).describe("New status"),
        note: z.string().optional().describe("Optional note about the update"),
      }),
      annotations: TOOL_ANNOTATIONS["update_todo"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const todoId = args.todoId as string;
        const status = args.status as string;
        const note = args.note as string | undefined;

        const response = await ctx.api.patch(`/api/memory/todo/${todoId}`, {
          projectName: ctx.projectName,
          status,
          note,
        });

        if (!response.data.memory) {
          return `\u274C Todo not found: ${todoId}`;
        }

        return (
          `${statusEmojis[status] || "\u{1F4CB}"} **Todo updated**\n\n` +
          `- **ID:** ${todoId}\n` +
          `- **Status:** ${status}\n` +
          (note ? `- **Note:** ${note}\n` : "") +
          `- **Content:** ${response.data.memory.content}`
        );
      },
    },

    {
      name: "batch_remember",
      description: `Efficiently store multiple memories at once in ${projectName}. Faster than individual remember calls.`,
      schema: z.object({
        items: z.array(z.object({
          content: z.string().describe("Content to remember"),
          type: z.enum(["decision", "insight", "context", "todo", "conversation", "note"]).optional().describe("Memory type (default: note)"),
          tags: z.array(z.string()).optional().describe("Tags for categorization"),
          relatedTo: z.string().optional().describe("Related feature or topic"),
        })).describe("Array of memories to store"),
      }),
      annotations: TOOL_ANNOTATIONS["batch_remember"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const items = args.items as Array<{
          content: string;
          type?: string;
          tags?: string[];
          relatedTo?: string;
        }>;

        const response = await ctx.api.post("/api/memory/batch", {
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
      name: "validate_memory",
      description: `Validate or reject an auto-extracted memory in ${projectName}. Helps improve future extraction accuracy.`,
      schema: z.object({
        memoryId: z.string().describe("ID of the memory to validate"),
        validated: z.boolean().describe("true to confirm the memory is valuable, false to reject it"),
      }),
      annotations: TOOL_ANNOTATIONS["validate_memory"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const memoryId = args.memoryId as string;
        const validated = args.validated as boolean;

        const response = await ctx.api.patch(
          `/api/memory/${memoryId}/validate`,
          {
            validated,
          },
        );

        const { memory } = response.data;

        return (
          `\u2705 Memory ${validated ? "validated" : "rejected"}\n\n` +
          `- **ID**: ${memory.id}\n` +
          `- **Type**: ${memory.type}\n` +
          `- **Content**: ${truncate(memory.content, PREVIEW.SHORT)}\n` +
          `- **Validated**: ${memory.validated}`
        );
      },
    },

    {
      name: "review_memories",
      description: `Get auto-extracted memories pending review in ${projectName}. Shows unvalidated learnings that need human confirmation.`,
      schema: z.object({
        limit: z.number().optional().describe("Max memories to return (default: 20)"),
        offset: z.number().optional().describe("Pagination offset (default: 0)"),
      }),
      annotations: TOOL_ANNOTATIONS["review_memories"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
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
            result += `\nTo validate: \`validate_memory(memoryId="${m.id}", validated=true)\`\n`;
            result += `To reject: \`validate_memory(memoryId="${m.id}", validated=false)\`\n\n`;
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
        reason: z.enum(["human_validated", "pr_merged", "tests_passed"]).describe("Reason for promotion"),
        evidence: z.string().optional().describe("Optional evidence supporting the promotion"),
        runGates: z.boolean().optional().describe("Run quality gates before promotion (default: false)"),
        affectedFiles: z.array(z.string()).optional().describe("Files affected by this memory (for quality gate checking)"),
      }),
      annotations: TOOL_ANNOTATIONS["promote_memory"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
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

    {
      name: "run_quality_gates",
      description: `Run quality gates (typecheck, tests, blast radius) for ${projectName}.`,
      schema: z.object({
        affectedFiles: z.array(z.string()).optional().describe("Files to check (for related tests and blast radius)"),
        skipGates: z.array(z.string()).optional().describe("Gates to skip (typecheck, test, blast_radius)"),
      }),
      annotations: TOOL_ANNOTATIONS["run_quality_gates"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const affectedFiles = args.affectedFiles as string[] | undefined;
        const skipGates = args.skipGates as string[] | undefined;

        const response = await ctx.api.post("/api/quality/run", {
          projectName: ctx.projectName,
          projectPath: ctx.projectPath,
          affectedFiles,
          skipGates,
        });

        const report = response.data;
        let result = `**Quality Report**: ${report.passed ? "\u2705 All gates passed" : "\u274C Some gates failed"}\n\n`;

        for (const gate of report.gates) {
          const icon = gate.passed ? "\u2705" : "\u274C";
          result += `${icon} **${gate.gate}** (${(gate.duration / 1000).toFixed(1)}s)\n`;
          result += `   ${gate.details.slice(0, 500)}\n\n`;
        }

        if (report.blastRadius) {
          result += `\n**Blast Radius**: ${report.blastRadius.affectedFiles.length} files, depth ${report.blastRadius.depth}\n`;
          if (report.blastRadius.affectedFiles.length > 0) {
            result += report.blastRadius.affectedFiles
              .slice(0, 10)
              .map((f: string) => `  - ${f}`)
              .join("\n");
            if (report.blastRadius.affectedFiles.length > 10) {
              result += `\n  ... and ${report.blastRadius.affectedFiles.length - 10} more`;
            }
          }
        }

        return result;
      },
    },

    {
      name: "memory_maintenance",
      description: `Run feedback-driven memory maintenance for ${projectName}: auto-promote memories with 3+ positive feedback, auto-prune memories with 2+ incorrect feedback.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["memory_maintenance"],
      handler: async (_args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const response = await ctx.api.post("/api/memory/maintenance", {
          projectName: ctx.projectName,
        });

        const { promoted, pruned, errors } = response.data;
        let result = `# \u{1F9F9} Memory Maintenance Results\n\n`;

        if (promoted.length > 0) {
          result += `**Promoted** (${promoted.length}): memories with 3+ positive feedback moved to durable\n`;
          promoted.forEach((id: string) => { result += `  \u2705 ${id}\n`; });
          result += `\n`;
        }

        if (pruned.length > 0) {
          result += `**Pruned** (${pruned.length}): memories with 2+ incorrect feedback removed\n`;
          pruned.forEach((id: string) => { result += `  \u{1F5D1}\u{FE0F} ${id}\n`; });
          result += `\n`;
        }

        if (errors.length > 0) {
          result += `**Errors** (${errors.length}):\n`;
          errors.forEach((e: string) => { result += `  \u26A0\u{FE0F} ${e}\n`; });
          result += `\n`;
        }

        if (promoted.length === 0 && pruned.length === 0) {
          result += `No memories needed maintenance. All feedback thresholds are below auto-action levels.\n`;
        }

        return result;
      },
    },
  ];
}
