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
  demo?: boolean;
  cloud?: boolean;
  key?: string;
  apiUrl?: string;
}) {
  const projectPath = opts.path || process.cwd();
  const projectName = opts.project || path.basename(projectPath);

  // Demo mode: device authorization flow
  if (opts.demo) {
    const demoApiUrl = "https://rag.akeryuu.com";
    const axios = (await import("axios")).default;

    console.log(chalk.bold("\n  Connecting to Reka Demo...\n"));

    try {
      // Step 1: Create device session
      const { data: device } = await axios.post(
        `${demoApiUrl}/api/auth/device`,
      );

      // Step 2: Open browser
      console.log(
        `  Your verification code: ${chalk.bold.cyan(device.userCode)}`,
      );
      console.log(`  Opening browser to sign in...\n`);

      try {
        const open = (await import("open")).default;
        await open(device.verificationUrl);
      } catch {
        console.log(`  Open this URL in your browser:`);
        console.log(`  ${chalk.cyan(device.verificationUrl)}\n`);
      }

      // Step 3: Poll for completion
      const ora = (await import("ora")).default;
      const spinner = ora("  Waiting for authentication...").start();
      const deadline = Date.now() + device.expiresIn * 1000;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, device.interval * 1000));

        const { data: poll } = await axios.get(
          `${demoApiUrl}/api/auth/poll?device_code=${device.deviceCode}`,
        );

        if (poll.status === "completed") {
          spinner.succeed("Authenticated!");
          writeMcpConfig(projectPath, poll.apiKey, opts.force, poll.apiUrl);
          console.log(chalk.green(`  ✓ Project: ${poll.projectName}`));
          console.log(chalk.green(`  ✓ .mcp.json written`));
          console.log("");
          console.log(
            "  Your AI assistant now has memory. Open it and start asking!",
          );
          console.log(
            chalk.yellow("  Note: demo data may be reset periodically."),
          );
          console.log("");
          return;
        }

        if (poll.status === "expired") {
          spinner.fail("Authentication expired. Run the command again.");
          return;
        }
      }

      spinner.fail("Authentication timed out. Run the command again.");
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message;
      console.log(chalk.red(`\n  Demo unavailable: ${msg}`));
      console.log(
        chalk.yellow(`  Try self-hosted instead: docker-compose up -d\n`),
      );
    }
    return;
  }

  // Cloud mode: coming soon
  if (opts.cloud) {
    console.log("");
    console.log(chalk.bold("  Reka Cloud — coming soon"));
    console.log("");
    console.log(
      "  Managed RAG with zero infrastructure. Hybrid and fully managed options.",
    );
    console.log(`  Join the waitlist: ${chalk.cyan("https://getreka.dev")}`);
    console.log("");
    console.log("  In the meantime, self-hosted works great:");
    console.log(`    ${chalk.bold("docker-compose up -d")}`);
    console.log(
      `    ${chalk.bold(`npx @getreka/cli init --project ${projectName}`)}`,
    );
    console.log("");
    return;
  }

  // Self-hosted: generate key via local API
  const config = loadConfig({
    api: { url: opts.apiUrl || "http://localhost:3100" },
    project: { name: projectName, path: projectPath },
  });
  const client = createClient(config);

  console.log(
    `\n  Generating API key for project ${chalk.bold(projectName)}...`,
  );

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
    console.log(
      "  Your AI assistant now has memory. Try asking it about your codebase!",
    );
    console.log("");
  } catch (err: any) {
    const msg = err.response?.data?.error || err.message;
    console.log(chalk.red(`\n  Failed to generate key: ${msg}`));
    console.log(
      chalk.yellow(
        `  Is the Reka API running? Start with: docker-compose up -d\n`,
      ),
    );
  }
}

function writeMcpConfig(
  projectPath: string,
  apiKey: string,
  force?: boolean,
  apiUrl?: string,
) {
  const mcpPath = path.join(projectPath, ".mcp.json");
  const env: Record<string, string> = { REKA_API_KEY: apiKey };
  if (apiUrl) env.REKA_API_URL = apiUrl;

  const rekaEntry = {
    command: "npx",
    args: ["-y", "@getreka/mcp"],
    env,
  };

  if (fs.existsSync(mcpPath) && !force) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers.reka = rekaEntry;
      fs.writeFileSync(
        mcpPath,
        JSON.stringify(existing, null, 2) + "\n",
        "utf-8",
      );
      return;
    } catch {
      // Fall through to overwrite
    }
  }

  const config = { mcpServers: { reka: rekaEntry } };
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
