import { describe, it, expect } from "vitest";
import { createSearchTools } from "../tools/search.js";
import { createIndexingTools } from "../tools/indexing.js";
import { createMemoryTools } from "../tools/memory.js";
import { createArchitectureTools } from "../tools/architecture.js";
import { createDatabaseTools } from "../tools/database.js";
import { createConfluenceTools } from "../tools/confluence.js";
import { createSessionTools } from "../tools/session.js";
import { createSuggestionTools } from "../tools/suggestions.js";
import { createAgentTools } from "../tools/agents.js";
import { createQualityTools } from "../tools/quality.js";

/**
 * The 0.4.0 public tool surface — 41 tools, 0 hidden.
 *
 * This is the documented registered count for the 0.4.0 release
 * (README "41 tools", CLAUDE.md "MCP Server Tools"). The default
 * MCP_PROFILE=full registers exactly these specs (index.ts builds
 * allSpecs from the same module list). If you add or delete a tool,
 * this number MUST change in the same PR, together with the README
 * and CLAUDE.md counts — that is the Subtraction rule (sweeps land
 * with their deletion) and the Proof rule (public copy states only
 * what is actually registered).
 *
 * Expected at 0.4.0: 41. (Wave 4 / 0.5.0 plans a further cut to 28.)
 */
const EXPECTED_TOOL_COUNT_0_4_0 = 41;

describe("tool registration surface", () => {
  const allSpecs = [
    ...createSearchTools("testproject"),
    ...createIndexingTools("testproject"),
    ...createMemoryTools("testproject"),
    ...createArchitectureTools("testproject"),
    ...createDatabaseTools("testproject"),
    ...createConfluenceTools("testproject"),
    ...createSessionTools("testproject"),
    ...createSuggestionTools("testproject"),
    ...createAgentTools("testproject"),
    ...createQualityTools("testproject"),
  ];

  it(`registers exactly ${EXPECTED_TOOL_COUNT_0_4_0} tools (0.4.0 surface, 0 hidden)`, () => {
    expect(allSpecs.length).toBe(EXPECTED_TOOL_COUNT_0_4_0);
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
