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
import { ContextEnricher } from "./context-enrichment.js";
import { wrapHandler } from "./tool-middleware.js";
import type { ToolContext, ToolSpec } from "./types.js";

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

// Configuration from environment
const PROJECT_NAME = process.env.PROJECT_NAME || "default";
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();
const RAG_API_URL = process.env.RAG_API_URL || "http://localhost:3100";
const RAG_API_KEY = process.env.RAG_API_KEY;
const COLLECTION_PREFIX = `${PROJECT_NAME}_`;

// API client
const api = createApiClient(RAG_API_URL, PROJECT_NAME, PROJECT_PATH, RAG_API_KEY);

// Mutable tool context shared by all handlers (session state updates in-place)
const ctx: ToolContext = {
  api,
  projectName: PROJECT_NAME,
  projectPath: PROJECT_PATH,
  collectionPrefix: COLLECTION_PREFIX,
  enrichmentEnabled: true,
};

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
];

// MCP Server (modern McpServer API with native Zod validation)
const server = new McpServer(
  { name: `${PROJECT_NAME}-rag`, version: "1.0.5" },
  { capabilities: { tools: {} } }
);

// Register all tools with McpServer using wrapHandler middleware
for (const spec of allSpecs) {
  const wrapped = wrapHandler(spec.name, spec.handler, { enricher, ctx });

  server.registerTool(spec.name, {
    description: spec.description,
    inputSchema: spec.schema,
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    annotations: spec.annotations,
  }, async (args) => {
    const result = await wrapped(args as Record<string, unknown>, ctx);
    if (typeof result === "string") {
      return { content: [{ type: "text" as const, text: result }] };
    }
    return {
      content: [{ type: "text" as const, text: result.text }],
      structuredContent: result.structured,
    };
  });
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${PROJECT_NAME} RAG MCP server running (collection prefix: ${COLLECTION_PREFIX})`);
  console.error(`Registered ${allSpecs.length} tools from 18 modules`);
}

main().catch(console.error);
