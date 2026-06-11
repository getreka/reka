/**
 * Suggestions tools module - context briefing, smart dispatch, and
 * project setup.
 */

import * as fs from "fs";
import * as path from "path";
import type { ToolSpec, ToolContext } from "../types.js";
import { truncate } from "../formatters.js";
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
        // Priority mirrors index.ts: REKA_API_KEY (new) > RAG_API_KEY (legacy)
        const apiKey =
          ragApiKey || process.env.REKA_API_KEY || process.env.RAG_API_KEY;
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
          REKA_API_URL: apiUrl,
          PROJECT_NAME: targetProject,
          PROJECT_PATH: projectPath,
        };
        if (apiKey) serverEnv.REKA_API_KEY = apiKey;

        mcpConfig.mcpServers[serverName] = {
          command: "npx",
          args: ["-y", "@getreka/mcp@latest"],
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
