import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextEnricher } from "../context-enrichment.js";
import type { ToolContext } from "../types.js";

function createMockCtx(activeSessionId?: string): ToolContext {
  return {
    api: {
      post: vi.fn().mockResolvedValue({ data: { memories: [] } }),
      get: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      defaults: { baseURL: "http://localhost:3100" },
    } as any,
    projectName: "testproject",
    projectPath: "/tmp/testproject",
    collectionPrefix: "testproject",
    enrichmentEnabled: true,
    activeSessionId,
  };
}

describe("ContextEnricher — session linkage (M3)", () => {
  let prevConsolidation: string | undefined;

  beforeEach(() => {
    prevConsolidation = process.env.CONSOLIDATION_ENABLED;
  });

  afterEach(() => {
    if (prevConsolidation === undefined) {
      delete process.env.CONSOLIDATION_ENABLED;
    } else {
      process.env.CONSOLIDATION_ENABLED = prevConsolidation;
    }
  });

  it("passes ctx.activeSessionId in recall-durable and recall-ltm bodies", async () => {
    process.env.CONSOLIDATION_ENABLED = "true";
    const enricher = new ContextEnricher();
    const ctx = createMockCtx("sess-99");

    await enricher.before(
      "hybrid_search",
      { query: "how does auth work" },
      ctx,
    );

    const calls = (ctx.api.post as any).mock.calls;
    const durableCalls = calls.filter(
      (c: any[]) => c[0] === "/api/memory/recall-durable",
    );
    const ltmCalls = calls.filter(
      (c: any[]) => c[0] === "/api/memory/recall-ltm",
    );

    expect(durableCalls).toHaveLength(2);
    for (const call of durableCalls) {
      expect(call[1].sessionId).toBe("sess-99");
    }
    expect(ltmCalls).toHaveLength(1);
    expect(ltmCalls[0][1].sessionId).toBe("sess-99");
  });

  it("falls back to the per-process local-* sessionId when none is active", async () => {
    delete process.env.CONSOLIDATION_ENABLED;
    const enricher = new ContextEnricher();
    const ctx = createMockCtx(undefined);

    await enricher.before(
      "hybrid_search",
      { query: "another unique query" },
      ctx,
    );

    const calls = (ctx.api.post as any).mock.calls.filter(
      (c: any[]) => c[0] === "/api/memory/recall-durable",
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1].sessionId).toMatch(/^local-/);
    }
  });
});
