import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionTools } from "../../tools/session.js";
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

describe("Session Tools", () => {
  let ctx: ToolContext;
  let tools: ToolSpec[];

  beforeEach(() => {
    vi.resetAllMocks();
    ctx = createMockCtx();
    tools = createSessionTools("testproject", ctx);
  });

  function findTool(name: string) {
    return tools.find((t) => t.name === name)!;
  }

  describe("start_session", () => {
    it("starts a session and updates the shared activeSessionId", async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          success: true,
          session: {
            sessionId: "sess-1",
            startedAt: "2026-06-12T08:00:00.000Z",
            currentFiles: [],
          },
        },
      });

      const result = await findTool("start_session").handler(
        { initialContext: "working on M3" },
        ctx,
      );

      expect(result).toContain("Session Started");
      expect(result).toContain("sess-1");
      expect(ctx.activeSessionId).toBe("sess-1");
    });

    it("does NOT render a briefing — the dead data.briefing path was deleted (M3)", async () => {
      // Even if a (hypothetical) response carried `briefing`, start_session
      // must not render it: POST /api/session/start returns only
      // {success, session}, and digest delivery is owned by the plugin hook
      // via GET /api/session/digest.
      (ctx.api.post as any).mockResolvedValue({
        data: {
          success: true,
          briefing: "SHOULD NEVER RENDER",
          session: {
            sessionId: "sess-2",
            startedAt: "2026-06-12T08:00:00.000Z",
            currentFiles: [],
          },
        },
      });

      const result = await findTool("start_session").handler({}, ctx);

      expect(result).not.toContain("Session Briefing");
      expect(result).not.toContain("SHOULD NEVER RENDER");
    });
  });

  describe("end_session", () => {
    it("ends the session and clears the shared activeSessionId", async () => {
      ctx.activeSessionId = "sess-1";
      (ctx.api.post as any).mockResolvedValue({
        data: {
          summary: "did things",
          duration: 12,
          learningsSaved: 2,
        },
      });

      const result = await findTool("end_session").handler(
        { sessionId: "sess-1", summary: "did things" },
        ctx,
      );

      expect(result).toContain("Session Ended");
      expect(ctx.activeSessionId).toBeUndefined();
      expect(ctx.api.post).toHaveBeenCalledWith(
        "/api/session/sess-1/end",
        expect.objectContaining({ summary: "did things" }),
      );
    });
  });
});
