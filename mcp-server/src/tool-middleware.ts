/**
 * Tool Middleware — standalone middleware functions for MCP tool handlers.
 *
 * Extracted from ToolRegistry.handle() so that McpServer.registerTool()
 * (Phase 3) can reuse the same pipeline:
 *   auto-session → enrichment.before → handler → enrichment.after → trackUsage
 *
 * During Phase 2 migration, ToolRegistry continues to use its own copy.
 * Phase 3 replaces ToolRegistry with wrapHandler() + McpServer.registerTool().
 */

import type { ToolContext, ToolHandler } from "./types.js";
import type { ContextEnricher } from "./context-enrichment.js";

// ── Timeouts ────────────────────────────────────────────────

/** Default tool timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-tool timeout overrides (ms) */
export const TOOL_TIMEOUTS: Record<string, number> = {
  // Indexing / heavy analysis — up to 2 min
  index_codebase: 120_000,
  reindex_zero_downtime: 120_000,
  cluster_code: 60_000,
  find_duplicates: 60_000,
  run_quality_gates: 60_000,
  analyze_project_structure: 60_000,
  estimate_feature: 60_000,
  // Quick search — 15 s
  search_codebase: 15_000,
  hybrid_search: 15_000,
  search_similar: 15_000,
  search_graph: 15_000,
  grouped_search: 15_000,
  search_docs: 10_000,
  find_symbol: 10_000,
  // Memory / recall — 10 s
  recall: 10_000,
  remember: 10_000,
  context_briefing: 15_000,
};

/** Race a promise against a timeout */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool '${name}' timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Constants ───────────────────────────────────────────────

/** Tools excluded from usage tracking (meta/admin, avoid recursion) */
export const TRACKING_EXCLUDE = new Set([
  "get_tool_analytics",
  "get_knowledge_gaps",
  "analyze_usage_patterns",
  "get_behavior_patterns",
  "get_quality_metrics",
  "get_cache_stats",
  "get_prediction_stats",
  "get_rag_guidelines",
]);

/** Session management tools — skip auto-session to avoid recursion */
export const SESSION_TOOLS = new Set([
  "start_session",
  "end_session",
  "get_session_context",
]);

// ── Helpers ─────────────────────────────────────────────────

/** Summarize tool args into a short string for analytics */
export function summarizeInput(
  name: string,
  args: Record<string, unknown>
): string {
  const q =
    args.query || args.question || args.feature || args.description || args.task || "";
  if (q && typeof q === "string") return q.slice(0, 200);

  const content = args.content || args.code || args.diff || "";
  if (content && typeof content === "string") return content.slice(0, 100);

  const file = args.file || args.filePath || args.currentFile || "";
  if (file && typeof file === "string") return file as string;

  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return v.slice(0, 150);
  }
  return name;
}

/** Count results from a tool response string */
export function countResults(result: string): number {
  if (
    result.includes("No results") ||
    result.includes("No matches") ||
    result.includes("not found")
  )
    return 0;
  const numbered = result.match(/^\d+\./gm);
  if (numbered) return numbered.length;
  const bullets = result.match(/^[-*] /gm);
  if (bullets) return bullets.length;
  return 1;
}

// ── Session management ──────────────────────────────────────

/** Shared lock to prevent concurrent auto-session starts */
let autoSessionPromise: Promise<void> | null = null;

/** Auto-start a session via the RAG API if none is active */
export async function ensureSession(ctx: ToolContext): Promise<void> {
  if (ctx.activeSessionId) return;

  if (autoSessionPromise) {
    await autoSessionPromise;
    return;
  }

  autoSessionPromise = doAutoStartSession(ctx);
  try {
    await autoSessionPromise;
  } finally {
    autoSessionPromise = null;
  }
}

async function doAutoStartSession(ctx: ToolContext): Promise<void> {
  try {
    const response = await ctx.api.post("/api/session/start", {
      projectName: ctx.projectName,
      initialContext: "auto-started by MCP tool call",
    });
    const session = response.data?.session;
    const sid = session?.sessionId || response.data?.sessionId;
    if (sid) {
      ctx.activeSessionId = sid;
    }

    // Fire-and-forget: ensure critical collections exist
    ctx.api
      .post("/api/ensure-collections", { projectName: ctx.projectName })
      .catch(() => {});
  } catch {
    // Silent — auto-session must never block tool execution
  }
}

// ── Usage tracking ──────────────────────────────────────────

/** Fire-and-forget usage tracking */
export function trackUsage(
  name: string,
  args: Record<string, unknown>,
  startTime: number,
  success: boolean,
  result: string,
  errorMessage: string | undefined,
  ctx: ToolContext
): void {
  if (TRACKING_EXCLUDE.has(name)) return;

  ctx.api
    .post("/api/track-usage", {
      projectName: ctx.projectName,
      sessionId: ctx.activeSessionId,
      toolName: name,
      inputSummary: summarizeInput(name, args),
      startTime,
      resultCount: success ? countResults(result) : 0,
      success,
      errorMessage,
    })
    .catch(() => {});
}

// ── Error formatting ────────────────────────────────────────

/** Format an error caught during tool execution */
export function formatToolError(error: unknown, ctx: ToolContext): string {
  const err = error as {
    code?: string;
    response?: { status: number; data: unknown };
    message?: string;
  };

  if (err.code === "ECONNREFUSED") {
    return (
      `Error: Cannot connect to RAG API at ${ctx.api.defaults.baseURL}. Is it running?\n` +
      `Start with: cd docker && docker-compose up -d`
    );
  }
  if (err.response) {
    return `API Error (${err.response.status}): ${JSON.stringify(err.response.data)}`;
  }
  return `Error: ${err.message || String(error)}`;
}

// ── Handler wrapper ─────────────────────────────────────────

export interface MiddlewareDeps {
  enricher?: ContextEnricher;
  ctx: ToolContext;
}

/**
 * Wrap a raw ToolHandler with the full middleware pipeline:
 * auto-session → enrichment.before → handler → enrichment.after → trackUsage
 *
 * Returns a ToolHandler with the same signature, so it works both
 * with the legacy ToolRegistry and the Phase 3 McpServer adapter.
 */
export function wrapHandler(
  name: string,
  handler: ToolHandler,
  deps: MiddlewareDeps
): ToolHandler {
  return async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    // Auto-start session (skip for session management tools)
    if (!SESSION_TOOLS.has(name)) {
      await ensureSession(ctx);
    }

    const startTime = Date.now();

    try {
      // Before: auto-enrich context
      const contextPrefix =
        ctx.enrichmentEnabled && deps.enricher
          ? await deps.enricher.before(name, args, ctx)
          : null;

      // Execute original handler (with timeout)
      const timeoutMs = TOOL_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;
      const result = await withTimeout(handler(args, ctx), timeoutMs, name);

      // After: track interaction (fire-and-forget)
      if (deps.enricher) {
        deps.enricher.after(name, args, result, ctx);
      }

      // Track usage (fire-and-forget)
      trackUsage(name, args, startTime, true, result, undefined, ctx);

      // Prepend context if available
      return contextPrefix ? contextPrefix + "\n\n" + result : result;
    } catch (error: unknown) {
      const errorMessage = formatToolError(error, ctx);

      // Track failed usage (fire-and-forget)
      trackUsage(name, args, startTime, false, "", errorMessage, ctx);

      return errorMessage;
    }
  };
}
