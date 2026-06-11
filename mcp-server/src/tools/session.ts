/**
 * Session tools module - session lifecycle management (start/end).
 */

import type { ToolSpec, ToolContext } from "../types.js";
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

        // Ingest session start into sensory buffer (fire-and-forget)
        if (sid) {
          ctx.api
            .post("/api/sensory/append", {
              projectName: ctx.projectName,
              sessionId: sid,
              toolName: "start_session",
              inputSummary: initialContext || "session started",
              outputSummary: `Session ${sid} started${resumedFrom ? ` (resumed from ${resumedFrom})` : ""}`,
              filesTouched: session?.currentFiles || [],
              success: true,
              durationMs:
                Date.now() - Date.parse(started || new Date().toISOString()),
            })
            .catch(() => {});
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

        // Ingest session end into sensory buffer (fire-and-forget)
        ctx.api
          .post("/api/sensory/append", {
            projectName: ctx.projectName,
            sessionId,
            toolName: "end_session",
            inputSummary: summary || "session ended",
            outputSummary: `Duration: ${data.duration ?? "?"}min, learnings: ${data.learningsSaved ?? 0}, tools: ${data.toolsUsedCount ?? 0}, files: ${data.filesAffectedCount ?? 0}`,
            filesTouched: data.filesAffected || [],
            success: true,
            durationMs: data.duration ? data.duration * 60000 : 0,
          })
          .catch(() => {});

        return result;
      },
    },
  ];
}
