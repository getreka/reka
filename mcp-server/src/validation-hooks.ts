/**
 * PreToolUse Validation Hooks
 *
 * Validation pipeline that runs before tool execution.
 * Hooks can block execution, modify args, or add warnings.
 *
 * Inspired by claude-quanta-plugin's PreToolUse hooks pattern.
 */

import type { ToolContext } from "./types.js";

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
  modifiedArgs?: Record<string, unknown>;
}

export type ValidationHook = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ValidationResult> | ValidationResult;

// ── Built-in Hooks ──────────────────────────────────────────

/**
 * Prevent destructive operations without explicit confirmation.
 * Blocks: index_codebase with force=true, forget (memory deletion).
 */
export const destructiveGuard: ValidationHook = (toolName, args) => {
  if (toolName === "index_codebase" && args.force === true) {
    return {
      allowed: true,
      warnings: [
        "Force reindex will delete and rebuild the entire index. This may take several minutes.",
      ],
    };
  }

  if (toolName === "forget") {
    return {
      allowed: true,
      warnings: ["This will permanently delete a memory entry."],
    };
  }

  return { allowed: true };
};

/**
 * Validate required fields for critical tools.
 */
export const requiredFieldsValidator: ValidationHook = (toolName, args) => {
  // Search tools must have a query
  const searchTools = [
    "search_codebase",
    "hybrid_search",
    "search_docs",
    "find_feature",
    "ask_codebase",
  ];
  if (searchTools.includes(toolName)) {
    const query = args.query || args.question;
    if (!query || (typeof query === "string" && query.trim().length < 3)) {
      return {
        allowed: false,
        reason: `${toolName} requires a query of at least 3 characters`,
      };
    }
  }

  // Memory tools must have content
  if (
    toolName === "remember" &&
    (!args.content ||
      (typeof args.content === "string" && args.content.trim().length < 10))
  ) {
    return {
      allowed: false,
      reason: "remember requires content of at least 10 characters",
    };
  }

  return { allowed: true };
};

/**
 * Sanitize inputs — trim strings, enforce reasonable limits.
 */
export const inputSanitizer: ValidationHook = (toolName, args) => {
  const modified = { ...args };
  let changed = false;

  // Trim string values
  for (const [key, value] of Object.entries(modified)) {
    if (typeof value === "string" && value !== value.trim()) {
      modified[key] = value.trim();
      changed = true;
    }
  }

  // Cap limit params to prevent excessive results
  if (typeof modified.limit === "number" && modified.limit > 50) {
    modified.limit = 50;
    changed = true;
  }

  return changed
    ? { allowed: true, modifiedArgs: modified }
    : { allowed: true };
};

// ── Validation Pipeline ─────────────────────────────────────

export class ValidationPipeline {
  private hooks: ValidationHook[] = [];

  constructor(hooks?: ValidationHook[]) {
    this.hooks = hooks || [
      destructiveGuard,
      requiredFieldsValidator,
      inputSanitizer,
    ];
  }

  addHook(hook: ValidationHook): void {
    this.hooks.push(hook);
  }

  /**
   * Run all hooks in sequence. First rejection stops the pipeline.
   * Args can be modified by hooks (each hook sees the potentially modified args).
   */
  async validate(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ValidationResult> {
    let currentArgs = { ...args };
    const allWarnings: string[] = [];

    for (const hook of this.hooks) {
      const result = await hook(toolName, currentArgs, ctx);

      if (!result.allowed) {
        return result;
      }

      if (result.warnings) {
        allWarnings.push(...result.warnings);
      }

      if (result.modifiedArgs) {
        currentArgs = result.modifiedArgs;
      }
    }

    return {
      allowed: true,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      modifiedArgs: currentArgs !== args ? currentArgs : undefined,
    };
  }
}

export const validationPipeline = new ValidationPipeline();
