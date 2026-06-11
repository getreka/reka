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
  // ── search (8) ──────────────────────────────────────────
  search_codebase: RO,
  search_similar: RO,
  grouped_search: RO,
  hybrid_search: RO,
  search_docs: RO,
  get_project_stats: RO,
  find_symbol: RO,
  search_graph: RO,

  // ── indexing (4) ────────────────────────────────────────
  index_codebase: MUT,
  get_index_status: RO,
  reindex_zero_downtime: MUT,
  list_aliases: RO,

  // ── memory (8) ─────────────────────────────────────────
  remember: MUT,
  recall: RO,
  list_memories: RO,
  forget: DESTRUCT,
  batch_remember: MUT,
  review_memories: RO,
  promote_memory: UPSERT, // idempotent promotion
  memory_maintenance: DESTRUCT, // prunes old memories

  // ── architecture (9) ───────────────────────────────────
  record_adr: UPSERT,
  get_adrs: RO,
  record_pattern: UPSERT,
  get_patterns: RO,
  check_architecture: RO,
  suggest_architecture: RO,
  record_tech_debt: UPSERT,
  get_tech_debt: RO,
  analyze_project_structure: RO,

  // ── database (8) ───────────────────────────────────────
  record_table: UPSERT,
  get_table_info: RO,
  record_db_rule: UPSERT,
  get_db_rules: RO,
  record_enum: UPSERT,
  get_enums: RO,
  check_db_schema: RO,
  suggest_db_schema: RO,

  // ── confluence (4) ─────────────────────────────────────
  search_confluence: RO,
  index_confluence: MUT,
  get_confluence_status: RO,
  list_confluence_spaces: RO,

  // ── pm (7) ─────────────────────────────────────────────
  search_requirements: RO,
  analyze_requirements: RO,
  estimate_feature: RO,
  get_feature_status: RO,
  list_requirements: RO,
  ask_pm: RO,
  generate_spec: RO,

  // ── review (3) ─────────────────────────────────────────
  review_code: RO, // generates review, no side-effects
  generate_tests: RO, // generates test suggestions
  analyze_tests: RO,

  // ── analytics (7) ──────────────────────────────────────
  get_tool_analytics: RO,
  get_knowledge_gaps: RO,
  get_analytics: RO,
  backup_collection: MUT, // creates a backup snapshot
  list_backups: RO,
  enable_quantization: DESTRUCT, // irreversible vector re-encoding
  get_platform_stats: RO,

  // ── session (5) ────────────────────────────────────────
  summarize_context: RO,
  summarize_changes: RO,
  start_session: MUT,
  get_session_context: RO,
  end_session: MUT,

  // ── suggestions (2) ────────────────────────────────────
  context_briefing: RO,
  setup_project: UPSERT, // writes config (idempotent)

  // ── cache (2) ──────────────────────────────────────────
  get_cache_stats: RO,
  warm_cache: MUT,

  // ── guidelines (1) ─────────────────────────────────────
  get_rag_guidelines: RO,

  // ── agents (2) ─────────────────────────────────────────
  run_agent: MUT, // side-effects depend on agent type
  get_agent_types: RO,
};
