/**
 * RAG Guidelines Tool
 */

import type { ToolSpec, ToolContext } from "../types.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

export function createGuidelinesTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "get_rag_guidelines",
      description: `Get recommended settings and best practices for working with RAG in ${projectName}. Shows optimal tool usage patterns, query strategies, and session management tips.`,
      schema: z.object({
        focus: z
          .enum([
            "all",
            "search",
            "memory",
            "session",
            "feedback",
            "performance",
          ])
          .optional()
          .describe("Focus area for guidelines (default: all)"),
        context: z
          .enum(["coding", "debugging", "reviewing", "learning", "documenting"])
          .optional()
          .describe("Current work context for tailored recommendations"),
      }),
      annotations: TOOL_ANNOTATIONS["get_rag_guidelines"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { focus = "all", context } = args as {
          focus?: string;
          context?: string;
        };

        let result = `# 📚 RAG Guidelines for ${ctx.projectName}\n\n`;

        if (context) {
          const contextTips: Record<string, string> = {
            coding:
              "🔧 **Mode: Coding** - Focus on implementation patterns and related code",
            debugging:
              "🐛 **Mode: Debugging** - Focus on error patterns and similar issues",
            reviewing:
              "👀 **Mode: Reviewing** - Focus on patterns, ADRs, and best practices",
            learning:
              "📖 **Mode: Learning** - Focus on documentation and explanations",
            documenting:
              "📝 **Mode: Documenting** - Focus on existing docs and patterns",
          };
          result += `${contextTips[context] || ""}\n\n`;
        }

        if (focus === "all" || focus === "search") {
          result += `## 🔍 Search Best Practices\n\n`;
          result += `### Query Formulation\n`;
          result += `- **Be specific**: "authentication middleware express" > "auth code"\n`;
          result += `- **Include context**: Add file types, modules, or features\n`;
          result += `- **Use technical terms**: Match actual code terminology\n`;
          result += `- **Combine concepts**: "error handling async database"\n\n`;
          result += `### Tool Selection\n`;
          result += `| Goal | Tool | When |\n`;
          result += `|------|------|------|\n`;
          result += `| Find code | \`search_codebase\` | General code search |\n`;
          result += `| Find similar | \`search_similar\` | Have code snippet |\n`;
          result += `| Understand | \`ask_codebase\` | Need explanation |\n`;
          result += `| Find feature | \`find_feature\` | Know what it does |\n`;
          result += `| Group by file | \`grouped_search\` | Overview needed |\n`;
          result += `| Exact + semantic | \`hybrid_search\` | Specific terms |\n\n`;
        }

        if (focus === "all" || focus === "memory") {
          result += `## 🧠 Memory Best Practices\n\n`;
          result += `### What to Remember\n`;
          result += `| Type | Use For | Example |\n`;
          result += `|------|---------|----------|\n`;
          result += `| \`decision\` | Architecture choices | "Use WebSocket for real-time" |\n`;
          result += `| \`insight\` | Learned patterns | "Service X fails under load" |\n`;
          result += `| \`context\` | Project knowledge | "Module Y handles payments" |\n`;
          result += `| \`todo\` | Tasks to track | "Refactor auth after v2" |\n`;
          result += `| \`note\` | General notes | "Config in .env.local" |\n\n`;
          result += `### Architecture Knowledge\n`;
          result += `- Record ADRs: \`record_adr\` for major decisions\n`;
          result += `- Record patterns: \`record_pattern\` for code structures\n`;
          result += `- Record tech debt: \`record_tech_debt\` for known issues\n`;
          result += `- Check before coding: \`check_architecture\`\n\n`;
        }

        if (focus === "all" || focus === "session") {
          result += `## 📋 Session Management\n\n`;
          result += `### Recommended Workflow\n`;
          result += `\`\`\`\n`;
          result += `1. start_session          # Begin with context\n`;
          result += `2. warm_cache             # Pre-load embeddings\n`;
          result += `3. ... work ...           # Tools auto-track activity\n`;
          result += `4. end_session            # Save learnings, get summary\n`;
          result += `\`\`\`\n\n`;
        }

        if (focus === "all" || focus === "feedback") {
          result += `## 👍 Feedback Guidelines\n\n`;
          result += `| Result Quality | Action |\n`;
          result += `|----------------|--------|\n`;
          result += `| Found what needed | \`feedback_search\` -> helpful |\n`;
          result += `| Partially useful | \`feedback_search\` -> partially_helpful |\n`;
          result += `| Not relevant | \`feedback_search\` -> not_helpful + better query |\n\n`;
        }

        if (focus === "all" || focus === "performance") {
          result += `## ⚡ Performance Optimization\n\n`;
          result += `### Expected Performance\n`;
          result += `| Operation | L1 Hit | L2 Hit | Miss |\n`;
          result += `|-----------|--------|--------|------|\n`;
          result += `| Embedding | 1-5ms | 5-15ms | 50-200ms |\n`;
          result += `| Search | 20-50ms | 50-150ms | 100-500ms |\n`;
          result += `| Memory recall | 10-30ms | 30-100ms | 100-300ms |\n\n`;
        }

        if (context) {
          result += `## 🎯 Recommendations for ${context.charAt(0).toUpperCase() + context.slice(1)}\n\n`;
          const contextRecs: Record<string, string[]> = {
            coding: [
              "Use `suggest_implementation` before writing new code",
              "Check `suggest_related_code` for dependencies",
              "Run `check_architecture` to validate patterns",
            ],
            debugging: [
              "Search for error messages with `hybrid_search`",
              "Use `ask_codebase` to understand error context",
              "Record solutions as `insight` memories",
            ],
            reviewing: [
              "Check `get_adrs` for architectural decisions",
              "Use `get_patterns` for expected structures",
              "Run `check_architecture` on changes",
            ],
            learning: [
              "Start with `ask_codebase` for explanations",
              "Use `explain_code` for complex snippets",
              "Remember insights for future reference",
            ],
            documenting: [
              "Use `search_docs` for existing documentation",
              "Check `get_patterns` for structure templates",
              "Record new patterns with `record_pattern`",
            ],
          };
          const recs = contextRecs[context] || [];
          recs.forEach((rec, i) => {
            result += `${i + 1}. ${rec}\n`;
          });
          result += "\n";
        }

        result += `## 📌 Quick Reference\n\n`;
        result += `- \`search_codebase\` - Find code\n`;
        result += `- \`ask_codebase\` - Get explanations\n`;
        result += `- \`remember\` - Save knowledge\n`;
        result += `- \`recall\` - Retrieve knowledge\n`;
        result += `- \`suggest_better_query\` - Improve searches\n`;

        return result;
      },
    },
  ];
}
