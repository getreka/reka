import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { createClient } from "../api";
import { loadConfig } from "../config";

const MCP_TEMPLATE = `{
  "mcpServers": {
    "reka": {
      "command": "npx",
      "args": ["-y", "@getreka/mcp"],
      "env": {
        "REKA_API_KEY": "{{API_KEY}}"
      }
    }
  }
}`;

export async function initCommand(opts: {
  project?: string;
  path?: string;
  force?: boolean;
  cloud?: boolean;
  key?: string;
  apiUrl?: string;
}) {
  const projectPath = opts.path || process.cwd();
  const projectName = opts.project || path.basename(projectPath);

  // Cloud mode: use provided key, skip keygen
  if (opts.cloud || opts.key) {
    if (!opts.key) {
      console.log(
        chalk.red("\n  --key is required for cloud mode. Get one at https://getreka.dev/dashboard\n"),
      );
      return;
    }
    writeMcpConfig(projectPath, opts.key, opts.force);
    console.log(chalk.green(`\n  ✓ Connected to Reka Cloud`));
    console.log(`  Project will be resolved from your API key.\n`);
    return;
  }

  // Self-hosted: generate key via local API
  const config = loadConfig({
    api: { url: opts.apiUrl },
    project: { name: projectName, path: projectPath },
  });
  const client = createClient(config);

  console.log(`\n  Generating API key for project ${chalk.bold(projectName)}...`);

  try {
    const { data } = await client.post("/api/keys", {
      projectName,
      label: `init-${Date.now()}`,
    });

    const apiKey = data.key as string;

    writeMcpConfig(projectPath, apiKey, opts.force);

    console.log(chalk.green(`  ✓ API key created: ${apiKey.slice(0, 20)}...`));
    console.log(chalk.green(`  ✓ .mcp.json written`));
    console.log("");
    console.log("  Your AI assistant now has memory. Try asking it about your codebase!");
    console.log("");
  } catch (err: any) {
    const msg = err.response?.data?.error || err.message;
    console.log(chalk.red(`\n  Failed to generate key: ${msg}`));
    console.log(
      chalk.yellow(`  Is the Reka API running? Start with: docker-compose up -d\n`),
    );
  }
}

function writeMcpConfig(projectPath: string, apiKey: string, force?: boolean) {
  const mcpPath = path.join(projectPath, ".mcp.json");

  if (fs.existsSync(mcpPath) && !force) {
    // Merge into existing .mcp.json
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers.reka = {
        command: "npx",
        args: ["-y", "@getreka/mcp"],
        env: { REKA_API_KEY: apiKey },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      return;
    } catch {
      // Fall through to overwrite
    }
  }

  const content = MCP_TEMPLATE.replace("{{API_KEY}}", apiKey);
  fs.writeFileSync(mcpPath, content + "\n", "utf-8");
}
