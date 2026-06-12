/**
 * memory-tool module — the `memory` tool (memory_20250818 surface over MCP).
 *
 * One tool, six commands (view | create | str_replace | insert | delete |
 * rename), mirroring Anthropic's client-side memory tool so the model's
 * RL-trained triggering transfers. The flat schema below is structurally
 * identical to memory_20250818's command union; per-command required-field
 * validation returns error STRINGS (the memory-tool contract: handlers never
 * throw, the model reads the error text and self-corrects).
 *
 * Backed by {@link MemoryToolAdapter}: writes are attributed
 * (source 'auto_memory_tool') and QUARANTINED by governance — visible to
 * path-based `view` (read-your-writes) but excluded from semantic `recall`
 * until promoted.
 */

import { z } from "zod";
import type { ToolSpec, ToolContext } from "../types.js";
import { TOOL_ANNOTATIONS } from "../annotations.js";
import {
  MemoryToolAdapter,
  type MemoryCommand,
} from "../memory-tool-adapter.js";

/** Required fields per memory_20250818 command. */
const REQUIRED_FIELDS: Record<MemoryCommand["command"], string[]> = {
  view: ["path"],
  create: ["path", "file_text"],
  str_replace: ["path", "old_str", "new_str"],
  insert: ["path", "insert_line", "insert_text"],
  delete: ["path"],
  rename: ["old_path", "new_path"],
};

/**
 * Validate per-command required fields. Returns an error STRING (never
 * throws) or null when the args are valid — the memory-tool contract is that
 * the model reads tool-result error text and retries with corrected args.
 *
 * Note: 0 is a valid insert_line, so only undefined/null/'' count as missing.
 */
export function validateMemoryArgs(
  args: Record<string, unknown>,
): string | null {
  const command = args.command as MemoryCommand["command"] | undefined;
  const required = command ? REQUIRED_FIELDS[command] : undefined;
  if (!required) {
    return `Error: unsupported memory command "${String(args.command)}". Valid commands: view, create, str_replace, insert, delete, rename.`;
  }
  const missing = required.filter(
    (f) => args[f] === undefined || args[f] === null || args[f] === "",
  );
  if (missing.length > 0) {
    return `Error: missing required parameter${missing.length > 1 ? "s" : ""} ${missing
      .map((m) => `'${m}'`)
      .join(", ")} for the '${command}' command.`;
  }
  return null;
}

export function createMemoryToolTools(_projectName: string): ToolSpec[] {
  return [
    {
      name: "memory",
      description:
        "Call this to read and write your persistent memory files for this project: " +
        "view a directory or file, create, str_replace, insert, delete, rename — paths " +
        "live under /memories (e.g. /memories/decisions.md). Call it when you learn " +
        "something worth keeping across sessions (a decision, a gotcha, a procedure) " +
        "and to re-read your notes before relying on past context. " +
        "This is NOT the host's local /memories directory: it is Reka's project-scoped, " +
        "governed, server-side memory — it survives machines and sessions. New writes " +
        "are quarantined for review: your own path-based view sees them immediately, " +
        "but they only enter semantic recall once promoted.",
      schema: z.object({
        command: z
          .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
          .describe("The memory operation to run."),
        path: z
          .string()
          .optional()
          .describe(
            "Path to the memory file or directory (e.g. '/memories' or '/memories/auth.md'). Required for view, create, str_replace, insert and delete.",
          ),
        file_text: z
          .string()
          .optional()
          .describe("Content to write to the file (create)."),
        old_str: z
          .string()
          .optional()
          .describe("Exact text to find and replace (str_replace)."),
        new_str: z
          .string()
          .optional()
          .describe("Replacement text (str_replace)."),
        insert_line: z.coerce
          .number()
          .int()
          .optional()
          .describe("Line number to insert at (insert)."),
        insert_text: z
          .string()
          .optional()
          .describe("Text to insert at the given line (insert)."),
        view_range: z
          .array(z.coerce.number().int())
          .length(2)
          .optional()
          .describe(
            "[start, end] 1-based line range when viewing a file; end -1 reads to EOF (view).",
          ),
        old_path: z
          .string()
          .optional()
          .describe("Current path of the file or directory (rename)."),
        new_path: z
          .string()
          .optional()
          .describe("New path for the file or directory (rename)."),
      }),
      annotations: TOOL_ANNOTATIONS["memory"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const invalid = validateMemoryArgs(args);
        if (invalid) return invalid;

        // PER-CALL adapter: PROJECT_NAME resolves asynchronously via
        // /api/whoami (index.ts resolveProject) and ctx.projectName is mutated
        // in place — a module-level adapter instance created at import time
        // would freeze the 'resolving' placeholder forever.
        const adapter = new MemoryToolAdapter(ctx.api, ctx.projectName);

        try {
          return await adapter.handle(args as unknown as MemoryCommand);
        } catch (err) {
          // memory-tool contract: never throw — return the error as text so
          // the model can read it and self-correct.
          const msg = err instanceof Error ? err.message : String(err);
          return `Error: memory ${String(args.command)} failed: ${msg}`;
        }
      },
    },
  ];
}
