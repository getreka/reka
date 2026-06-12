import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryTools } from "../../tools/memory.js";
import type { ToolContext, ToolSpec } from "../../types.js";

function createMockCtx(): ToolContext {
  return {
    api: {
      post: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      defaults: { baseURL: "http://localhost:3100" },
    } as any,
    projectName: "testproject",
    projectPath: "/tmp/testproject",
    collectionPrefix: "testproject",
    enrichmentEnabled: false,
  };
}

describe("Memory Tools", () => {
  let tools: ReturnType<typeof createMemoryTools>;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.resetAllMocks();
    tools = createMemoryTools("testproject");
    ctx = createMockCtx();
  });

  function findTool(name: string) {
    return tools.find((t: ToolSpec) => t.name === name)!;
  }

  describe("remember", () => {
    it("stores memory and returns formatted result", async () => {
      const mem = {
        id: "mem-1",
        type: "note",
        content: "test note",
        createdAt: new Date().toISOString(),
      };
      (ctx.api.post as any).mockResolvedValue({ data: { memory: mem } });

      const result = await findTool("remember").handler(
        { content: "test note", type: "note", tags: ["tag1"] },
        ctx,
      );

      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/memory",
        expect.objectContaining({
          projectName: "testproject",
          content: "test note",
          type: "note",
        }),
      );
      expect(result).toContain("Memory stored");
      expect(result).toContain("mem-1");
    });
  });

  describe("recall", () => {
    it("returns formatted results", async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          results: [
            {
              memory: {
                type: "insight",
                content: "found it",
                createdAt: new Date().toISOString(),
                tags: [],
              },
              score: 0.85,
            },
          ],
        },
      });

      const result = await findTool("recall").handler(
        { query: "find something", limit: 5 },
        ctx,
      );

      expect(result).toContain("Recalled Memories");
    });

    it("returns empty message when no results", async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { results: [] } });

      const result = await findTool("recall").handler(
        { query: "nothing" },
        ctx,
      );
      expect(result).toContain("No memories found");
    });

    it("passes the active sessionId for the retrieval audit log (M3)", async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { results: [] } });
      ctx.activeSessionId = "sess-42";

      await findTool("recall").handler({ query: "find something" }, ctx);

      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/memory/recall",
        expect.objectContaining({ sessionId: "sess-42" }),
      );
    });

    it("falls back to a local-* sessionId when no session is active", async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { results: [] } });
      ctx.activeSessionId = undefined;

      await findTool("recall").handler({ query: "find something" }, ctx);

      const body = (ctx.api.post as any).mock.calls[0][1];
      expect(body.sessionId).toMatch(/^local-/);
    });
  });

  describe("forget", () => {
    it("deletes by memoryId", async () => {
      (ctx.api.delete as any).mockResolvedValue({ data: { success: true } });

      const result = await findTool("forget").handler(
        { memoryId: "mem-1" },
        ctx,
      );

      expect(ctx.api.delete).toHaveBeenCalledWith(
        expect.stringContaining("/api/memory/mem-1"),
      );
      expect(result).toContain("deleted");
    });

    it("deletes by type", async () => {
      (ctx.api.delete as any).mockResolvedValue({ data: {} });

      const result = await findTool("forget").handler({ type: "note" }, ctx);

      expect(ctx.api.delete).toHaveBeenCalledWith(
        expect.stringContaining("/api/memory/type/note"),
      );
      expect(result).toContain("note");
    });

    it("deletes by olderThanDays", async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { deleted: 10 } });

      const result = await findTool("forget").handler(
        { olderThanDays: 30 },
        ctx,
      );

      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/memory/forget-older",
        expect.objectContaining({
          olderThanDays: 30,
        }),
      );
      expect(result).toContain("10");
    });

    it("returns message when nothing specified", async () => {
      const result = await findTool("forget").handler({}, ctx);
      expect(result).toContain("specify");
    });
  });

  describe("promote_memory", () => {
    it("promotes and returns formatted result", async () => {
      const mem = { id: "mem-1", type: "insight", content: "promoted" };
      (ctx.api.post as any).mockResolvedValue({ data: { memory: mem } });

      const result = await findTool("promote_memory").handler(
        { memoryId: "mem-1", reason: "human_validated" },
        ctx,
      );

      expect(result).toContain("promoted to durable");
      expect(result).toContain("mem-1");
    });
  });

  describe("batch_remember", () => {
    it("stores multiple memories", async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          savedCount: 2,
          memories: [
            { id: "b-1", type: "note", content: "first" },
            { id: "b-2", type: "insight", content: "second" },
          ],
          errors: [],
        },
      });

      const result = await findTool("batch_remember").handler(
        {
          items: [{ content: "first" }, { content: "second", type: "insight" }],
        },
        ctx,
      );

      expect(result).toContain("Saved");
      expect(result).toContain("2");
    });
  });

  describe("triggerDescription + pin (M2-6)", () => {
    it("remember forwards triggerDescription and pin in the POST body", async () => {
      const mem = {
        id: "mem-p1",
        type: "decision",
        content: "always use npm 10 for lockfiles",
        createdAt: new Date().toISOString(),
      };
      (ctx.api.post as any).mockResolvedValue({ data: { memory: mem } });

      const result = await findTool("remember").handler(
        {
          content: "always use npm 10 for lockfiles",
          type: "decision",
          triggerDescription: "when regenerating package-lock.json",
          pin: "repo",
        },
        ctx,
      );

      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/memory",
        expect.objectContaining({
          triggerDescription: "when regenerating package-lock.json",
          pin: "repo",
        }),
      );
      expect(result).toContain("Pinned:");
      expect(result).toContain("repo");
    });

    it("remember/batch_remember schemas keep both fields through zod parsing", () => {
      // The MCP SDK validates args against the schema (default zod strip):
      // without these fields in the schema they would be silently dropped
      // before the handler runs — dead-on-arrival params.
      const remembered = findTool("remember").schema.parse({
        content: "x",
        triggerDescription: "when touching auth",
        pin: "all",
      });
      expect(remembered.triggerDescription).toBe("when touching auth");
      expect(remembered.pin).toBe("all");

      const batch = findTool("batch_remember").schema.parse({
        items: [
          { content: "y", triggerDescription: "when deploying", pin: "repo" },
        ],
      }) as { items: Array<Record<string, unknown>> };
      expect(batch.items[0].triggerDescription).toBe("when deploying");
      expect(batch.items[0].pin).toBe("repo");
    });

    it("batch_remember forwards items with triggerDescription/pin untouched", async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: { savedCount: 1, memories: [], errors: [] },
      });

      await findTool("batch_remember").handler(
        {
          items: [
            {
              content: "pinned fact",
              pin: "all",
              triggerDescription: "every session",
            },
          ],
        },
        ctx,
      );

      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/memory/batch",
        expect.objectContaining({
          items: [
            expect.objectContaining({
              pin: "all",
              triggerDescription: "every session",
            }),
          ],
        }),
      );
    });
  });
});
