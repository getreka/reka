import { describe, it, expect } from "vitest";
import { createSearchTools } from "../tools/search.js";
import { createIndexingTools } from "../tools/indexing.js";
import { createMemoryTools } from "../tools/memory.js";
import { createArchitectureTools } from "../tools/architecture.js";
import { createConfluenceTools } from "../tools/confluence.js";
import { createSessionTools } from "../tools/session.js";
import { createSuggestionTools } from "../tools/suggestions.js";
import { createAgentTools } from "../tools/agents.js";
import { createQualityTools } from "../tools/quality.js";

/**
 * The 0.5.0 public tool surface — en route to 28 tools, 0 hidden.
 *
 * This is the documented registered count (README tool count,
 * CLAUDE.md "MCP Server Tools"). The default MCP_PROFILE=full
 * registers exactly these specs (index.ts builds allSpecs from the
 * same module list). If you add or delete a tool, this number MUST
 * change in the same PR, together with the README and CLAUDE.md
 * counts — that is the Subtraction rule (sweeps land with their
 * deletion) and the Proof rule (public copy states only what is
 * actually registered).
 *
 * 0.5.0 surface: 28 = 41 (0.4.0) − 8 DB tools (PR-4.0)
 * − memory_maintenance (PR-4.2) − 4 Confluence tools (PR-4.3).
 * Current value reflects the cuts landed so far on this branch.
 */
const EXPECTED_TOOL_COUNT = 32;

describe("tool registration surface", () => {
  const allSpecs = [
    ...createSearchTools("testproject"),
    ...createIndexingTools("testproject"),
    ...createMemoryTools("testproject"),
    ...createArchitectureTools("testproject"),
    ...createConfluenceTools("testproject"),
    ...createSessionTools("testproject"),
    ...createSuggestionTools("testproject"),
    ...createAgentTools("testproject"),
    ...createQualityTools("testproject"),
  ];

  it(`registers exactly ${EXPECTED_TOOL_COUNT} tools (0.5.0 surface, 0 hidden)`, () => {
    expect(allSpecs.length).toBe(EXPECTED_TOOL_COUNT);
  });

  it("has no duplicate tool names", () => {
    const names = allSpecs.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has a non-empty description and a schema", () => {
    for (const spec of allSpecs) {
      expect(spec.description, spec.name).toBeTruthy();
      expect(spec.schema, spec.name).toBeDefined();
    }
  });
});
