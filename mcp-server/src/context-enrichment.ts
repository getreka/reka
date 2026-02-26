/**
 * Context Enrichment Middleware
 *
 * Automatically enriches MCP tool responses with relevant project context
 * (memories, patterns, ADRs) by performing semantic recall before each tool call.
 */

import type { ToolContext } from "./types.js";

export interface EnrichmentConfig {
  enrichableTools: Set<string>;
  skipTools: Set<string>;
  maxAutoRecall: number;
  minRelevance: number;
  timeoutMs: number;
}

interface RecalledMemory {
  type: string;
  content: string;
  score: number;
}

/**
 * Default sets of tools that should/shouldn't be enriched.
 */
export const DEFAULT_ENRICHABLE_TOOLS = new Set([
  "search_codebase",
  "hybrid_search",
  "ask_codebase",
  "explain_code",
  "find_feature",
  "review_code",
  "generate_tests",
  "suggest_implementation",
  "suggest_related_code",
  "check_architecture",
  "context_briefing",
  "run_agent",
]);

export const DEFAULT_SKIP_TOOLS = new Set([
  "get_cache_stats",
  "warm_cache",
  "get_prediction_stats",
  "get_tool_analytics",
  "list_aliases",
  "backup_collection",
  "enable_quantization",
  "list_backups",
  "get_index_status",
  "get_project_stats",
  "get_rag_guidelines",
  "list_memories",
  "get_behavior_patterns",
  "merge_memories",
  "feedback_search",
  "feedback_memory",
  "get_quality_metrics",
  "get_knowledge_gaps",
  "get_agent_types",
  "get_platform_stats",
]);

export class ContextEnricher {
  private config: EnrichmentConfig;

  constructor(config: Partial<EnrichmentConfig> = {}) {
    this.config = {
      enrichableTools: config.enrichableTools ?? DEFAULT_ENRICHABLE_TOOLS,
      skipTools: config.skipTools ?? DEFAULT_SKIP_TOOLS,
      maxAutoRecall: config.maxAutoRecall ?? 3,
      minRelevance: config.minRelevance ?? 0.6,
      timeoutMs: config.timeoutMs ?? 2000,
    };
  }

  /**
   * Before hook: auto-recall relevant memories/patterns/ADRs.
   * Returns a context prefix string or null if nothing relevant found.
   */
  async before(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<string | null> {
    // Skip non-enrichable tools
    if (this.config.skipTools.has(name)) return null;
    if (!this.config.enrichableTools.has(name)) return null;

    // Extract semantic query from args
    const query = this.extractQuery(args);
    if (!query) return null;

    try {
      const memories = await this.recallWithTimeout(query, ctx);
      if (memories.length === 0) return null;

      return this.formatContext(memories);
    } catch {
      // Enrichment should never break tool calls
      return null;
    }
  }

  /**
   * After hook: fire-and-forget session activity tracking + implicit feedback.
   */
  after(
    name: string,
    args: Record<string, unknown>,
    result: string,
    ctx: ToolContext
  ): void {
    // Session activity tracking
    if (ctx.activeSessionId) {
      ctx.api
        .post(`/api/session/${ctx.activeSessionId}/activity`, {
          projectName: ctx.projectName,
          type: "tool",
          value: name,
        })
        .catch(() => {});
    }

    // Implicit positive feedback for enrichable search tools
    if (this.config.enrichableTools.has(name)) {
      const query = this.extractQuery(args);
      if (
        query &&
        result &&
        !result.includes("No results") &&
        !result.includes("not found") &&
        !result.includes("No relevant context found")
      ) {
        // Count approximate results for weighted feedback
        const numbered = result.match(/^\d+\./gm);
        const bullets = result.match(/^[-*] /gm);
        const resultCount = numbered?.length ?? bullets?.length ?? 1;

        ctx.api
          .post("/api/feedback/search", {
            projectName: ctx.projectName,
            query,
            feedbackType: "helpful",
            toolName: name,
            resultCount,
            sessionId: ctx.activeSessionId,
          })
          .catch(() => {});
      }
    }
  }

  /**
   * Extract a semantic query string from tool arguments.
   */
  private extractQuery(args: Record<string, unknown>): string | null {
    // Try common argument patterns in priority order
    if (typeof args.query === "string" && args.query.length > 0) {
      return args.query;
    }
    if (typeof args.question === "string" && args.question.length > 0) {
      return args.question;
    }
    if (typeof args.description === "string" && args.description.length > 0) {
      return args.description;
    }
    if (typeof args.feature === "string" && args.feature.length > 0) {
      return args.feature;
    }
    if (typeof args.task === "string" && args.task.length > 0) {
      return args.task;
    }
    if (typeof args.code === "string" && args.code.length > 0) {
      return args.code.slice(0, 200);
    }
    return null;
  }

  /**
   * Recall memories with a hard timeout.
   */
  private async recallWithTimeout(
    query: string,
    ctx: ToolContext
  ): Promise<RecalledMemory[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      // Parallel recall: general memories + decisions/ADRs
      const [memoriesRes, decisionsRes] = await Promise.all([
        ctx.api
          .post(
            "/api/memory/recall-durable",
            {
              projectName: ctx.projectName,
              query,
              limit: this.config.maxAutoRecall,
              type: "all",
            },
            { signal: controller.signal }
          )
          .catch(() => null),
        ctx.api
          .post(
            "/api/memory/recall-durable",
            {
              projectName: ctx.projectName,
              query,
              limit: 2,
              type: "decision",
            },
            { signal: controller.signal }
          )
          .catch(() => null),
      ]);

      const memories: RecalledMemory[] = [];
      const seenIds = new Set<string>();

      // Process general memories
      if (memoriesRes?.data?.memories) {
        for (const m of memoriesRes.data.memories) {
          if (m.score >= this.config.minRelevance && !seenIds.has(m.memory?.id)) {
            seenIds.add(m.memory?.id);
            memories.push({
              type: m.memory?.type || "note",
              content: m.memory?.content || "",
              score: m.score,
            });
          }
        }
      }

      // Process decisions/ADRs
      if (decisionsRes?.data?.memories) {
        for (const m of decisionsRes.data.memories) {
          if (m.score >= this.config.minRelevance && !seenIds.has(m.memory?.id)) {
            seenIds.add(m.memory?.id);
            memories.push({
              type: m.memory?.type || "decision",
              content: m.memory?.content || "",
              score: m.score,
            });
          }
        }
      }

      return memories.slice(0, this.config.maxAutoRecall + 2);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Format recalled memories into a compact context prefix.
   */
  private formatContext(memories: RecalledMemory[]): string {
    const lines = memories.map(
      (m) => `- [${m.type}] ${m.content.slice(0, 150).replace(/\n/g, " ")}`
    );
    return `--- Project Context ---\n${lines.join("\n")}\n---`;
  }
}
