/**
 * .mcp.json server-entry normalization.
 *
 * Target server name is "rag" (matches what the docs and the reka plugin
 * expect). Historic inits wrote "reka" (old CLI) or "<project>-rag"
 * (mcp-server setup_project), so init detects those, merges them into a
 * single "rag" entry, and never duplicates on re-run.
 */

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export const TARGET_SERVER_NAME = "rag";

/** Packages that identify an entry as a Reka MCP server. */
const REKA_MCP_PACKAGES = /@getreka\/mcp|@crowley\/rag-mcp/;

export function isRekaMcpEntry(entry: McpServerEntry | undefined): boolean {
  if (!entry) return false;
  const haystack = [entry.command || "", ...(entry.args || [])].join(" ");
  return REKA_MCP_PACKAGES.test(haystack);
}

/**
 * Names that may hold a legacy Reka entry, in merge order
 * (oldest first — later entries win env conflicts, new entry wins last).
 */
export function candidateNames(projectName: string): string[] {
  return ["reka", `${projectName}-rag`, TARGET_SERVER_NAME];
}

/**
 * Returns the names of existing entries that are Reka MCP servers and
 * should be folded into the single "rag" entry.
 */
export function findRekaCandidates(
  config: McpConfig,
  projectName: string,
): string[] {
  const servers = config.mcpServers || {};
  return candidateNames(projectName).filter((name) =>
    isRekaMcpEntry(servers[name]),
  );
}

/**
 * Extracts a previously-configured API key from candidate entries
 * (most authoritative first: rag → <project>-rag → reka).
 */
export function extractExistingKey(
  config: McpConfig,
  projectName: string,
): string | undefined {
  const servers = config.mcpServers || {};
  for (const name of [...candidateNames(projectName)].reverse()) {
    const entry = servers[name];
    if (isRekaMcpEntry(entry) && entry?.env?.REKA_API_KEY) {
      return entry.env.REKA_API_KEY;
    }
  }
  return undefined;
}

export interface MergeResult {
  config: McpConfig;
  /** Legacy entry names that were removed/renamed into "rag". */
  removed: string[];
}

/**
 * Pure merge: folds legacy Reka entries into a single "rag" entry.
 * - command/args always come from `newEntry` (that's the upgrade path)
 * - env is merged: legacy values are preserved unless `newEntry.env`
 *   overwrites them
 * - non-Reka servers are left untouched
 * - idempotent: applying twice yields the same config
 */
export function mergeRagServer(
  config: McpConfig,
  projectName: string,
  newEntry: McpServerEntry,
): MergeResult {
  const result: McpConfig = { ...config, mcpServers: { ...config.mcpServers } };
  const servers = result.mcpServers as Record<string, McpServerEntry>;

  const candidates = findRekaCandidates(result, projectName);
  const mergedEnv: Record<string, string> = {};
  for (const name of candidates) {
    Object.assign(mergedEnv, servers[name].env || {});
    delete servers[name];
  }
  Object.assign(mergedEnv, newEntry.env || {});

  servers[TARGET_SERVER_NAME] = { ...newEntry, env: mergedEnv };

  return {
    config: result,
    removed: candidates.filter((n) => n !== TARGET_SERVER_NAME),
  };
}
