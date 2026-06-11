import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { createClient } from "../api";
import { loadConfig } from "../config";
import { extractExistingKey } from "../mcp-config";
import { MintDeps, resolveApiKey } from "../mint";
import {
  applyProjectFiles,
  buildRagEntry,
  readMcpConfig,
} from "../setup-files";

/*
 * KEY MINTING MECHANISM (LB-3)
 * ----------------------------
 * Self-hosted rag-api uses deny-by-default API-key auth; keys live in
 * data/keys.json inside the container and are loaded ONCE at startup
 * (rag-api/src/middleware/auth.ts — no file watcher). POST /api/keys is
 * admin-gated: it sits BEHIND authMiddleware (needs any valid key) and
 * requireAdmin (loopback socket or X-Admin-Key). From the host, a Docker
 * published port is never a loopback socket for the container, so the CLI
 * cannot mint over plain HTTP.
 *
 * Resolution order when running `reka init`:
 *   1. --key flag — used as-is.
 *   2. Existing REKA_API_KEY in .mcp.json (verified via GET /api/whoami) —
 *      keeps re-runs idempotent: no duplicate keys, no restarts.
 *      Skipped with --force.
 *   3. Docker mint: discover the rag-api container (default "reka-api",
 *      override via --container or REKA_CONTAINER) and run
 *        docker exec <container> node -e "<script>"
 *      The script first POSTs http://127.0.0.1:<API_PORT>/api/keys from
 *      INSIDE the container — that's a loopback socket, so requireAdmin
 *      passes, and when ALLOW_ANONYMOUS=true (dev) authMiddleware passes
 *      too; the key is registered in the live process immediately.
 *      If that returns 401/403 (prod: keys configured, anonymous off), it
 *      falls back to the same module the server uses:
 *        const {generateKey}=require('./dist/middleware/auth');
 *        generateKey('<project>','cli-init')
 *      generateKey PERSISTS the hash to data/keys.json (saveKeys) and
 *      returns the plaintext once — but only the exec'd process has it in
 *      memory, so the CLI then runs `docker restart <container>`, waits
 *      for /api/health, and verifies the key with an authed /api/whoami.
 *   4. Interactive prompt, printing the docker-exec admin one-liner so an
 *      operator can mint out-of-band.
 */

const execFile = promisify(execFileCb);

function defaultMintDeps(): MintDeps {
  return {
    execFile: async (cmd, args) => {
      const { stdout } = await execFile(cmd, args, { timeout: 60000 });
      return { stdout };
    },
    httpGet: async (url, headers) => {
      const axios = (await import("axios")).default;
      const res = await axios.get(url, {
        headers,
        timeout: 10000,
        validateStatus: () => true,
      });
      return { status: res.status };
    },
    prompt: (question) => {
      if (!process.stdin.isTTY) {
        return Promise.reject(
          new Error("No API key available and stdin is not a TTY."),
        );
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return new Promise((resolve) =>
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        }),
      );
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (msg) => console.log(chalk.yellow(`  ${msg}`)),
  };
}

export async function initCommand(opts: {
  project?: string;
  path?: string;
  force?: boolean;
  demo?: boolean;
  cloud?: boolean;
  key?: string;
  apiUrl?: string;
  container?: string;
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

  // Cloud mode: no hosted offering — be honest about what exists
  if (opts.cloud) {
    console.log("");
    console.log(chalk.bold("  Reka Cloud — there is no hosted Reka today"));
    console.log("");
    console.log(
      "  Reka is self-hosted: your code and memory stay on your machines.",
    );
    console.log(
      "  A self-hosted Team license (multi-user, support) is planned,",
    );
    console.log("  gated on real adoption of the open release.");
    console.log("");
    console.log(
      `  Interested in the Team tier? Tell us: ${chalk.cyan("https://getreka.dev")}`,
    );
    console.log("");
    console.log("  Get started self-hosted today:");
    console.log(`    ${chalk.bold("docker-compose up -d")}`);
    console.log(
      `    ${chalk.bold(`npx @getreka/cli init --project ${projectName}`)}`,
    );
    console.log("");
    return;
  }

  // Self-hosted
  const apiUrl =
    opts.apiUrl || process.env.REKA_API_URL || "http://localhost:3100";
  const container = opts.container || process.env.REKA_CONTAINER || "reka-api";

  console.log(
    `\n  Initializing Reka for project ${chalk.bold(projectName)}...\n`,
  );

  // 1. Resolve API key: --key → existing .mcp.json key → docker mint → prompt
  const existingKey = extractExistingKey(
    opts.force ? {} : readMcpConfig(projectPath),
    projectName,
  );

  let mintResult;
  try {
    mintResult = await resolveApiKey(
      {
        projectName,
        apiUrl,
        container,
        key: opts.key,
        existingKey,
        force: opts.force,
      },
      defaultMintDeps(),
    );
  } catch (err: any) {
    console.log(chalk.red(`\n  Failed to obtain an API key: ${err.message}`));
    console.log(
      chalk.yellow(
        `  Is the Reka API running? Start with: docker-compose up -d\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const sourceLabel = {
    flag: "from --key",
    existing: "reused from .mcp.json",
    minted: `minted via container "${container}"`,
    prompt: "entered manually",
  }[mintResult.source];
  console.log(
    chalk.green(
      `  ✓ API key ${sourceLabel}: ${mintResult.key.slice(0, 20)}...`,
    ),
  );
  if (mintResult.restarted) {
    console.log(
      chalk.green(`  ✓ Container "${container}" restarted to load the key`),
    );
  }

  // 2. Write project files (.mcp.json + CLAUDE.md + permissions)
  const entry = buildRagEntry({
    apiUrl,
    projectName,
    projectPath,
    apiKey: mintResult.key,
  });
  const { changes } = applyProjectFiles({
    projectPath,
    projectName,
    entry,
    force: opts.force,
  });
  for (const change of changes) {
    console.log(chalk.green(`  ✓ ${change}`));
  }

  // 3. Index status check (non-fatal)
  const config = loadConfig({
    api: { url: apiUrl, key: mintResult.key },
    project: { name: projectName, path: projectPath },
  });
  const client = createClient(config);
  try {
    const { data } = await client.get(
      `/api/index/status/${projectName}_codebase`,
    );
    console.log(
      chalk.green(
        `  ✓ Index status: ${data.status || "unknown"} (${data.vectorCount ?? "N/A"} vectors)`,
      ),
    );
  } catch {
    console.log(
      chalk.yellow(
        `  ! Not indexed yet — run \`reka index\` (or the index_codebase tool) to enable search.`,
      ),
    );
  }

  console.log("");
  console.log("  Next steps:");
  console.log("    1. Restart Claude Code to load the MCP server");
  console.log("    2. Index the codebase if you haven't: reka index");
  console.log("    3. Use context_briefing before code changes");
  console.log("");
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
