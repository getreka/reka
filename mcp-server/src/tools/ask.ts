/**
 * Ask tools module - question answering, code explanation, feature finding,
 * conversation analysis, and auto-remember.
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { truncate, pct, PREVIEW } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Create the ask tools module with project-specific descriptions.
 */
export function createAskTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "ask_codebase",
      description: `Ask a question about the ${projectName} codebase. Uses RAG + LLM to provide contextual answers.`,
      schema: z.object({
        question: z.string().describe("Question about the codebase"),
      }),
      annotations: TOOL_ANNOTATIONS["ask_codebase"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { question } = args as { question: string };
        const response = await ctx.api.post("/api/ask", {
          collection: `${ctx.collectionPrefix}codebase`,
          question,
        });
        return response.data.answer || "No answer could be generated.";
      },
    },
    {
      name: "explain_code",
      description: "Get a detailed explanation of a code snippet.",
      schema: z.object({
        code: z.string().describe("Code snippet to explain"),
        filePath: z.string().optional().describe("Optional file path for context"),
      }),
      annotations: TOOL_ANNOTATIONS["explain_code"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { code, filePath } = args as { code: string; filePath?: string };
        const response = await ctx.api.post("/api/explain", {
          collection: `${ctx.collectionPrefix}codebase`,
          code,
          filePath,
        });
        const data = response.data;

        let result = `## Summary\n${data.summary || "N/A"}\n\n`;
        result += `## Purpose\n${data.purpose || "N/A"}\n\n`;

        if (data.keyComponents && data.keyComponents.length > 0) {
          result += `## Key Components\n`;
          for (const comp of data.keyComponents) {
            result += `- ${comp}\n`;
          }
          result += "\n";
        }

        if (data.dependencies && data.dependencies.length > 0) {
          result += `## Dependencies\n`;
          for (const dep of data.dependencies) {
            result += `- ${dep}\n`;
          }
        }

        return result;
      },
    },
    {
      name: "find_feature",
      description: `Find where a specific feature is implemented in the ${projectName} codebase.`,
      schema: z.object({
        description: z.string().describe("Description of the feature to find"),
      }),
      annotations: TOOL_ANNOTATIONS["find_feature"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { description } = args as { description: string };
        const response = await ctx.api.post("/api/find-feature", {
          collection: `${ctx.collectionPrefix}codebase`,
          description,
        });
        const data = response.data;

        let result = `## Feature: ${data.name || description}\n\n`;
        result += `${data.explanation || "No explanation available."}\n\n`;

        if (data.mainFiles && data.mainFiles.length > 0) {
          result += `### Main Files\n`;
          for (const f of data.mainFiles) {
            result += `- **${f.file}** (${pct(f.score)} match)\n`;
          }
          result += "\n";
        }

        if (data.relatedFiles && data.relatedFiles.length > 0) {
          result += `### Related Files\n`;
          for (const f of data.relatedFiles) {
            result += `- ${f.file}\n`;
          }
        }

        return result;
      },
    },
    {
      name: "analyze_conversation",
      description: `Analyze a conversation to extract learnings, decisions, and insights for ${projectName}.`,
      schema: z.object({
        conversation: z.string().describe("The conversation text to analyze"),
        context: z.string().optional().describe("Additional context about the conversation"),
        autoSave: z.boolean().optional().describe("Automatically save extracted learnings (default: false)"),
        minConfidence: z.number().optional().describe("Minimum confidence threshold for learnings (0-1, default: 0.7)"),
      }),
      annotations: TOOL_ANNOTATIONS["analyze_conversation"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { conversation, context, autoSave = false, minConfidence = 0.7 } = args as {
          conversation: string;
          context?: string;
          autoSave?: boolean;
          minConfidence?: number;
        };
        const response = await ctx.api.post("/api/analyze-conversation", {
          projectName: ctx.projectName,
          conversation,
          context,
          autoSave,
          minConfidence,
        });
        const data = response.data;

        let result = `## Conversation Analysis\n\n`;
        result += `**Summary:** ${data.summary || "N/A"}\n\n`;

        if (data.learnings && data.learnings.length > 0) {
          result += `### Extracted Learnings\n`;
          for (const l of data.learnings) {
            result += `- **[${l.type}]** (confidence: ${pct(l.confidence)}) ${l.content}\n`;
            if (l.tags && l.tags.length > 0) {
              result += `  Tags: ${l.tags.join(", ")}\n`;
            }
          }
          result += "\n";
        }

        if (data.entities) {
          if (data.entities.files && data.entities.files.length > 0) {
            result += `### Referenced Files\n`;
            for (const f of data.entities.files) {
              result += `- ${f}\n`;
            }
            result += "\n";
          }
          if (data.entities.functions && data.entities.functions.length > 0) {
            result += `### Referenced Functions\n`;
            for (const f of data.entities.functions) {
              result += `- ${f}\n`;
            }
            result += "\n";
          }
        }

        if (data.savedCount !== undefined) {
          result += `**Saved:** ${data.savedCount} learnings\n`;
        }

        return result;
      },
    },
    {
      name: "auto_remember",
      description: `Automatically classify and remember information for ${projectName}. Analyzes content to determine the best memory type.`,
      schema: z.object({
        content: z.string().describe("Content to analyze and remember"),
        context: z.string().optional().describe("Additional context"),
        relatedTo: z.string().optional().describe("Related feature or topic"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      }),
      annotations: TOOL_ANNOTATIONS["auto_remember"],
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        const { content, context, relatedTo, tags } = args as {
          content: string;
          context?: string;
          relatedTo?: string;
          tags?: string[];
        };

        // First, analyze the content to classify it
        const analyzeResponse = await ctx.api.post("/api/analyze-conversation", {
          projectName: ctx.projectName,
          conversation: content,
          context,
          autoSave: false,
          minConfidence: 0.5,
        });
        const analysis = analyzeResponse.data;

        let memoryType = "note";
        let confidence = 0;

        if (analysis.learnings && analysis.learnings.length > 0) {
          const best = analysis.learnings[0];
          memoryType = best.type || "note";
          confidence = best.confidence || 0;
        }

        // Save with the classified type
        const rememberResponse = await ctx.api.post("/api/memory", {
          projectName: ctx.projectName,
          type: memoryType,
          content,
          relatedTo,
          tags: tags || (analysis.learnings?.[0]?.tags),
          metadata: {
            source: 'auto_pattern',
            confidence,
          },
        });
        const saved = rememberResponse.data;

        let result = `## Auto-Remembered\n\n`;
        result += `- **Type:** ${memoryType}\n`;
        result += `- **Confidence:** ${confidence > 0 ? pct(confidence) : "N/A (fallback to note)"}\n`;
        result += `- **ID:** ${saved.id || "N/A"}\n`;
        if (saved.tags && saved.tags.length > 0) {
          result += `- **Tags:** ${saved.tags.join(", ")}\n`;
        }

        return result;
      },
    },
  ];
}
