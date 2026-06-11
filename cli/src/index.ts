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
import { modelsListCommand, modelsTestCommand } from "./commands/models";

const program = new Command();

program
  .name("reka")
  .description("Reka — Memory your AI can trust")
  .version("0.3.0")
  .option("--api-url <url>", "RAG API URL")
  .option("--api-key <key>", "API key")
  .option("--project <name>", "Project name");

// reka init
program
  .command("init")
  .description(
    "Initialize Reka for current project — generates API key and .mcp.json",
  )
  .option("--project <name>", "Project name (defaults to directory name)")
  .option("-p, --path <path>", "Project path")
  .option("-f, --force", "Overwrite existing .mcp.json")
  .option("--demo", "Connect to the Reka demo instance")
  .option(
    "--cloud",
    "Info on hosted Reka (none today; self-hosted Team license planned)",
  )
  .option("--key <key>", "Use an existing API key instead of minting one")
  .option(
    "--container <name>",
    "rag-api Docker container used to mint keys (default: reka-api, env REKA_CONTAINER)",
  )
  .option("--api-url <url>", "RAG API URL (default: http://localhost:3100)")
  .action(async (opts) => {
    // Global options with the same name (--project, --api-url, --api-key)
    // are captured by the program, not the subcommand — merge them in.
    const globals = program.opts();
    await initCommand({
      ...opts,
      project: opts.project ?? globals.project,
      apiUrl: opts.apiUrl ?? globals.apiUrl,
      key: opts.key ?? globals.apiKey,
    });
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
