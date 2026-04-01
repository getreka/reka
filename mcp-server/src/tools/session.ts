/**
 * Session tools module - context summarization, session lifecycle management,
 * change tracking, and usage pattern analysis.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { truncate } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the session tools module with project-specific descriptions.
 * Accepts a mutable ctx reference to update activeSessionId on start/end.
 */
export function createSessionTools(
  projectName: string,
  sharedCtx?: ToolContext,
): ToolSpec[] {
  return [
    {
      name: "summarize_context",
      description: `Summarize the current working context for ${projectName}. Shows recently used tools, active features, recent queries, and suggested next steps.`,
      schema: z.object({
        sessionId: z
          .string()
          .optional()
          .describe(
            "Session ID to get context for. If omitted, returns the latest context.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["summarize_context"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId } = args as { sessionId?: string };
        const params = sessionId ? `?sessionId=${sessionId}` : "";
        const response = await ctx.api.get(
          `/api/context/${ctx.projectName}${params}`,
        );
        const data = response.data;

        let result = `**Context Summary for ${ctx.projectName}**\n\n`;

        if (data.recentTools && data.recentTools.length > 0) {
          result += `**Recently Used Tools:**\n`;
          result += data.recentTools.map((t: string) => `- ${t}`).join("\n");
          result += "\n\n";
        }

        if (data.activeFeatures && data.activeFeatures.length > 0) {
          result += `**Active Features:**\n`;
          result += data.activeFeatures.map((f: string) => `- ${f}`).join("\n");
          result += "\n\n";
        }

        if (data.recentQueries && data.recentQueries.length > 0) {
          const queries = data.recentQueries.slice(0, 5);
          result += `**Recent Queries:**\n`;
          result += queries
            .map((q: string) => `- ${truncate(q, 80)}`)
            .join("\n");
          result += "\n\n";
        }

        if (data.suggestedNextSteps && data.suggestedNextSteps.length > 0) {
          result += `**Suggested Next Steps:**\n`;
          result += data.suggestedNextSteps
            .map((s: string, i: number) => `${i + 1}. ${s}`)
            .join("\n");
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "summarize_changes",
      description: `Summarize changes made during a session for ${projectName}. Shows what was modified, tools used, and key actions taken.`,
      schema: z.object({
        sessionId: z.string().describe("Session ID to summarize changes for."),
        includeCode: z
          .boolean()
          .optional()
          .describe(
            "Whether to include code snippets in the summary (default: false).",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["summarize_changes"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId, includeCode } = args as {
          sessionId: string;
          includeCode?: boolean;
        };
        const params = includeCode ? "?includeCode=true" : "";
        const response = await ctx.api.get(
          `/api/changes/${ctx.projectName}/${sessionId}${params}`,
        );
        const data = response.data;

        let result = `**Changes Summary for Session ${sessionId}**\n\n`;

        if (data.summary) {
          result += `${data.summary}\n\n`;
        }

        if (data.duration !== undefined) {
          result += `**Duration:** ${data.duration} minutes\n`;
        }

        if (data.toolsUsed && data.toolsUsed.length > 0) {
          result += `**Tools Used:** ${data.toolsUsed.join(", ")}\n`;
        }

        if (data.filesAffected && data.filesAffected.length > 0) {
          const files = data.filesAffected.slice(0, 10);
          result += `\n**Files Affected:**\n`;
          result += files.map((f: string) => `- ${f}`).join("\n");
          if (data.filesAffected.length > 10) {
            result += `\n- ... and ${data.filesAffected.length - 10} more`;
          }
          result += "\n";
        }

        if (data.keyActions && data.keyActions.length > 0) {
          result += `\n**Key Actions:**\n`;
          result += data.keyActions
            .map((a: string, i: number) => `${i + 1}. ${a}`)
            .join("\n");
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "analyze_usage_patterns",
      description: `Analyze tool usage patterns for ${projectName}. Shows common workflows, detected patterns, and recommendations for improving productivity.`,
      schema: z.object({
        days: z.coerce
          .number()
          .optional()
          .describe("Number of days to analyze (default: 7)."),
      }),
      annotations: TOOL_ANNOTATIONS["analyze_usage_patterns"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { days = 7 } = args as { days?: number };
        const response = await ctx.api.get(
          `/api/patterns/${ctx.projectName}?days=${days}`,
        );
        const data = response.data;

        let result = `**Usage Patterns for ${ctx.projectName}** (last ${days} days)\n\n`;

        if (data.insights && data.insights.length > 0) {
          result += `**Insights:**\n`;
          result += data.insights
            .map((insight: string) => `- ${insight}`)
            .join("\n");
          result += "\n\n";
        }

        if (data.commonWorkflows && data.commonWorkflows.length > 0) {
          result += `**Common Workflows:**\n`;
          result += data.commonWorkflows
            .map(
              (w: { tools: string[]; count: number; successRate: number }) =>
                `- ${w.tools.join(" -> ")} (${w.count}x, ${(w.successRate * 100).toFixed(0)}% success)`,
            )
            .join("\n");
          result += "\n\n";
        }

        if (data.detectedPatterns && data.detectedPatterns.length > 0) {
          result += `**Detected Patterns:**\n`;
          result += data.detectedPatterns
            .map(
              (p: { name: string; description: string; suggestion: string }) =>
                `- **${p.name}:** ${p.description}\n  *Suggestion:* ${p.suggestion}`,
            )
            .join("\n");
          result += "\n\n";
        }

        if (data.recommendations && data.recommendations.length > 0) {
          result += `**Recommendations:**\n`;
          result += data.recommendations
            .map((r: string, i: number) => `${i + 1}. ${r}`)
            .join("\n");
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "get_developer_profile",
      description: `Get accumulated developer profile for ${projectName}: frequent files, preferred tools, peak hours, common patterns.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_developer_profile"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const response = await ctx.api.get(`/api/developer-profile`, {
          headers: { "X-Project-Name": ctx.projectName },
        });
        const p = response.data;

        if (!p.totalToolCalls) {
          return "No usage data yet. Use tools to build your developer profile.";
        }

        let result = `**Developer Profile** (${p.totalSessions} sessions, ${p.totalToolCalls} tool calls)\n\n`;

        if (p.frequentFiles.length > 0) {
          result += "**Frequent Files:**\n";
          result += p.frequentFiles
            .slice(0, 10)
            .map((f: any) => `- ${f.file} (${f.count}x)`)
            .join("\n");
          result += "\n\n";
        }

        if (p.preferredTools.length > 0) {
          result += "**Preferred Tools:**\n";
          result += p.preferredTools
            .slice(0, 8)
            .map(
              (t: any) =>
                `- ${t.tool}: ${t.count}x (avg ${Math.round(t.avgDurationMs)}ms)`,
            )
            .join("\n");
          result += "\n\n";
        }

        if (p.peakHours.length > 0) {
          result += "**Peak Hours:** ";
          result += p.peakHours
            .map((h: any) => `${h.hour}:00 (${h.count})`)
            .join(", ");
          result += "\n\n";
        }

        if (p.commonPatterns.length > 0) {
          result += "**Common Patterns:**\n";
          result += p.commonPatterns
            .slice(0, 5)
            .map((q: string) => `- "${truncate(q, 60)}"`)
            .join("\n");
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "start_session",
      description: `Start a new working session for ${projectName}. Tracks tool usage, file changes, and learnings throughout the session.`,
      schema: z.object({
        sessionId: z
          .string()
          .optional()
          .describe("Custom session ID. If omitted, one will be generated."),
        initialContext: z
          .string()
          .optional()
          .describe(
            "Description of what this session is about (e.g., 'fixing auth bug', 'adding new API endpoint').",
          ),
        resumeFrom: z
          .string()
          .optional()
          .describe(
            "Session ID to resume from. Carries over context from the previous session.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["start_session"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId, initialContext, resumeFrom } = args as {
          sessionId?: string;
          initialContext?: string;
          resumeFrom?: string;
        };
        const response = await ctx.api.post("/api/session/start", {
          projectName: ctx.projectName,
          sessionId,
          initialContext,
          resumeFrom,
        });
        const data = response.data;
        const session = data.session;

        // Extract fields — API returns { session: { sessionId, startedAt, ... } }
        const sid = session?.sessionId || data.sessionId;
        const started = session?.startedAt || data.started;
        const resumedFrom = session?.metadata?.resumedFrom || data.resumedFrom;
        const initialFiles = session?.currentFiles || data.initialFiles;

        // Update shared context with active session ID
        if (sharedCtx && sid) {
          sharedCtx.activeSessionId = sid;
        }

        let result = `**Session Started**\n\n`;
        result += `- **Session ID:** ${sid}\n`;
        result += `- **Started:** ${started}\n`;

        if (resumedFrom) {
          result += `- **Resumed From:** ${resumedFrom}\n`;
        }

        if (initialFiles && initialFiles.length > 0) {
          result += `\n**Initial Files:**\n`;
          result += initialFiles.map((f: string) => `- ${f}`).join("\n");
          result += "\n";
        }

        // Include prefetch stats if available
        if (session?.metadata?.prefetchStats) {
          const pf = session.metadata.prefetchStats;
          result += `\n**Predictive Prefetch:** ${pf.prefetchedCount ?? 0} resources prefetched\n`;
        }

        // Include briefing if available (Sprint E)
        if (data.briefing) {
          result += `\n**Session Briefing:**\n${data.briefing}\n`;
        }

        return result;
      },
    },
    {
      name: "get_session_context",
      description: `Get the current context for an active session in ${projectName}. Shows files being worked on, tools used, and pending learnings.`,
      schema: z.object({
        sessionId: z.string().describe("Session ID to get context for."),
      }),
      annotations: TOOL_ANNOTATIONS["get_session_context"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId } = args as { sessionId: string };
        const response = await ctx.api.get(`/api/session/${sessionId}`);
        const data = response.data;

        let result = `**Session Context**\n\n`;
        result += `- **Session ID:** ${data.sessionId}\n`;
        result += `- **Status:** ${data.status}\n`;
        result += `- **Started At:** ${data.startedAt}\n`;
        result += `- **Last Activity:** ${data.lastActivity}\n`;

        if (data.currentFiles && data.currentFiles.length > 0) {
          const files = data.currentFiles.slice(0, 10);
          result += `\n**Current Files:**\n`;
          result += files.map((f: string) => `- ${f}`).join("\n");
          if (data.currentFiles.length > 10) {
            result += `\n- ... and ${data.currentFiles.length - 10} more`;
          }
          result += "\n";
        }

        if (data.toolsUsed && data.toolsUsed.length > 0) {
          result += `\n**Tools Used:** ${data.toolsUsed.join(", ")}\n`;
        }

        if (data.activeFeatures && data.activeFeatures.length > 0) {
          result += `\n**Active Features:**\n`;
          result += data.activeFeatures.map((f: string) => `- ${f}`).join("\n");
          result += "\n";
        }

        if (data.pendingLearnings && data.pendingLearnings.length > 0) {
          const learnings = data.pendingLearnings.slice(0, 5);
          result += `\n**Pending Learnings:**\n`;
          result += learnings
            .map((l: string) => `- ${truncate(l, 80)}`)
            .join("\n");
          if (data.pendingLearnings.length > 5) {
            result += `\n- ... and ${data.pendingLearnings.length - 5} more`;
          }
          result += "\n";
        }

        return result;
      },
    },
    {
      name: "end_session",
      description: `End a working session for ${projectName}. Saves a summary and optionally extracts learnings for future sessions.`,
      schema: z.object({
        sessionId: z.string().describe("Session ID to end."),
        summary: z
          .string()
          .optional()
          .describe("Summary of what was accomplished during the session."),
        autoSaveLearnings: z
          .boolean()
          .optional()
          .describe(
            "Automatically save detected learnings to memory (default: true).",
          ),
        feedback: z
          .string()
          .optional()
          .describe(
            "Optional feedback about the session (e.g., 'productive', 'too many context switches').",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["end_session"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { sessionId, summary, autoSaveLearnings, feedback } = args as {
          sessionId: string;
          summary?: string;
          autoSaveLearnings?: boolean;
          feedback?: string;
        };
        const response = await ctx.api.post(`/api/session/${sessionId}/end`, {
          summary,
          autoSaveLearnings:
            autoSaveLearnings !== undefined ? autoSaveLearnings : true,
          feedback,
        });
        const data = response.data;

        // Clear active session ID
        if (sharedCtx) {
          sharedCtx.activeSessionId = undefined;
        }

        let result = `**Session Ended**\n\n`;

        if (data.summary) {
          result += `**Summary:** ${data.summary}\n\n`;
        }

        if (data.duration !== undefined) {
          result += `- **Duration:** ${data.duration} minutes\n`;
        }
        if (data.toolsUsedCount !== undefined) {
          result += `- **Tools Used:** ${data.toolsUsedCount}\n`;
        }
        if (data.filesAffectedCount !== undefined) {
          result += `- **Files Affected:** ${data.filesAffectedCount}\n`;
        }
        if (data.queriesCount !== undefined) {
          result += `- **Queries:** ${data.queriesCount}\n`;
        }
        if (data.learningsSaved !== undefined) {
          result += `- **Learnings Saved:** ${data.learningsSaved}\n`;
        }

        if (data.filesAffected && data.filesAffected.length > 0) {
          const files = data.filesAffected.slice(0, 10);
          result += `\n**Files Affected:**\n`;
          result += files.map((f: string) => `- ${f}`).join("\n");
          if (data.filesAffected.length > 10) {
            result += `\n- ... and ${data.filesAffected.length - 10} more`;
          }
          result += "\n";
        }

        return result;
      },
    },
  ];
}
