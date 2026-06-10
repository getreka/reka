/**
 * Suggestions tools module - contextual suggestions, related code,
 * implementation suggestions, test suggestions, and code context.
 */

import * as fs from "fs";
import * as path from "path";
import type { ToolSpec, ToolContext } from "../types.js";
import { truncate, pct, PREVIEW } from "../formatters.js";
import { z } from "zod";
import { TOOL_ANNOTATIONS } from "../annotations.js";

/**
 * Format smart dispatch result into readable markdown.
 */
function formatSmartDispatchResult(task: string, data: any): string {
  let result = `# Context Briefing: ${task}\n`;
  result += `_Routing: ${data.reasoning} (${data.plan?.join(", ")}) [${data.timing?.totalMs}ms]_\n\n`;

  const ctx = data.context || {};

  if (ctx.memories?.length > 0) {
    result += `## Memories (${ctx.memories.length})\n`;
    for (const m of ctx.memories) {
      const mem = m.memory || m;
      result += `- [${mem.type || "note"}] ${(mem.content || "").slice(0, 150)}\n`;
    }
    result += "\n";
  }

  if (ctx.codeResults?.length > 0) {
    result += `## Related Code (${ctx.codeResults.length})\n`;
    for (const r of ctx.codeResults) {
      result += `- \`${r.file}\``;
      if (r.symbols?.length) result += ` — ${r.symbols.join(", ")}`;
      result += "\n";
    }
    result += "\n";
  }

  if (ctx.patterns?.length > 0) {
    result += `## Patterns (${ctx.patterns.length})\n`;
    for (const p of ctx.patterns) {
      const mem = p.memory || p;
      const name = mem.metadata?.patternName || mem.relatedTo || "Pattern";
      result += `- **${name}**: ${(mem.content || "").slice(0, 120)}\n`;
    }
    result += "\n";
  }

  if (ctx.adrs?.length > 0) {
    result += `## ADRs (${ctx.adrs.length})\n`;
    for (const a of ctx.adrs) {
      const mem = a.memory || a;
      const title = mem.metadata?.adrTitle || mem.relatedTo || "ADR";
      result += `- **${title}**: ${(mem.content || "").slice(0, 120)}\n`;
    }
    result += "\n";
  }

  if (ctx.graphDeps?.length > 0) {
    result += `## Dependencies (${ctx.graphDeps.length})\n`;
    for (const g of ctx.graphDeps) {
      result += `- \`${g.file}\`\n`;
    }
    result += "\n";
  }

  if (ctx.docs?.length > 0) {
    result += `## Docs (${ctx.docs.length})\n`;
    for (const d of ctx.docs) {
      result += `- \`${d.file}\`: ${(d.content || "").slice(0, 100)}\n`;
    }
    result += "\n";
  }

  if (ctx.symbols?.length > 0) {
    result += `## Symbols (${ctx.symbols.length})\n`;
    for (const s of ctx.symbols) {
      result += `- \`${s.name || s.symbol}\` [${s.kind || "unknown"}] in \`${s.file || "?"}\`\n`;
    }
    result += "\n";
  }

  if (
    result.endsWith(
      `_Routing: ${data.reasoning} (${data.plan?.join(", ")}) [${data.timing?.totalMs}ms]_\n\n`,
    )
  ) {
    result += "_No relevant context found. Proceed with implementation._\n";
  }

  return result;
}

/**
 * Create the suggestions tools module with project-specific descriptions.
 */
