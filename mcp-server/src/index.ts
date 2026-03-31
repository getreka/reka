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
import { createSearchTools } from "./tools/search.js";
import { createAskTools } from "./tools/ask.js";
import { createIndexingTools } from "./tools/indexing.js";
import { createMemoryTools } from "./tools/memory.js";
import { createArchitectureTools } from "./tools/architecture.js";
import { createDatabaseTools } from "./tools/database.js";
import { createConfluenceTools } from "./tools/confluence.js";
import { createPmTools } from "./tools/pm.js";
import { createReviewTools } from "./tools/review.js";
import { createAnalyticsTools } from "./tools/analytics.js";
import { createClusteringTools } from "./tools/clustering.js";
import { createSessionTools } from "./tools/session.js";
import { createFeedbackTools } from "./tools/feedback.js";
import { createSuggestionTools } from "./tools/suggestions.js";
import { createCacheTools } from "./tools/cache.js";
import { createGuidelinesTools } from "./tools/guidelines.js";
import { createAdvancedTools } from "./tools/advanced.js";
import { createAgentTools } from "./tools/agents.js";
import { createQualityTools } from "./tools/quality.js";

// Configuration from environment
const PROJECT_NAME = process.env.PROJECT_NAME || "default";
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();
const RAG_API_URL = process.env.RAG_API_URL || "http://localhost:3100";
const RAG_API_KEY = process.env.RAG_API_KEY;
const COLLECTION_PREFIX = `${PROJECT_NAME}_`;

// API client
const api = createApiClient(
  RAG_API_URL,
  PROJECT_NAME,
  PROJECT_PATH,
  RAG_API_KEY,
);

// Mutable tool context shared by all handlers (session state updates in-place)
const ctx: ToolContext = {
  api,
  projectName: PROJECT_NAME,
  projectPath: PROJECT_PATH,
  collectionPrefix: COLLECTION_PREFIX,
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
  ...createAskTools(PROJECT_NAME),
  ...createIndexingTools(PROJECT_NAME),
  ...createMemoryTools(PROJECT_NAME),
  ...createArchitectureTools(PROJECT_NAME),
  ...createDatabaseTools(PROJECT_NAME),
  ...createConfluenceTools(PROJECT_NAME),
  ...createPmTools(PROJECT_NAME),
  ...createReviewTools(PROJECT_NAME),
  ...createAnalyticsTools(PROJECT_NAME),
  ...createClusteringTools(PROJECT_NAME),
  ...createSessionTools(PROJECT_NAME, ctx),
  ...createFeedbackTools(PROJECT_NAME),
  ...createSuggestionTools(PROJECT_NAME),
  ...createCacheTools(PROJECT_NAME),
  ...createGuidelinesTools(PROJECT_NAME),
  ...createAdvancedTools(PROJECT_NAME),
  ...createAgentTools(PROJECT_NAME),
  ...createQualityTools(PROJECT_NAME),
];

// Core tools exposed directly to Claude (~35 tools).
// Hidden tools remain accessible via run_agent (agent runtime calls API directly).
const CORE_TOOLS = new Set([
  // Search (6)
  "search_codebase",
  "hybrid_search",
  "search_graph",
  "find_symbol",
  "search_docs",
  "find_feature",
  // Ask (2)
  "ask_codebase",
  "explain_code",
  // Index (3)
  "index_codebase",
  "get_index_status",
  "get_project_stats",
  // Memory (7)
  "remember",
  "recall",
  "list_memories",
  "forget",
  "batch_remember",
  "promote_memory",
  "review_memories",
  // Architecture (6)
  "record_adr",
  "get_adrs",
  "record_pattern",
  "get_patterns",
  "record_tech_debt",
  "get_tech_debt",
  // Context (3)
  "context_briefing",
  "smart_dispatch",
  "setup_project",
  // Session (2)
  "start_session",
  "end_session",
  // Confluence (2)
  "search_confluence",
  "index_confluence",
  // DB (4)
  "record_table",
  "get_table_info",
  "check_db_schema",
  "get_db_rules",
  // Agents (1)
  "run_agent",
]);

const coreSpecs = allSpecs.filter((s) => CORE_TOOLS.has(s.name));

// MCP Server (modern McpServer API with native Zod validation)
const server = new McpServer(
  { name: `${PROJECT_NAME}-rag`, version: "1.1.0" },
  { capabilities: { tools: {} } },
);

// Register core tools with McpServer using wrapHandler middleware
for (const spec of coreSpecs) {
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
  if (MCP_TRANSPORT === "stdio" || MCP_TRANSPORT === "both") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  if (MCP_TRANSPORT === "http" || MCP_TRANSPORT === "both") {
    await startHttpTransport(server, {
      port: MCP_HTTP_PORT,
      apiKey: RAG_API_KEY,
    });
  }

  console.error(
    `${PROJECT_NAME} RAG MCP server running (transport: ${MCP_TRANSPORT}, prefix: ${COLLECTION_PREFIX})`,
  );
  console.error(
    `Registered ${coreSpecs.length}/${allSpecs.length} core tools (${allSpecs.length - coreSpecs.length} hidden, accessible via run_agent)`,
  );
}

main().catch(console.error);
