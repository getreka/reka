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
        type: z
          .enum(["research", "review", "documentation", "refactor", "test"])
          .describe(
            "Agent type: research, review, documentation, refactor, or test",
          ),
        task: z.string().describe("The task for the agent to perform"),
        context: z
          .string()
          .optional()
          .describe("Optional additional context (code, requirements, etc.)"),
        maxIterations: z.coerce
          .number()
          .optional()
          .describe("Maximum ReAct iterations (default: varies by agent type)"),
      }),
      annotations: TOOL_ANNOTATIONS["run_agent"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
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
              const obsPreview =
                step.observation.result?.slice(0, 150) || "...";
              result += `  Result: ${obsPreview}${step.observation.truncated ? " [truncated]" : ""}\n`;
            }
          }
        }

        return result;
      },
    },
    {
      name: "tribunal_debate",
      description: `Run an adversarial debate on a topic for ${projectName}. Multiple advocates argue positions, a judge renders a verdict. Use for architecture decisions, tech choices, or code approach trade-offs.`,
      schema: z.object({
        topic: z
          .string()
          .describe(
            "The debate topic (e.g., 'Should we use REST or gRPC for the new API?')",
          ),
        positions: z
          .array(z.string())
          .min(2)
          .max(4)
          .describe(
            "Positions to debate (2-4 options, e.g., ['REST', 'gRPC'])",
          ),
        context: z
          .string()
          .optional()
          .describe("Additional context for the debate"),
        maxRounds: z.coerce
          .number()
          .optional()
          .describe("Number of rebuttal rounds (default: 1, max: 3)"),
        useCodeContext: z
          .boolean()
          .optional()
          .describe(
            "Fetch relevant code, ADRs, and patterns as evidence (default: false)",
          ),
        autoRecord: z
          .boolean()
          .optional()
          .describe(
            "Save verdict as a decision in project memory (default: false)",
          ),
      }),
      annotations: TOOL_ANNOTATIONS["tribunal_debate"] || {
        priority: 0.4,
        readOnlyHint: true,
      },
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          topic,
          positions,
          context,
          maxRounds,
          useCodeContext,
          autoRecord,
        } = args as {
          topic: string;
          positions: string[];
          context?: string;
          maxRounds?: number;
          useCodeContext?: boolean;
          autoRecord?: boolean;
        };

        const response = await ctx.api.post("/api/tribunal/debate", {
          projectName: ctx.projectName,
          topic,
          positions,
          context,
          maxRounds,
          useCodeContext,
          autoRecord,
        });

        const data = response.data;

        // Format result as markdown
        let result = `## Tribunal Debate: ${data.topic}\n`;
        result += `**Status:** ${data.status}`;
        result += ` | **Duration:** ${Math.round(data.durationMs / 1000)}s`;
        result += ` | **Cost:** ~$${data.cost?.estimatedUsd?.toFixed(3) || "?"}\n\n`;

        // Phases summary
        if (data.phases) {
          result += `### Phases\n`;
          for (const phase of data.phases) {
            result += `- **${phase.name}**: ${Math.round(phase.durationMs / 1000)}s, ${phase.tokens} tokens\n`;
          }
          result += `\n`;
        }

        // Arguments
        if (data.arguments && data.arguments.length > 0) {
          result += `### Arguments\n`;
          for (const arg of data.arguments) {
            const label =
              arg.round === 0 ? "Initial" : `Rebuttal R${arg.round}`;
            result += `#### ${arg.position} (${label})\n${arg.content}\n\n`;
          }
        }

        // Verdict
        if (data.verdict) {
          result += `### Verdict\n`;
          result += `**Recommendation:** ${data.verdict.recommendation}\n`;
          result += `**Confidence:** ${data.verdict.confidence}\n\n`;

          if (data.verdict.scores) {
            result += `**Scores:**\n`;
            for (const s of data.verdict.scores) {
              result += `- ${s.position}: ${s.score}/10\n`;
            }
            result += `\n`;
          }

          result += `**Reasoning:**\n${data.verdict.reasoning}\n\n`;
          result += `**Trade-offs:**\n${data.verdict.tradeoffs}\n\n`;
          result += `**Dissent:**\n${data.verdict.dissent}\n\n`;
          result += `**Conditions:**\n${data.verdict.conditions}\n`;
        }

        if (data.error) {
          result += `\n**Error:** ${data.error}\n`;
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
        ctx: ToolContext,
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
