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

  // ── ask (5) ─────────────────────────────────────────────
  ask_codebase: RO,
  explain_code: RO,
  find_feature: RO,
  analyze_conversation: RO,
  auto_remember: MUT, // creates memory from conversation

  // ── indexing (4) ────────────────────────────────────────
  index_codebase: MUT,
  get_index_status: RO,
  reindex_zero_downtime: MUT,
  list_aliases: RO,

  // ── memory (11) ────────────────────────────────────────
  remember: MUT,
  recall: RO,
  list_memories: RO,
  forget: DESTRUCT,
  update_todo: MUT,
  batch_remember: MUT,
  validate_memory: UPSERT, // idempotent status update
  review_memories: RO,
  promote_memory: UPSERT, // idempotent promotion
  run_quality_gates: MUT, // may update memory status
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

  // ── analytics (8) ──────────────────────────────────────
  get_tool_analytics: RO,
  get_knowledge_gaps: RO,
  get_analytics: RO,
  backup_collection: MUT, // creates a backup snapshot
  list_backups: RO,
  enable_quantization: DESTRUCT, // irreversible vector re-encoding
  get_platform_stats: RO,
  get_prediction_stats: RO,

  // ── clustering (4) ─────────────────────────────────────
  cluster_code: RO, // computes clusters, no persistence
  find_duplicates: RO,
  recommend_similar: RO,
  extract_learnings: RO,

  // ── session (7) ────────────────────────────────────────
  summarize_context: RO,
  summarize_changes: RO,
  analyze_usage_patterns: RO,
  get_developer_profile: RO,
  start_session: MUT,
  get_session_context: RO,
  end_session: MUT,

  // ── feedback (4) ───────────────────────────────────────
  feedback_search: MUT, // stores search feedback
  feedback_memory: MUT, // stores memory feedback
  suggest_better_query: RO,
  get_quality_metrics: RO,

  // ── suggestions (7) ────────────────────────────────────
  context_briefing: RO,
  get_contextual_suggestions: RO,
  suggest_related_code: RO,
  suggest_implementation: RO,
  suggest_tests: RO,
  get_code_context: RO,
  setup_project: UPSERT, // writes config (idempotent)

  // ── cache (2) ──────────────────────────────────────────
  get_cache_stats: RO,
  warm_cache: MUT,

  // ── guidelines (1) ─────────────────────────────────────
  get_rag_guidelines: RO,

  // ── advanced (5) ───────────────────────────────────────
  merge_memories: DESTRUCT, // merges → deletes originals
  get_completion_context: RO,
  get_import_suggestions: RO,
  get_type_context: RO,
  get_behavior_patterns: RO,

  // ── agents (2) ─────────────────────────────────────────
  run_agent: MUT, // side-effects depend on agent type
  get_agent_types: RO,
};
