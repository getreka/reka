/**
 * Project-file writes for `reka init` — parity with the mcp-server
 * `setup_project` tool: .mcp.json, CLAUDE.md RAG section, and
 * .claude/settings.local.json permissions. All writes are idempotent.
 */

import * as fs from "fs";
import * as path from "path";
import {
  McpConfig,
  McpServerEntry,
  mergeRagServer,
  TARGET_SERVER_NAME,
} from "./mcp-config";

export interface SetupResult {
  changes: string[];
}

export function readMcpConfig(projectPath: string): McpConfig {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectPath, ".mcp.json"), "utf-8"),
    );
  } catch {
    return {};
  }
}

export function buildRagEntry(opts: {
  apiUrl: string;
  projectName: string;
  projectPath: string;
  apiKey: string;
}): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", "@getreka/mcp@latest"],
    env: {
      REKA_API_URL: opts.apiUrl,
      PROJECT_NAME: opts.projectName,
      PROJECT_PATH: opts.projectPath,
      REKA_API_KEY: opts.apiKey,
    },
  };
}

/** Same content as mcp-server setup_project writes. */
const RAG_SECTION = `\n## RAG Integration

You MUST call \`context_briefing\` before making any code changes.
This single tool performs all RAG lookups in parallel (recall, search, patterns, ADRs, graph).

Example: \`context_briefing(task: "describe your change", files: ["path/to/file.ts"])\`

After completing significant changes:
- \`remember\` — save important context for future sessions
- \`record_adr\` — document architectural decisions
`;

export function applyProjectFiles(opts: {
  projectPath: string;
  projectName: string;
  entry: McpServerEntry;
  /** --force: discard the existing .mcp.json instead of merging into it. */
  force?: boolean;
}): SetupResult {
  const { projectPath, projectName, entry, force } = opts;
  const changes: string[] = [];

  // 1. .mcp.json — merge/rename legacy entries into a single "rag" entry
  const existing: McpConfig = force ? {} : readMcpConfig(projectPath);
  const { config, removed } = mergeRagServer(existing, projectName, entry);
  fs.writeFileSync(
    path.join(projectPath, ".mcp.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
  changes.push(
    removed.length
      ? `.mcp.json — "${TARGET_SERVER_NAME}" server written (merged legacy: ${removed.join(", ")})`
      : `.mcp.json — "${TARGET_SERVER_NAME}" server written`,
  );

  // 2. CLAUDE.md — add RAG section (same content/idempotency as setup_project)
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");
  let claudeMd = "";
  try {
    claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
  } catch {
    // File doesn't exist
  }
  if (claudeMd.includes("## RAG")) {
    changes.push("CLAUDE.md — RAG section already exists, skipped");
  } else {
    claudeMd = claudeMd
      ? claudeMd.trimEnd() + "\n" + RAG_SECTION
      : `# CLAUDE.md\n${RAG_SECTION}`;
    fs.writeFileSync(claudeMdPath, claudeMd);
    changes.push("CLAUDE.md — added RAG Integration section");
  }

  // 3. .claude/settings.local.json — allow the MCP server's tools
  const claudeDir = path.join(projectPath, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    // File doesn't exist or invalid JSON
  }
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const mcpPermission = `mcp__${TARGET_SERVER_NAME}__*`;
  if (settings.permissions.allow.includes(mcpPermission)) {
    changes.push(
      ".claude/settings.local.json — permission already exists, skipped",
    );
  } else {
    settings.permissions.allow.push(mcpPermission);
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    changes.push(
      `.claude/settings.local.json — added \`${mcpPermission}\` permission`,
    );
  }

  return { changes };
}
