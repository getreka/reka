/**
 * Agent tools module - run specialized agents and list agent types.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the agent tools module with project-specific descriptions.
 */
export function createAgentTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "run_agent",
      description: `Run a specialized agent for ${projectName}. Agents autonomously research, review, or analyze using multiple tool calls. Returns result + reasoning trace.`,
      schema: z.object({
        type: z.enum(["research", "review", "documentation", "refactor", "test"]).describe("Agent type: research, review, documentation, refactor, or test"),
        task: z.string().describe("The task for the agent to perform"),
        context: z.string().optional().describe("Optional additional context (code, requirements, etc.)"),
        maxIterations: z.number().optional().describe("Maximum ReAct iterations (default: varies by agent type)"),
      }),
      annotations: TOOL_ANNOTATIONS["run_agent"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext
      ): Promise<string> => {
        const { type, task, context, maxIterations } = args as {
          type: string;
          task: string;
          context?: string;
          maxIterations?: number;
        };

        const response = await ctx.api.post("/api/agent/run", {
          projectName: ctx.projectName,
          agentType: type,
          task,
          context,
          maxIterations,
        });

        const data = response.data;

        // Format result with reasoning trace
        let result = `## Agent Result (${data.type})\n`;
        result += `**Task:** ${data.task}\n`;
        result += `**Status:** ${data.status}`;
        result += ` | **Iterations:** ${data.usage?.iterations || 0}`;
        result += ` | **Tool Calls:** ${data.usage?.toolCalls || 0}`;
        result += ` | **Duration:** ${data.usage?.durationMs ? Math.round(data.usage.durationMs / 1000) + "s" : "N/A"}`;
        result += "\n\n";

        if (data.error) {
          result += `**Error:** ${data.error}\n\n`;
        }

        if (data.result) {
          result += `### Result\n${data.result}\n\n`;
        }

        // Reasoning trace
        if (data.steps && data.steps.length > 0) {
          result += `### Reasoning Trace\n`;
          for (const step of data.steps) {
            result += `**Step ${step.iteration}:** ${step.thought?.slice(0, 200) || "..."}\n`;
            if (step.action) {
              result += `  Action: ${step.action.tool}(${JSON.stringify(step.action.input).slice(0, 100)})\n`;
            }
            if (step.observation) {
              const obsPreview = step.observation.result?.slice(0, 150) || "...";
              result += `  Result: ${obsPreview}${step.observation.truncated ? " [truncated]" : ""}\n`;
            }
          }
        }

        return result;
      },
    },
    {
      name: "get_agent_types",
      description: `List available agent types for ${projectName} with descriptions.`,
      schema: z.object({}),
      annotations: TOOL_ANNOTATIONS["get_agent_types"],
      handler: async (
        _args: Record<string, unknown>,
        ctx: ToolContext
      ): Promise<string> => {
        const response = await ctx.api.get("/api/agent/types");
        const data = response.data;

        let result = `## Available Agent Types\n\n`;
        for (const agent of data.agents || []) {
          result += `- **${agent.name}**: ${agent.description}\n`;
        }
        return result;
      },
    },
  ];
}