export function createSuggestionTools(projectName: string): ToolSpec[] {
  return [
    {
      name: "context_briefing",
      description: `REQUIRED before code changes. Parallel lookup of recall + search + patterns + ADRs + graph for ${projectName}. One call replaces 5 separate RAG lookups.`,
      schema: z.object({
        task: z.string().describe("What you will implement/change"),
        files: z
          .array(z.string())
          .optional()
          .describe("Files you plan to modify"),
      }),
      annotations: TOOL_ANNOTATIONS["context_briefing"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { task, files } = args as {
          task: string;
          files?: string[];
        };

        // Use smart_dispatch for intelligent routing
        try {
          const dispatchRes = await ctx.api.post("/api/smart-dispatch", {
            projectName: ctx.projectName,
            task,
            files,
          });

          const data = dispatchRes.data;
          return formatSmartDispatchResult(task, data);
        } catch {
          // Fallback to legacy 5-parallel-lookups if smart-dispatch unavailable
        }

        // Legacy fallback: 5 parallel lookups
        const [memoriesRes, searchRes, patternsRes, adrsRes, graphRes] =
          await Promise.all([
            ctx.api
              .post("/api/memory/recall", {
                projectName: ctx.projectName,
                query: task,
                limit: 5,
                type: "all",
              })
              .catch(() => null),
            ctx.api
              .post("/api/search-hybrid", {
                projectName: ctx.projectName,
                query: task,
                limit: 5,
                mode: "navigate",
              })
              .catch(() => null),
            ctx.api
              .post("/api/memory/recall", {
                projectName: ctx.projectName,
                query: task,
                type: "context",
                limit: 5,
                tag: "pattern",
              })
              .catch(() => null),
            ctx.api
              .post("/api/memory/recall", {
                projectName: ctx.projectName,
                query: task,
                type: "decision",
                limit: 3,
                tag: "adr",
              })
              .catch(() => null),
            files && files.length > 0
              ? ctx.api
                  .post("/api/search-graph", {
                    projectName: ctx.projectName,
                    query: files[0],
                    expandHops: 1,
                    limit: 5,
                  })
                  .catch(() => null)
              : Promise.resolve(null),
          ]);

        let result = `# Context Briefing: ${task}\n\n`;

        const memories =
          memoriesRes?.data?.results || memoriesRes?.data?.memories || [];
        if (memories.length > 0) {
          result += `## Memories (${memories.length})\n`;
          for (const m of memories) {
            const mem = m.memory || m;
            result += `- [${mem.type || "note"}] ${truncate(mem.content || "", 150)}\n`;
          }
          result += "\n";
        }

        const codeResults = searchRes?.data?.results || [];
        if (codeResults.length > 0) {
          result += `## Related Code (${codeResults.length})\n`;
          for (const r of codeResults) {
            result += `- \`${r.file}\``;
            if (r.symbols?.length) result += ` — ${r.symbols.join(", ")}`;
            result += "\n";
          }
          result += "\n";
        }

        const patterns = (patternsRes?.data?.results || []).filter((r: any) =>
          r.memory?.tags?.includes("pattern"),
        );
        if (patterns.length > 0) {
          result += `## Patterns (${patterns.length})\n`;
          for (const p of patterns) {
            const name =
              p.memory?.metadata?.patternName ||
              p.memory?.relatedTo ||
              "Pattern";
            result += `- **${name}**: ${truncate(p.memory?.content || "", 120)}\n`;
          }
          result += "\n";
        }

        const adrs = (adrsRes?.data?.results || []).filter((r: any) =>
          r.memory?.tags?.includes("adr"),
        );
        if (adrs.length > 0) {
          result += `## ADRs (${adrs.length})\n`;
          for (const a of adrs) {
            const title =
              a.memory?.metadata?.adrTitle || a.memory?.relatedTo || "ADR";
            result += `- **${title}**: ${truncate(a.memory?.content || "", 120)}\n`;
          }
          result += "\n";
        }

        const graphResults =
          graphRes?.data?.results || graphRes?.data?.directResults || [];
        const connectedFiles =
          graphRes?.data?.connectedFiles ||
          graphRes?.data?.expandedResults ||
          [];
        if (graphResults.length > 0 || connectedFiles.length > 0) {
          result += `## Dependencies\n`;
          for (const g of graphResults) {
            result += `- \`${g.file}\`\n`;
          }
          for (const c of connectedFiles) {
            result += `- \`${c.file}\` (connected)\n`;
          }
          result += "\n";
        }

        if (result.endsWith(`# Context Briefing: ${task}\n\n`)) {
          result +=
            "_No relevant context found. Proceed with implementation._\n";
        }

        return result;
      },
    },

    {
      name: "smart_dispatch",
      description: `Intelligent task routing for ${projectName}. LLM analyzes your task and runs only the needed lookups (2-5 of 7 available) in parallel. More efficient than context_briefing for narrow tasks.`,
      schema: z.object({
        task: z.string().describe("What you will implement/change"),
        files: z
          .array(z.string())
          .optional()
          .describe("Files you plan to modify"),
        intent: z
          .enum(["code", "research", "debug", "review", "architecture"])
          .optional()
          .describe("Task intent for better routing"),
      }),
      annotations: TOOL_ANNOTATIONS["context_briefing"], // Same annotations as context_briefing
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { task, files, intent } = args as {
          task: string;
          files?: string[];
          intent?: string;
        };

        const response = await ctx.api.post("/api/smart-dispatch", {
          projectName: ctx.projectName,
          task,
          files,
          intent,
        });

        return formatSmartDispatchResult(task, response.data);
      },
    },

    {
      name: "get_contextual_suggestions",
      description: `Get contextual suggestions based on current work context for ${projectName}. Returns relevant suggestions, triggers, and related memories.`,
      schema: z.object({
        currentFile: z
          .string()
          .optional()
          .describe("Currently active file path"),
        currentCode: z
          .string()
          .optional()
          .describe("Currently selected or visible code"),
        recentFiles: z
          .array(z.string())
          .optional()
          .describe("Recently opened file paths"),
        task: z.string().optional().describe("Current task description"),
      }),
      annotations: TOOL_ANNOTATIONS["get_contextual_suggestions"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { currentFile, currentCode, recentFiles, task } = args as {
          currentFile?: string;
          currentCode?: string;
          recentFiles?: string[];
          task?: string;
        };
        const response = await ctx.api.post("/api/suggestions", {
          projectName: ctx.projectName,
          currentFile,
          currentCode,
          recentFiles,
          task,
        });
        const data = response.data;

        let result = `## Contextual Suggestions\n\n`;

        if (data.relevanceScore !== undefined) {
          result += `**Relevance Score:** ${pct(data.relevanceScore)}\n\n`;
        }

        if (data.triggers && data.triggers.length > 0) {
          result += `### Triggers\n`;
          for (const t of data.triggers) {
            result += `- **${t.type}:** ${t.value}`;
            if (t.confidence) result += ` (${pct(t.confidence)})`;
            result += "\n";
          }
          result += "\n";
        }

        if (data.suggestions && data.suggestions.length > 0) {
          result += `### Suggestions\n`;
          for (const s of data.suggestions) {
            result += `- **${s.title}** [${s.type}]\n`;
            if (s.description) result += `  ${s.description}\n`;
            if (s.reason) result += `  *Reason: ${s.reason}*\n`;
            if (s.relevance !== undefined)
              result += `  Relevance: ${pct(s.relevance)}\n`;
          }
          result += "\n";
        }

        if (data.relatedMemories && data.relatedMemories.length > 0) {
          result += `### Related Memories\n`;
          for (const m of data.relatedMemories) {
            result += `- ${m.content || m.title || JSON.stringify(m)}\n`;
          }
        }

        return result;
      },
    },

    {
      name: "suggest_related_code",
      description: `Find code related to a given file or snippet in ${projectName}. Shows similar implementations and related modules.`,
      schema: z.object({
        file: z
          .string()
          .optional()
          .describe("File path to find related code for"),
        code: z
          .string()
          .optional()
          .describe("Code snippet to find related code for"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default: 5)"),
      }),
      annotations: TOOL_ANNOTATIONS["suggest_related_code"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          file,
          code,
          limit = 5,
        } = args as {
          file?: string;
          code?: string;
          limit?: number;
        };
        const response = await ctx.api.post("/api/code/related", {
          projectName: ctx.projectName,
          file,
          code,
          limit,
        });
        const results = response.data.results || response.data;

        if (!results || results.length === 0) {
          return "No related code found.";
        }

        let result = `## Related Code\n\n`;
        for (const r of results) {
          result += `### ${r.file}\n`;
          result += `**Score:** ${pct(r.score)}`;
          if (r.reason) result += ` | **Reason:** ${r.reason}`;
          if (r.line) result += ` | Line ${r.line}`;
          result += "\n";
          if (r.content || r.code) {
            result +=
              "```\n" +
              truncate(r.content || r.code, PREVIEW.MEDIUM) +
              "\n```\n";
          }
          result += "\n";
        }

        return result;
      },
    },

    {
      name: "suggest_implementation",
      description: `Get implementation suggestions for a feature in ${projectName}. Shows similar patterns and adaptation hints.`,
      schema: z.object({
        description: z.string().describe("Description of what to implement"),
        currentFile: z.string().optional().describe("Current file for context"),
        language: z.string().optional().describe("Target programming language"),
      }),
      annotations: TOOL_ANNOTATIONS["suggest_implementation"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { description, currentFile, language } = args as {
          description: string;
          currentFile?: string;
          language?: string;
        };
        const response = await ctx.api.post(
          "/api/code/suggest-implementation",
          {
            projectName: ctx.projectName,
            description,
            currentFile,
            language,
          },
        );
        const data = response.data;
        const patterns = data.patterns || data.results || [];

        if (!patterns || patterns.length === 0) {
          return "No implementation suggestions found.";
        }

        const patternIcons: Record<string, string> = {
          similar_structure: "\ud83d\udcd0",
          same_domain: "\ud83c\udfaf",
          related_import: "\ud83d\udce6",
          test_pattern: "\ud83e\uddea",
        };

        let result = `## Implementation Suggestions\n\n`;
        for (const p of patterns) {
          const icon = patternIcons[p.pattern || p.type] || "\ud83d\udcd0";
          result += `### ${icon} ${p.file || p.name || "Pattern"}\n`;
          if (p.adaptationHints || p.hints) {
            result += `**Adaptation:** ${p.adaptationHints || p.hints}\n`;
          }
          if (p.content || p.code) {
            result += "```\n" + truncate(p.content || p.code, 400) + "\n```\n";
          }
          result += "\n";
        }

        return result;
      },
    },

    {
      name: "suggest_tests",
      description: `Get test suggestions for code in ${projectName}. Shows recommended test types, frameworks, and example patterns.`,
      schema: z.object({
        file: z.string().optional().describe("File to suggest tests for"),
        code: z.string().optional().describe("Code to suggest tests for"),
        framework: z
          .string()
          .optional()
          .describe("Test framework preference (jest, mocha, pytest, etc.)"),
      }),
      annotations: TOOL_ANNOTATIONS["suggest_tests"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { file, code, framework } = args as {
          file?: string;
          code?: string;
          framework?: string;
        };
        const response = await ctx.api.post("/api/code/suggest-tests", {
          projectName: ctx.projectName,
          file,
          code,
          framework,
        });
        const data = response.data;
        const tests = data.tests || data.suggestions || data.results || [];

        if (!tests || tests.length === 0) {
          return "No test suggestions found.";
        }

        const typeIcons: Record<string, string> = {
          unit: "\ud83d\udd2c",
          integration: "\ud83d\udd17",
          e2e: "\ud83c\udf10",
        };

        let result = `## Test Suggestions\n\n`;
        for (const t of tests) {
          const icon = typeIcons[t.type] || "\ud83d\udd2c";
          result += `### ${icon} ${t.name || t.title || t.type || "Test"}\n`;
          if (t.framework) result += `**Framework:** ${t.framework}\n`;
          if (t.coverage) result += `**Coverage:** ${t.coverage}\n`;
          if (t.content || t.code) {
            result +=
              "```\n" + truncate(t.content || t.code, PREVIEW.LONG) + "\n```\n";
          }
          result += "\n";
        }

        return result;
      },
    },

    {
      name: "get_code_context",
      description: `Get full context for a code file in ${projectName}. Shows imports, related code, and test patterns.`,
      schema: z.object({
        file: z.string().optional().describe("File path to get context for"),
        code: z.string().optional().describe("Code snippet for context"),
      }),
      annotations: TOOL_ANNOTATIONS["get_code_context"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const { file, code } = args as { file?: string; code?: string };
        const response = await ctx.api.post("/api/code/context", {
          projectName: ctx.projectName,
          file,
          code,
        });
        const data = response.data;

        let result = `## Code Context\n\n`;

        if (data.imports && data.imports.length > 0) {
          result += `### Imports\n`;
          for (const imp of data.imports) {
            result += `- ${imp}\n`;
          }
          result += "\n";
        }

        if (data.relatedCode && data.relatedCode.length > 0) {
          result += `### Related Code\n`;
          for (const r of data.relatedCode) {
            result += `- **${r.file}** (${pct(r.score)})`;
            if (r.reason) result += ` - ${r.reason}`;
            result += "\n";
          }
          result += "\n";
        }

        if (data.testPatterns && data.testPatterns.length > 0) {
          result += `### Test Patterns\n`;
          for (const t of data.testPatterns) {
            result += `- **${t.file}**`;
            if (t.type) result += ` [${t.type}]`;
            if (t.framework) result += ` (${t.framework})`;
            result += "\n";
          }
        }

        return result;
      },
    },

    {
      name: "setup_project",
      description:
        "Configure Claude Code for RAG integration. Creates/updates .mcp.json, adds RAG instructions to CLAUDE.md, and configures permissions. Call after index_codebase on a new project.",
      schema: z.object({
        projectPath: z.string().describe("Absolute path to project root"),
        projectName: z
          .string()
          .describe("Project name in Qdrant (collection prefix)"),
        ragApiUrl: z
          .string()
          .optional()
          .describe("RAG API URL (default: from MCP env)"),
        ragApiKey: z
          .string()
          .optional()
          .describe("RAG API key (default: from MCP env)"),
        updateClaudeMd: z
          .boolean()
          .optional()
          .describe("Add RAG section to CLAUDE.md (default: true)"),
      }),
      annotations: TOOL_ANNOTATIONS["setup_project"],
      handler: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const {
          projectPath,
          projectName: targetProject,
          ragApiUrl,
          ragApiKey,
          updateClaudeMd = true,
        } = args as {
          projectPath: string;
          projectName: string;
          ragApiUrl?: string;
          ragApiKey?: string;
          updateClaudeMd?: boolean;
        };

        const apiUrl =
          ragApiUrl || process.env.RAG_API_URL || "http://localhost:3100";
        const apiKey = ragApiKey || process.env.RAG_API_KEY;
        const serverName = `${targetProject}-rag`;
        const changes: string[] = [];

        // 1. Create/update .mcp.json
        const mcpJsonPath = path.join(projectPath, ".mcp.json");
        let mcpConfig: any = {};
        try {
          const existing = fs.readFileSync(mcpJsonPath, "utf-8");
          mcpConfig = JSON.parse(existing);
        } catch {
          // File doesn't exist or invalid JSON
        }

        if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

        const serverEnv: Record<string, string> = {
          RAG_API_URL: apiUrl,
          PROJECT_NAME: targetProject,
          PROJECT_PATH: projectPath,
        };
        if (apiKey) serverEnv.RAG_API_KEY = apiKey;

        mcpConfig.mcpServers[serverName] = {
          command: "npx",
          args: ["-y", "@crowley/rag-mcp@latest"],
          env: serverEnv,
        };

        fs.writeFileSync(
          mcpJsonPath,
          JSON.stringify(mcpConfig, null, 2) + "\n",
        );
        changes.push(`.mcp.json — added \`${serverName}\` server`);

        // 2. Update CLAUDE.md with RAG section
        if (updateClaudeMd) {
          const claudeMdPath = path.join(projectPath, "CLAUDE.md");
          let claudeMd = "";
          try {
            claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
          } catch {
            // File doesn't exist
          }

          const ragSection = `\n## RAG Integration

You MUST call \`context_briefing\` before making any code changes.
This single tool performs all RAG lookups in parallel (recall, search, patterns, ADRs, graph).

Example: \`context_briefing(task: "describe your change", files: ["path/to/file.ts"])\`

After completing significant changes:
- \`remember\` — save important context for future sessions
- \`record_adr\` — document architectural decisions
`;

          if (claudeMd.includes("## RAG")) {
            changes.push("CLAUDE.md — RAG section already exists, skipped");
          } else {
            claudeMd = claudeMd
              ? claudeMd.trimEnd() + "\n" + ragSection
              : `# CLAUDE.md\n${ragSection}`;
            fs.writeFileSync(claudeMdPath, claudeMd);
            changes.push("CLAUDE.md — added RAG Integration section");
          }
        }

        // 3. Create/update .claude/settings.local.json permissions
        const claudeDir = path.join(projectPath, ".claude");
        const settingsPath = path.join(claudeDir, "settings.local.json");
        let settings: any = {};
        try {
          const existing = fs.readFileSync(settingsPath, "utf-8");
          settings = JSON.parse(existing);
        } catch {
          // File doesn't exist or invalid JSON
        }

        if (!settings.permissions) settings.permissions = {};
        if (!settings.permissions.allow) settings.permissions.allow = [];

        const mcpPermission = `mcp__${serverName}__*`;
        if (!settings.permissions.allow.includes(mcpPermission)) {
          settings.permissions.allow.push(mcpPermission);
          if (!fs.existsSync(claudeDir))
            fs.mkdirSync(claudeDir, { recursive: true });
          fs.writeFileSync(
            settingsPath,
            JSON.stringify(settings, null, 2) + "\n",
          );
          changes.push(
            `.claude/settings.local.json — added \`${mcpPermission}\` permission`,
          );
        } else {
          changes.push(
            ".claude/settings.local.json — permission already exists, skipped",
          );
        }

        // 4. Check index status
        let indexInfo = "";
        try {
          const statusRes = await ctx.api.get(
            `/api/index/status/${targetProject}_codebase`,
          );
          const data = statusRes.data;
          indexInfo = `\n## Index Status\n- **Vectors:** ${data.vectorCount ?? "N/A"}\n- **Status:** ${data.status || "unknown"}\n`;
        } catch {
          indexInfo =
            "\n## Index Status\n_Not indexed yet. Run `index_codebase` first._\n";
        }

        let result = `# Project Setup: ${targetProject}\n\n`;
        result += `## Files Updated\n`;
        for (const c of changes) {
          result += `- ${c}\n`;
        }
        result += indexInfo;
        result += `\n## Next Steps\n`;
        result += `1. Restart Claude Code to load the new MCP server\n`;
        result += `2. Run \`index_codebase\` if not indexed yet\n`;
        result += `3. Use \`context_briefing\` before code changes\n`;

        return result;
      },
    },
  ];
}
