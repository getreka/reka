/**
 * Tool annotations map for all MCP tools.
 *
 * Annotations help clients understand tool behaviour:
 *   readOnlyHint   – tool does NOT modify its environment
 *   destructiveHint – tool may delete or irreversibly change data
 *   idempotentHint  – repeated calls with same args have no extra effect
 *   openWorldHint   – tool interacts with external entities (RAG API)
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// ── Shorthand presets ───────────────────────────────────────

/** Read-only, idempotent – the vast majority of tools */
const RO: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Mutating but non-destructive (create / append) */
const MUT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Idempotent upsert (record_*, setup_project, validate, promote) */
const UPSERT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Destructive – may delete or irreversibly change data */
const DESTRUCT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// ── Per-tool annotations ────────────────────────────────────

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // ── search (5) ──────────────────────────────────────────
  hybrid_search: RO,
  search_docs: RO,
  get_project_stats: RO,
  find_symbol: RO,
  search_graph: RO,

  // ── indexing (2) ────────────────────────────────────────
  index_codebase: MUT,
  get_index_status: RO,

  // ── memory (7) ─────────────────────────────────────────
  remember: MUT,
  recall: RO,
  list_memories: RO,
  forget: DESTRUCT,
  batch_remember: MUT,
  review_memories: RO,
  promote_memory: UPSERT, // idempotent promotion

  // ── architecture (6) ───────────────────────────────────
  record_adr: UPSERT,
  get_adrs: RO,
  record_pattern: UPSERT,
  get_patterns: RO,
  record_tech_debt: UPSERT,
  get_tech_debt: RO,

  // ── confluence (4) ─────────────────────────────────────
  search_confluence: RO,
  index_confluence: MUT,
  get_confluence_status: RO,
  list_confluence_spaces: RO,

  // ── session (2) ────────────────────────────────────────
  start_session: MUT,
  end_session: MUT,

  // ── suggestions (2) ────────────────────────────────────
  context_briefing: RO,
  setup_project: UPSERT, // writes config (idempotent)

  // ── agents (2) ─────────────────────────────────────────
  run_agent: MUT, // side-effects depend on agent type
  get_agent_types: RO,
};
