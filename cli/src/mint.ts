/**
 * API-key resolution for `reka init` (LB-3).
 *
 * Resolution order:
 *   1. --key flag
 *   2. key already present in .mcp.json (verified against /api/whoami;
 *      skipped with --force)
 *   3. mint via the local rag-api Docker container (see init.ts for the
 *      full mechanism notes)
 *   4. interactive prompt, with a pointer to the docker-exec admin path
 *
 * All side effects (docker exec, HTTP, stdin) are injected via MintDeps so
 * the fallback order is unit-testable.
 */

export interface MintDeps {
  /** Run a command without a shell; rejects on non-zero exit. */
  execFile(cmd: string, args: string[]): Promise<{ stdout: string }>;
  /** GET url with headers; resolves { status } or rejects on network error. */
  httpGet(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number }>;
  prompt(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface MintOptions {
  projectName: string;
  apiUrl: string;
  /** rag-api container name (--container / REKA_CONTAINER / "reka-api"). */
  container: string;
  /** --key flag value. */
  key?: string;
  /** Key found in an existing .mcp.json entry. */
  existingKey?: string;
  /** --force: ignore the existing key and mint a fresh one. */
  force?: boolean;
}

export interface MintResult {
  key: string;
  source: "flag" | "existing" | "minted" | "prompt";
  /** keys.json id — needed to revoke the key later. */
  keyId?: string;
  /** True when the container had to be restarted to load the new key. */
  restarted?: boolean;
}

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const KEY_LABEL = "cli-init";

/**
 * Script executed inside the container via `docker exec <name> node -e`.
 * Tries the live admin endpoint first (key becomes valid immediately);
 * falls back to the offline auth module (requires a container restart).
 * Prints a single JSON line: {"key":"rk_...","id":"...","live":bool}.
 */
export function buildMintScript(projectName: string): string {
  const project = JSON.stringify(projectName);
  const label = JSON.stringify(KEY_LABEL);
  return [
    "(async () => {",
    "  const port = process.env.API_PORT || process.env.PORT || 3100;",
    "  try {",
    "    const r = await fetch('http://127.0.0.1:' + port + '/api/keys', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    `      body: JSON.stringify({ projectName: ${project}, label: ${label} }),`,
    "    });",
    "    if (r.ok) {",
    "      const d = await r.json();",
    "      if (d.key) {",
    "        console.log(JSON.stringify({ key: d.key, id: d.id, live: true }));",
    "        return;",
    "      }",
    "    }",
    "  } catch {}",
    "  const { generateKey } = require('./dist/middleware/auth');",
    `  const e = generateKey(${project}, ${label});`,
    "  console.log(JSON.stringify({ key: e.key, id: e.id, live: false }));",
    "})();",
  ].join("\n");
}

/** Extracts the {"key":...} JSON line from mixed stdout (logger noise). */
export function parseMintOutput(
  stdout: string,
): { key: string; id?: string; live: boolean } | null {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.key === "string" && parsed.key.startsWith("rk_")) {
        return { key: parsed.key, id: parsed.id, live: !!parsed.live };
      }
    } catch {
      // not our line
    }
  }
  return null;
}

/** true = valid, false = rejected, null = API unreachable. */
export async function verifyKey(
  apiUrl: string,
  key: string,
  deps: Pick<MintDeps, "httpGet">,
): Promise<boolean | null> {
  try {
    const { status } = await deps.httpGet(`${apiUrl}/api/whoami`, {
      "X-Api-Key": key,
    });
    return status === 200;
  } catch {
    return null;
  }
}

async function waitForHealth(
  apiUrl: string,
  deps: Pick<MintDeps, "httpGet" | "sleep">,
  attempts = 60,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { status } = await deps.httpGet(`${apiUrl}/api/health`);
      if (status === 200) return true;
    } catch {
      // still starting
    }
    await deps.sleep(1000);
  }
  return false;
}

async function containerRunning(
  container: string,
  deps: Pick<MintDeps, "execFile">,
): Promise<boolean> {
  try {
    const { stdout } = await deps.execFile("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      container,
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function dockerMintHint(container: string, projectName: string): string {
  return (
    `docker exec ${container} node -e "const {generateKey}=require('./dist/middleware/auth'); ` +
    `console.log(generateKey('${projectName}','${KEY_LABEL}').key)" ` +
    `&& docker restart ${container}`
  );
}

async function mintViaDocker(
  opts: MintOptions,
  deps: MintDeps,
): Promise<MintResult | null> {
  if (!PROJECT_NAME_RE.test(opts.projectName)) {
    deps.log(
      `Project name "${opts.projectName}" contains characters unsafe for key minting.`,
    );
    return null;
  }

  if (!(await containerRunning(opts.container, deps))) {
    deps.log(
      `Container "${opts.container}" not found or not running (override with --container or REKA_CONTAINER).`,
    );
    return null;
  }

  let output;
  try {
    const { stdout } = await deps.execFile("docker", [
      "exec",
      opts.container,
      "node",
      "-e",
      buildMintScript(opts.projectName),
    ]);
    output = parseMintOutput(stdout);
  } catch (err: any) {
    deps.log(`Key minting failed: ${err?.message || err}`);
    return null;
  }
  if (!output) {
    deps.log("Key minting returned no key.");
    return null;
  }

  let restarted = false;
  if (!output.live) {
    // Key persisted to data/keys.json but the running server only loads
    // keys at startup — restart to activate it.
    deps.log(
      `Restarting ${opts.container} to load the new key (keys are read at startup)...`,
    );
    try {
      await deps.execFile("docker", ["restart", opts.container]);
      restarted = true;
    } catch (err: any) {
      deps.log(`Container restart failed: ${err?.message || err}`);
      return null;
    }
    if (!(await waitForHealth(opts.apiUrl, deps))) {
      deps.log("API did not come back healthy after restart.");
      return null;
    }
  }

  const valid = await verifyKey(opts.apiUrl, output.key, deps);
  if (valid === false) {
    deps.log("Minted key was rejected by the API — falling back.");
    return null;
  }

  return { key: output.key, source: "minted", keyId: output.id, restarted };
}

export async function resolveApiKey(
  opts: MintOptions,
  deps: MintDeps,
): Promise<MintResult> {
  // 1. Explicit flag always wins.
  if (opts.key) {
    return { key: opts.key, source: "flag" };
  }

  // 2. Reuse the key already in .mcp.json (idempotent re-runs must not
  //    mint a new key every time). --force skips reuse.
  if (opts.existingKey && !opts.force) {
    const valid = await verifyKey(opts.apiUrl, opts.existingKey, deps);
    if (valid !== false) {
      if (valid === null) {
        deps.log("API unreachable — keeping the existing key unverified.");
      }
      return { key: opts.existingKey, source: "existing" };
    }
    deps.log("Existing key in .mcp.json was rejected — minting a new one.");
  }

  // 3. Mint via the local rag-api container.
  const minted = await mintViaDocker(opts, deps);
  if (minted) return minted;

  // 4. Interactive prompt with a pointer to the docker-exec admin path.
  const answer = (
    await deps.prompt(
      `Paste an API key for project "${opts.projectName}" ` +
        `(admins can mint one with:\n  ${dockerMintHint(opts.container, opts.projectName)}\n): `,
    )
  ).trim();
  if (!answer) {
    throw new Error("No API key provided.");
  }
  return { key: answer, source: "prompt" };
}
