import { describe, it, expect } from "vitest";
import {
  createSearchTools,
  HYBRID_SEARCH_DESCRIPTION,
  FIND_SYMBOL_DESCRIPTION,
  SEARCH_GRAPH_DESCRIPTION,
} from "../tools/search.js";
import {
  createMemoryTools,
  REMEMBER_DESCRIPTION,
  RECALL_DESCRIPTION,
} from "../tools/memory.js";
import {
  createSuggestionTools,
  CONTEXT_BRIEFING_DESCRIPTION,
} from "../tools/suggestions.js";

/**
 * M2-5 snapshot: the six high-frequency tools carry prescriptive trigger
 * descriptions at MODULE level (all profiles), each with:
 *   - a positive trigger ("Call this …")
 *   - a negative trigger / anti-trigger ("Do NOT …")
 *
 * The same wording is mirrored in rag-api/src/services/agent-profiles.ts
 * TOOL_DEFINITIONS (asserted by rag-api's agent-profiles tests) and re-exported
 * as LITE_DESCRIPTIONS in index.ts. If you change a description, change every
 * copy in the same PR.
 */

const SIX_TOOLS = [
  "hybrid_search",
  "find_symbol",
  "search_graph",
  "recall",
  "remember",
  "context_briefing",
] as const;

describe("trigger descriptions (M2-5)", () => {
  const specs = [
    ...createSearchTools("testproject"),
    ...createMemoryTools("testproject"),
    ...createSuggestionTools("testproject"),
  ];

  const byName = (name: string) => specs.find((s) => s.name === name)!;

  it.each(SIX_TOOLS)(
    "%s has a 'Call this' trigger AND a negative-trigger clause",
    (name) => {
      const spec = byName(name);
      expect(spec, name).toBeDefined();
      expect(spec.description).toContain("Call this");
      expect(spec.description).toMatch(/Do NOT/);
    },
  );

  it("context_briefing is scoped, not an absolute requirement", () => {
    const desc = byName("context_briefing").description;
    expect(desc).not.toMatch(/REQUIRED/);
    expect(desc).not.toMatch(/MUST/);
    expect(desc).toMatch(/single-line edits/);
  });

  it("remember's description demands non-obvious learnings with the why", () => {
    const desc = byName("remember").description;
    expect(desc).toContain("once per work item");
    expect(desc).toContain("non-obvious");
    expect(desc).toMatch(/decision/);
    expect(desc).toMatch(/gotcha/);
    expect(desc).toMatch(/procedure/);
    expect(desc).toMatch(/WHY/i);
    // The pollution-inviting catch-all enumeration is gone.
    expect(desc).not.toMatch(/decisions, insights, context, todos/);
  });

  it("module ToolSpecs use the exported constants (lite re-export contract)", () => {
    expect(byName("hybrid_search").description).toBe(HYBRID_SEARCH_DESCRIPTION);
    expect(byName("find_symbol").description).toBe(FIND_SYMBOL_DESCRIPTION);
    expect(byName("search_graph").description).toBe(SEARCH_GRAPH_DESCRIPTION);
    expect(byName("remember").description).toBe(REMEMBER_DESCRIPTION);
    expect(byName("recall").description).toBe(RECALL_DESCRIPTION);
    expect(byName("context_briefing").description).toBe(
      CONTEXT_BRIEFING_DESCRIPTION,
    );
  });
});
