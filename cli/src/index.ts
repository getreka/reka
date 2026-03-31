#!/usr/bin/env node

/**
 * Reka CLI — manage your self-hosted RAG infrastructure
 */

import { Command } from "commander";
import { loadConfig } from "./config";
import { createClient } from "./api";
import { statusCommand } from "./commands/status";
import { initCommand } from "./commands/init";
import { indexCommand } from "./commands/index";
import { searchCommand } from "./commands/search";
import { modelsListCommand, modelsTestCommand } from "./commands/models";

const program = new Command();

program
  .name("reka")
  .description("Reka — Memory your AI can trust")
  .version("0.1.0")
  .option("--api-url <url>", "RAG API URL")
  .option("--api-key <key>", "API key")
  .option("--project <name>", "Project name");

// reka init
program
  .command("init")
  .description("Initialize Reka for current project — generates API key and .mcp.json")
  .option("--project <name>", "Project name (defaults to directory name)")
  .option("-p, --path <path>", "Project path")
  .option("-f, --force", "Overwrite existing .mcp.json")
  .option("--cloud", "Connect to Reka Cloud instead of local")
  .option("--key <key>", "API key (required for --cloud)")
  .option("--api-url <url>", "RAG API URL (default: http://localhost:3100)")
  .action(async (opts) => {
    await initCommand(opts);
  });

// reka status
program
  .command("status")
  .description("Show Reka API and project status")
  .action(async () => {
    const config = loadConfig(getOverrides());
    const client = createClient(config);
    await statusCommand(client, config);
  });

// reka index [path]
program
  .command("index [path]")
  .description("Index a codebase for search")
  .option("-w, --watch", "Watch for file changes")
  .action(async (indexPath, opts) => {
    const config = loadConfig(getOverrides());
    const client = createClient(config);
    await indexCommand(client, config, { path: indexPath, ...opts });
  });

// reka search <query>
program
  .command("search <query>")
  .description("Search indexed codebase")
  .option("-l, --limit <n>", "Number of results", "5")
  .option("-t, --type <type>", "Collection type (codebase, docs, memory)")
  .action(async (query, opts) => {
    const config = loadConfig(getOverrides());
    const client = createClient(config);
    await searchCommand(client, config, query, opts);
  });

// reka models
const models = program.command("models").description("Manage model providers");

models
  .command("list")
  .description("List configured model providers and their status")
  .action(async () => {
    const config = loadConfig(getOverrides());
    await modelsListCommand(config);
  });

models
  .command("test")
  .description("Test connection to all model providers")
  .action(async () => {
    const config = loadConfig(getOverrides());
    await modelsTestCommand(config);
  });

// Helper to extract global overrides
function getOverrides() {
  const opts = program.opts();
  const overrides: any = {};
  if (opts.apiUrl || opts.apiKey) {
    overrides.api = {};
    if (opts.apiUrl) overrides.api.url = opts.apiUrl;
    if (opts.apiKey) overrides.api.key = opts.apiKey;
  }
  if (opts.project) {
    overrides.project = { name: opts.project };
  }
  return overrides;
}

program.parse();
