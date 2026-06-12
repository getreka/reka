#!/usr/bin/env node
/**
 * Universal RAG MCP Server
 *
 * A shared MCP server that can be used by any project.
 * Each project has its own namespace/collection in Qdrant.
 *
 * Environment variables:
 * - PROJECT_NAME: Unique project identifier (e.g., "cypro", "myproject")
 * - PROJECT_PATH: Path to project codebase for indexing
 * - RAG_API_URL: URL of the shared RAG API (default: http://localhost:3100)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createApiClient } from "./api-client.js";
import { configureConnectionPool } from "./connection-pool.js";
import { ContextEnricher } from "./context-enrichment.js";
import { startHttpTransport } from "./http-transport.js";
import { wrapHandler } from "./tool-middleware.js";
import type { ToolContext, ToolSpec } from "./types.js";

// Phase 3: Configure undici connection pool for RAG API communication
configureConnectionPool({
  connections: parseInt(process.env.MCP_POOL_CONNECTIONS || "10"),
  keepAliveTimeout: parseInt(process.env.MCP_POOL_KEEPALIVE || "30000"),
  pipelining: parseInt(process.env.MCP_POOL_PIPELINING || "1"),
});

// Tool modules
import {
  createSearchTools,
  HYBRID_SEARCH_DESCRIPTION,
  FIND_SYMBOL_DESCRIPTION,
} from "./tools/search.js";
import { createIndexingTools } from "./tools/indexing.js";
import {
  createMemoryTools,
  REMEMBER_DESCRIPTION,
  RECALL_DESCRIPTION,
} from "./tools/memory.js";
import { createMemoryToolTools } from "./tools/memory-tool.js";
import { createArchitectureTools } from "./tools/architecture.js";
import { createSessionTools } from "./tools/session.js";
import {
  createSuggestionTools,
  CONTEXT_BRIEFING_DESCRIPTION,
} from "./tools/suggestions.js";
import { createAgentTools } from "./tools/agents.js";
import { createQualityTools } from "./tools/quality.js";

// Configuration from environment
// Priority: REKA_API_KEY (new) > RAG_API_KEY (legacy)
const API_KEY = process.env.REKA_API_KEY || process.env.RAG_API_KEY;
const RAG_API_URL =
  process.env.REKA_API_URL ||
  process.env.RAG_API_URL ||
  "http://localhost:3100";
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();

// Project name: resolved from API key via /api/whoami, fallback to env/dirname
let PROJECT_NAME = process.env.PROJECT_NAME || "";
const COLLECTION_PREFIX_FN = () => `${PROJECT_NAME}_`;

// API client (PROJECT_NAME may be empty initially, resolved after whoami)
const api = createApiClient(
  RAG_API_URL,
  PROJECT_NAME || "resolving",
  PROJECT_PATH,
  API_KEY,
);

// Resolve project name from API key
async function resolveProject(): Promise<void> {
  if (PROJECT_NAME) return; // already set via env
  if (!API_KEY) {
    PROJECT_NAME = "default";
    return;
  }
  try {
    const res = await api.get<{ projectName: string }>("/api/whoami");
    if (res.data?.projectName) {
      PROJECT_NAME = res.data.projectName;
      api.setProjectName(PROJECT_NAME);
    }
  } catch {
    // Fallback to directory name
    const path = await import("path");
    PROJECT_NAME = path.basename(PROJECT_PATH);
  }
}

// Mutable tool context shared by all handlers (session state updates in-place)
const ctx: ToolContext = {
  api,
  projectName: PROJECT_NAME || "resolving",
  projectPath: PROJECT_PATH,
  collectionPrefix: COLLECTION_PREFIX_FN(),
  enrichmentEnabled: true,
};

// If session ID was injected by SessionStart hook, use it
const hookSessionId = process.env.RAG_SESSION_ID;
if (hookSessionId) {
  ctx.activeSessionId = hookSessionId;
}

// Context enrichment middleware
const enricher = new ContextEnricher({
  maxAutoRecall: 3,
  minRelevance: 0.6,
  timeoutMs: 2000,
});

// Collect all tool specs from modules
const allSpecs: ToolSpec[] = [
  ...createSearchTools(PROJECT_NAME),
  ...createIndexingTools(PROJECT_NAME),
  ...createMemoryTools(PROJECT_NAME),
  ...createMemoryToolTools(PROJECT_NAME),
  ...createArchitectureTools(PROJECT_NAME),
  ...createSessionTools(PROJECT_NAME, ctx),
  ...createSuggestionTools(PROJECT_NAME),
  ...createAgentTools(PROJECT_NAME),
  ...createQualityTools(PROJECT_NAME),
];

// LITE PROFILE (~6 tools): the highest-frequency tools registered eagerly.
// Rationale: hosts that support ToolSearch / deferred tool-schema loading
// don't need a server-side allowlist, but the installed MCP SDK
// (@modelcontextprotocol/sdk 1.25.x) exposes NO per-tool defer/lazy-loading
// flag on registerTool (only enable()/disable() visibility toggles), so we
// cannot ask the server to defer schemas. Deferred loading is a CLIENT-side
// (host) capability. 'lite' simply registers this minimal set; the remaining
// tools stay reachable via run_agent (the agent runtime calls the RAG API
// directly).
const LITE_TOOLS = new Set([
  "hybrid_search",
  "find_symbol",
  "context_briefing",
  "remember",
  "recall",
  // memory_20250818 surface — RL-trained triggering, must exist in EVERY profile.
  "memory",
  // run_agent kept so everything else stays reachable in lite mode.
  "run_agent",
]);

// M2-5: the prescriptive "Call this when…" wording (with anti-triggers) now
// lives in the tool MODULES, so every profile carries it. LITE_DESCRIPTIONS is
// a pure re-export of those module descriptions — the lite override is a
// deliberate no-op kept for grep-ability. Do NOT fork wording here.
const LITE_DESCRIPTIONS: Record<string, string> = {
  hybrid_search: HYBRID_SEARCH_DESCRIPTION,
  find_symbol: FIND_SYMBOL_DESCRIPTION,
  context_briefing: CONTEXT_BRIEFING_DESCRIPTION,
  remember: REMEMBER_DESCRIPTION,
  recall: RECALL_DESCRIPTION,
};

// Profile selection. Default 'full' — every tool that survived the 0.4.0
// subtraction is registered; there is no hidden tier.
type McpProfile = "lite" | "full";
const MCP_PROFILE = (
  process.env.MCP_PROFILE || "full"
).toLowerCase() as McpProfile;

const activeSpecs: ToolSpec[] =
  MCP_PROFILE === "lite"
    ? allSpecs
        .filter((s) => LITE_TOOLS.has(s.name))
        .map((s) =>
          LITE_DESCRIPTIONS[s.name]
            ? { ...s, description: LITE_DESCRIPTIONS[s.name] }
            : s,
        )
    : allSpecs;

// MCP Server (modern McpServer API with native Zod validation)
const server = new McpServer(
  { name: `${PROJECT_NAME}-rag`, version: "1.1.0" },
  { capabilities: { tools: {} } },
);

// Register tools with McpServer using wrapHandler middleware
for (const spec of activeSpecs) {
  const wrapped = wrapHandler(spec.name, spec.handler, { enricher, ctx });

  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.schema,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      annotations: spec.annotations,
    },
    async (args) => {
      const result = await wrapped(args as Record<string, unknown>, ctx);
      if (typeof result === "string") {
        return { content: [{ type: "text" as const, text: result }] };
      }
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
      };
    },
  );
}

// Graceful shutdown: close active session on exit
async function cleanup() {
  if (ctx.activeSessionId) {
    try {
      await api.post(`/api/session/${ctx.activeSessionId}/end`, {
        projectName: PROJECT_NAME,
        summary: "Session ended by MCP server shutdown",
        autoSaveLearnings: true,
      });
    } catch {
      // Best-effort, don't block shutdown
    }
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Phase 4: Transport selection — stdio | http | both
const MCP_TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const MCP_HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT || "3101");

async function main() {
  // Resolve project name from API key before starting
  await resolveProject();
  ctx.projectName = PROJECT_NAME;
  ctx.collectionPrefix = COLLECTION_PREFIX_FN();

  if (MCP_TRANSPORT === "stdio" || MCP_TRANSPORT === "both") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  if (MCP_TRANSPORT === "http" || MCP_TRANSPORT === "both") {
    await startHttpTransport(server, {
      port: MCP_HTTP_PORT,
      apiKey: API_KEY,
    });
  }

  console.error(
    `${PROJECT_NAME} RAG MCP server running (transport: ${MCP_TRANSPORT}, prefix: ${COLLECTION_PREFIX_FN()})`,
  );
  console.error(
    MCP_PROFILE === "lite"
      ? `Registered ${activeSpecs.length}/${allSpecs.length} tools [profile: lite] (the rest of the RAG API is reachable via run_agent)`
      : `Registered ${activeSpecs.length} tools [profile: full] (0 hidden)`,
  );
}

main().catch(console.error);
