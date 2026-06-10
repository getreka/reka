import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryToolAdapter,
  PATH_TAG_PREFIX,
  type MemoryCommand,
} from "../memory-tool-adapter.js";
import type { ApiClient } from "../api-client.js";

/**
 * Mock ApiClient that records every call and returns canned responses keyed by
 * "<METHOD> <path-prefix>". Lets us assert the command -> RAG API mapping without
 * a live API.
 */
function makeMockApi() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const responses = new Map<string, unknown>();

  const lookup = (method: string, path: string): unknown => {
    for (const [key, val] of responses) {
      const [m, prefix] = key.split(" ", 2);
      if (m === method && path.startsWith(prefix)) return val;
    }
    return { data: {} };
  };

  const api = {
    post: vi.fn(async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return lookup("POST", path);
    }),
    get: vi.fn(async (path: string) => {
      calls.push({ method: "GET", path });
      return lookup("GET", path);
    }),
    delete: vi.fn(async (path: string) => {
      calls.push({ method: "DELETE", path });
      return lookup("DELETE", path);
    }),
  } as unknown as ApiClient;

  return {
    api,
    calls,
    setResponse: (key: string, val: unknown) => responses.set(key, val),
  };
}

const PROJECT = "myproj";

describe("MemoryToolAdapter", () => {
  let mock: ReturnType<typeof makeMockApi>;
  let adapter: MemoryToolAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockApi();
    adapter = new MemoryToolAdapter(mock.api, PROJECT);
  });

  describe("create -> remember (POST /api/memory)", () => {
    it("posts content with path encoded as tag + relatedTo", async () => {
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "m1", content: "hi" } },
      });

      const out = await adapter.handle({
        command: "create",
        path: "/memories/auth.md",
        file_text: "we use BGE-M3",
      });

      const post = mock.calls.find(
        (c) => c.method === "POST" && c.path === "/api/memory",
      );
      expect(post).toBeDefined();
      const body = post!.body as {
        projectName: string;
        content: string;
        tags: string[];
        relatedTo: string;
      };
      expect(body.projectName).toBe(PROJECT);
      expect(body.content).toBe("we use BGE-M3");
      expect(body.tags).toContain(`${PATH_TAG_PREFIX}/memories/auth.md`);
      expect(body.relatedTo).toBe("/memories/auth.md");
      expect(out).toContain("Created memory file /memories/auth.md");
      expect(out).toContain("m1");
    });

    it("normalizes a path missing the leading slash", async () => {
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "m2", content: "x" } },
      });
      await adapter.handle({
        command: "create",
        path: "memories/notes.md",
        file_text: "x",
      });
      const post = mock.calls.find((c) => c.path === "/api/memory")!;
      const body = post.body as { tags: string[]; relatedTo: string };
      expect(body.relatedTo).toBe("/memories/notes.md");
      expect(body.tags[0]).toBe(`${PATH_TAG_PREFIX}/memories/notes.md`);
    });
  });

  describe("insert -> remember with line annotation", () => {
    it("records the insert line in the stored content", async () => {
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "m3", content: "x" } },
      });
      const out = await adapter.handle({
        command: "insert",
        path: "/memories/log.md",
        insert_line: 5,
        insert_text: "new entry",
      });
      const post = mock.calls.find((c) => c.path === "/api/memory")!;
      const body = post.body as { content: string };
      expect(body.content).toContain("[line 5]");
      expect(body.content).toContain("new entry");
      expect(out).toContain("Inserted text at line 5");
    });
  });

  describe("governance skip -> report NOT stored (route returns skipped:true)", () => {
    it("create() reports non-persistence when the write is skipped", async () => {
      mock.setResponse("POST /api/memory", {
        data: {
          success: true,
          skipped: true,
          memory: { id: "m9", content: "x" },
        },
      });
      const out = await adapter.handle({
        command: "create",
        path: "/memories/low.md",
        file_text: "trivial",
      });
      expect(out).toContain("NOT stored");
      expect(out).not.toContain("Created memory file");
    });

    it("insert() reports non-persistence when the write is skipped", async () => {
      mock.setResponse("POST /api/memory", {
        data: {
          success: true,
          skipped: true,
          memory: { id: "m10", content: "x" },
        },
      });
      const out = await adapter.handle({
        command: "insert",
        path: "/memories/low.md",
        insert_line: 3,
        insert_text: "trivial",
      });
      expect(out).toContain("NOT stored");
      expect(out).not.toContain("Inserted text at line");
    });

    it("create() reports success when the write is persisted (skipped:false)", async () => {
      mock.setResponse("POST /api/memory", {
        data: {
          success: true,
          skipped: false,
          memory: { id: "m11", content: "x" },
        },
      });
      const out = await adapter.handle({
        command: "create",
        path: "/memories/keep.md",
        file_text: "important",
      });
      expect(out).toContain("Created memory file /memories/keep.md");
      expect(out).toContain("m11");
    });

    it("str_replace() does NOT delete the original when the rewrite is skipped", async () => {
      const path = "/memories/cfg.md";
      const tag = `${PATH_TAG_PREFIX}${path}`;
      mock.setResponse("GET /api/memory/list", {
        data: { memories: [{ id: "old1", content: "port=3000", tags: [tag] }] },
      });
      mock.setResponse("POST /api/memory", {
        data: {
          success: true,
          skipped: true,
          memory: { id: "new1", content: "port=3100" },
        },
      });
      const out = await adapter.handle({
        command: "str_replace",
        path,
        old_str: "port=3000",
        new_str: "port=3100",
      });
      expect(out).toContain("NOT stored");
      // The original must survive: no DELETE should have fired.
      expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
    });
  });

  describe("view -> list / recall (GET /api/memory/list, POST /api/memory/recall)", () => {
    it("reads a file via exact path-tag list match", async () => {
      const tag = `${PATH_TAG_PREFIX}/memories/auth.md`;
      mock.setResponse("GET /api/memory/list", {
        data: {
          memories: [{ id: "m1", content: "line A\nline B", tags: [tag] }],
        },
      });
      const out = await adapter.handle({
        command: "view",
        path: "/memories/auth.md",
      });
      // GET list called with the path tag in the query string.
      const get = mock.calls.find((c) => c.method === "GET");
      expect(get!.path).toContain("tag=");
      expect(out).toContain("line A");
      expect(out).toContain("line B");
    });

    it("applies view_range to a viewed file", async () => {
      const tag = `${PATH_TAG_PREFIX}/memories/multi.md`;
      mock.setResponse("GET /api/memory/list", {
        data: {
          memories: [{ id: "m1", content: "l1\nl2\nl3\nl4", tags: [tag] }],
        },
      });
      const out = await adapter.handle({
        command: "view",
        path: "/memories/multi.md",
        view_range: [2, 3],
      });
      expect(out).toBe("l2\nl3");
    });

    it("falls back to semantic recall when nothing is at the path", async () => {
      // Both list calls (filtered + unfiltered) return empty.
      mock.setResponse("GET /api/memory/list", { data: { memories: [] } });
      mock.setResponse("POST /api/memory/recall", {
        data: { results: [{ id: "r1", content: "related fact" }] },
      });
      const out = await adapter.handle({
        command: "view",
        path: "/memories/missing.md",
      });
      const recall = mock.calls.find((c) => c.path === "/api/memory/recall");
      expect(recall).toBeDefined();
      expect(out).toContain("Related memories");
      expect(out).toContain("related fact");
    });

    it("unwraps the { memory, score } recall envelope (no '(undefined) undefined')", async () => {
      // POST /api/memory/recall returns each result as { memory, score }; the
      // adapter must read the INNER memory's id/content, not the wrapper's.
      mock.setResponse("GET /api/memory/list", { data: { memories: [] } });
      mock.setResponse("POST /api/memory/recall", {
        data: {
          results: [
            { memory: { id: "r1", content: "BGE-M3 is 1024d" }, score: 0.9 },
            { memory: { id: "r2", content: "Redis on 6380" }, score: 0.7 },
          ],
        },
      });
      const out = await adapter.handle({
        command: "view",
        path: "/memories/missing.md",
      });
      expect(out).toContain("(r1) BGE-M3 is 1024d");
      expect(out).toContain("(r2) Redis on 6380");
      expect(out).not.toContain("undefined");
    });
  });

  describe("str_replace -> recall + remember + delete (supersede)", () => {
    it("replaces text, re-remembers, then deletes the old memory", async () => {
      const path = "/memories/cfg.md";
      const tag = `${PATH_TAG_PREFIX}${path}`;
      mock.setResponse("GET /api/memory/list", {
        data: {
          memories: [{ id: "old1", content: "port=3000", tags: [tag] }],
        },
      });
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "new1", content: "port=3100" } },
      });
      mock.setResponse("DELETE /api/memory/", { data: { success: true } });

      const out = await adapter.handle({
        command: "str_replace",
        path,
        old_str: "port=3000",
        new_str: "port=3100",
      });

      const post = mock.calls.find((c) => c.path === "/api/memory")!;
      expect((post.body as { content: string }).content).toBe("port=3100");
      const del = mock.calls.find((c) => c.method === "DELETE");
      expect(del!.path).toContain("/api/memory/old1");
      expect(out).toContain("new id: new1");
      expect(out).toContain("superseded: old1");
    });

    it("returns an error when old_str is not present", async () => {
      const path = "/memories/cfg.md";
      const tag = `${PATH_TAG_PREFIX}${path}`;
      mock.setResponse("GET /api/memory/list", {
        data: { memories: [{ id: "old1", content: "other", tags: [tag] }] },
      });
      const out = await adapter.handle({
        command: "str_replace",
        path,
        old_str: "nope",
        new_str: "x",
      });
      expect(out).toContain("could not find");
      // No write / delete should have happened.
      expect(mock.calls.some((c) => c.path === "/api/memory")).toBe(false);
      expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
    });
  });

  describe("delete -> forget (DELETE /api/memory/:id)", () => {
    it("deletes every memory at the path", async () => {
      const tag = `${PATH_TAG_PREFIX}/memories/tmp.md`;
      mock.setResponse("GET /api/memory/list", {
        data: {
          memories: [
            { id: "a", content: "1", tags: [tag] },
            { id: "b", content: "2", tags: [tag] },
          ],
        },
      });
      mock.setResponse("DELETE /api/memory/", { data: { success: true } });

      const out = await adapter.handle({
        command: "delete",
        path: "/memories/tmp.md",
      });

      const dels = mock.calls.filter((c) => c.method === "DELETE");
      expect(dels).toHaveLength(2);
      expect(dels[0].path).toContain(`projectName=${PROJECT}`);
      expect(out).toContain("Deleted 2 memories");
    });

    it("reports when there is nothing to delete", async () => {
      mock.setResponse("GET /api/memory/list", { data: { memories: [] } });
      const out = await adapter.handle({
        command: "delete",
        path: "/memories/gone.md",
      });
      expect(out).toContain("No memories found");
      expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
    });
  });

  describe("rename -> re-remember at new path + delete old", () => {
    it("moves memories from old path to new path", async () => {
      const oldTag = `${PATH_TAG_PREFIX}/memories/old.md`;
      mock.setResponse("GET /api/memory/list", {
        data: { memories: [{ id: "x", content: "body", tags: [oldTag] }] },
      });
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "y", content: "body" } },
      });
      mock.setResponse("DELETE /api/memory/", { data: { success: true } });

      const out = await adapter.handle({
        command: "rename",
        old_path: "/memories/old.md",
        new_path: "/memories/new.md",
      });

      const post = mock.calls.find((c) => c.path === "/api/memory")!;
      const body = post.body as { tags: string[]; relatedTo: string };
      expect(body.relatedTo).toBe("/memories/new.md");
      expect(body.tags[0]).toBe(`${PATH_TAG_PREFIX}/memories/new.md`);
      const del = mock.calls.find((c) => c.method === "DELETE");
      expect(del!.path).toContain("/api/memory/x");
      expect(out).toContain("Renamed 1 memory");
    });
  });

  describe("toHandlers()", () => {
    it("exposes one handler per memory_20250818 command", () => {
      const handlers = adapter.toHandlers();
      expect(Object.keys(handlers).sort()).toEqual(
        ["create", "delete", "insert", "rename", "str_replace", "view"].sort(),
      );
      for (const fn of Object.values(handlers)) {
        expect(typeof fn).toBe("function");
      }
    });

    it("handlers route through the same mapping as handle()", async () => {
      mock.setResponse("POST /api/memory", {
        data: { memory: { id: "h1", content: "c" } },
      });
      const out = await adapter
        .toHandlers()
        .create({ command: "create", path: "/memories/a.md", file_text: "c" });
      expect(out).toContain("h1");
    });
  });

  it("returns an error string for an unknown command", async () => {
    const out = await adapter.handle({
      command: "bogus",
    } as unknown as MemoryCommand);
    expect(out).toContain("unsupported memory command");
  });
});
