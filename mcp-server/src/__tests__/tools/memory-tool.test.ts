import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMemoryToolTools,
  validateMemoryArgs,
} from "../../tools/memory-tool.js";
import { PATH_TAG_PREFIX } from "../../memory-tool-adapter.js";
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

describe("memory tool (memory_20250818 surface)", () => {
  let spec: ToolSpec;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.resetAllMocks();
    const tools = createMemoryToolTools("testproject");
    expect(tools).toHaveLength(1);
    spec = tools[0];
    ctx = createMockCtx();
  });

  describe("registration shape", () => {
    it("is named 'memory' with a flat schema covering all six commands", () => {
      expect(spec.name).toBe("memory");
      const shape = spec.schema.shape;
      for (const field of [
        "command",
        "path",
        "file_text",
        "old_str",
        "new_str",
        "insert_line",
        "insert_text",
        "view_range",
        "old_path",
        "new_path",
      ]) {
        expect(shape[field], field).toBeDefined();
      }
    });

    it("is marked destructive (delete/str_replace/rename remove data)", () => {
      expect(spec.annotations?.destructiveHint).toBe(true);
      expect(spec.annotations?.readOnlyHint).toBe(false);
    });

    it("has a prescriptive description disambiguated from the host's local dir", () => {
      expect(spec.description).toContain("Call this");
      // Must be explicit that this is NOT the host-local /memories directory.
      expect(spec.description).toMatch(/NOT the host's local/);
      expect(spec.description).toMatch(/project-scoped/);
      expect(spec.description).toMatch(/survives machines and sessions/);
    });
  });

  describe("per-command validation (error strings, never throws)", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: "view" }, "'path'"],
      [{ command: "create", path: "/memories/a.md" }, "'file_text'"],
      [{ command: "str_replace", path: "/m/a.md", old_str: "x" }, "'new_str'"],
      [
        { command: "insert", path: "/m/a.md", insert_text: "x" },
        "'insert_line'",
      ],
      [{ command: "delete" }, "'path'"],
      [{ command: "rename", old_path: "/m/a.md" }, "'new_path'"],
      [{ command: "bogus" }, "unsupported memory command"],
    ];

    it.each(cases)("returns an error string for %j", async (args, expected) => {
      const out = await spec.handler(args, ctx);
      expect(typeof out).toBe("string");
      expect(out).toContain("Error:");
      expect(out).toContain(expected);
      // Validation failures must not hit the API at all.
      expect(ctx.api.post).not.toHaveBeenCalled();
      expect(ctx.api.get).not.toHaveBeenCalled();
    });

    it("accepts insert_line 0 (insert at the top, not 'missing')", () => {
      expect(
        validateMemoryArgs({
          command: "insert",
          path: "/memories/a.md",
          insert_line: 0,
          insert_text: "first",
        }),
      ).toBeNull();
    });

    it("returns API failures as error strings instead of throwing", async () => {
      (ctx.api.post as any).mockRejectedValue(
        new Error("connect ECONNREFUSED"),
      );
      const out = await spec.handler(
        { command: "create", path: "/memories/a.md", file_text: "x" },
        ctx,
      );
      expect(out).toContain("Error: memory create failed");
      expect(out).toContain("ECONNREFUSED");
    });
  });

  describe("adapter wiring", () => {
    it("instantiates the adapter PER CALL so async PROJECT_NAME resolution is honored", async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: { memory: { id: "m1", content: "x" } },
      });

      // First call while the project name is still the startup placeholder.
      ctx.projectName = "resolving";
      await spec.handler(
        { command: "create", path: "/memories/a.md", file_text: "x" },
        ctx,
      );
      // /api/whoami resolved — index.ts mutates ctx.projectName in place.
      ctx.projectName = "realproject";
      await spec.handler(
        { command: "create", path: "/memories/b.md", file_text: "y" },
        ctx,
      );

      const bodies = (ctx.api.post as any).mock.calls.map(
        (c: unknown[]) => c[1] as { projectName: string },
      );
      expect(bodies[0].projectName).toBe("resolving");
      // A module-level adapter would still send 'resolving' here.
      expect(bodies[1].projectName).toBe("realproject");
    });

    it("create -> view round-trips through the quarantine tier (read-your-writes)", async () => {
      const path = "/memories/decisions.md";
      const tag = `${PATH_TAG_PREFIX}${path}`;

      // create: governance quarantines the attributed write.
      (ctx.api.post as any).mockResolvedValue({
        data: {
          success: true,
          skipped: false,
          memory: { id: "q-new", content: "we use BGE-M3" },
        },
      });
      const created = await spec.handler(
        { command: "create", path, file_text: "we use BGE-M3" },
        ctx,
      );
      expect(created).toContain(`Created memory file ${path}`);
      const postBody = (ctx.api.post as any).mock.calls[0][1] as {
        metadata?: Record<string, unknown>;
      };
      expect(postBody.metadata).toEqual({ source: "auto_memory_tool" });

      // view: durable list is EMPTY (not promoted yet); the quarantine ?tag=
      // lookup returns the fresh write — the governance-gated merge path.
      (ctx.api.get as any).mockImplementation(async (url: string) => {
        if (url.startsWith("/api/memory/quarantine")) {
          return {
            data: {
              memories: [
                { id: "q-new", content: "we use BGE-M3", tags: [tag] },
              ],
            },
          };
        }
        return { data: { memories: [] } };
      });

      const viewed = await spec.handler({ command: "view", path }, ctx);
      expect(viewed).toContain("we use BGE-M3");
      const quarantineCall = (ctx.api.get as any).mock.calls.find(
        (c: string[]) => c[0].startsWith("/api/memory/quarantine"),
      );
      expect(quarantineCall).toBeDefined();
      expect(quarantineCall![0]).toContain("tag=");
    });
  });
});
