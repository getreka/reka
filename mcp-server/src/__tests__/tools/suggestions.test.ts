import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSuggestionTools } from "../../tools/suggestions.js";
import type { ToolContext, ToolSpec } from "../../types.js";

function createMockCtx(): ToolContext {
  return {
    api: {
      post: vi.fn().mockRejectedValue(new Error("offline")),
      get: vi.fn().mockRejectedValue(new Error("offline")),
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

describe("setup_project API key fallback", () => {
  let tools: ReturnType<typeof createSuggestionTools>;
  let ctx: ToolContext;
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function findTool(name: string) {
    return tools.find((t: ToolSpec) => t.name === name)!;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    tools = createSuggestionTools("testproject");
    ctx = createMockCtx();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reka-setup-"));
    for (const key of [
      "REKA_API_KEY",
      "RAG_API_KEY",
      "RAG_API_URL",
      "REKA_API_URL",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function runSetup() {
    await findTool("setup_project").handler(
      { projectPath: tmpDir, projectName: "demo", updateClaudeMd: false },
      ctx,
    );
    const mcpJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    // CLI-parity (0.5.0): the server entry is always named "rag"
    return mcpJson.mcpServers["rag"].env as Record<string, string>;
  }

  it("falls back to REKA_API_KEY when only it is set", async () => {
    process.env.REKA_API_KEY = "rk_demo_via_reka";
    const env = await runSetup();
    expect(env.REKA_API_KEY).toBe("rk_demo_via_reka");
  });

  it("prefers REKA_API_KEY over legacy RAG_API_KEY", async () => {
    process.env.REKA_API_KEY = "rk_demo_new";
    process.env.RAG_API_KEY = "rk_demo_legacy";
    const env = await runSetup();
    expect(env.REKA_API_KEY).toBe("rk_demo_new");
  });

  it("still honors legacy RAG_API_KEY when REKA_API_KEY is unset", async () => {
    process.env.RAG_API_KEY = "rk_demo_legacy";
    const env = await runSetup();
    expect(env.REKA_API_KEY).toBe("rk_demo_legacy");
  });

  it("omits the key entirely when no env key is set", async () => {
    const env = await runSetup();
    expect(env.REKA_API_KEY).toBeUndefined();
  });
});

describe("setup_project .mcp.json merge (CLI init parity)", () => {
  let tools: ReturnType<typeof createSuggestionTools>;
  let ctx: ToolContext;
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function findTool(name: string) {
    return tools.find((t: ToolSpec) => t.name === name)!;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    tools = createSuggestionTools("testproject");
    ctx = createMockCtx();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reka-setup-merge-"));
    for (const key of [
      "REKA_API_KEY",
      "RAG_API_KEY",
      "RAG_API_URL",
      "REKA_API_URL",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("merges legacy reka/<project>-rag entries into one 'rag' entry, keeps others", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          reka: {
            command: "npx",
            args: ["-y", "@crowley/rag-mcp@latest"],
            env: { REKA_API_KEY: "rk_demo_legacy", EXTRA: "kept" },
          },
          "demo-rag": {
            command: "npx",
            args: ["-y", "@getreka/mcp@latest"],
            env: { PROJECT_NAME: "demo" },
          },
          unrelated: { command: "node", args: ["server.js"] },
        },
      }),
    );

    await findTool("setup_project").handler(
      { projectPath: tmpDir, projectName: "demo", updateClaudeMd: false },
      ctx,
    );

    const mcpJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcpJson.mcpServers).sort()).toEqual([
      "rag",
      "unrelated",
    ]);
    const rag = mcpJson.mcpServers["rag"];
    expect(rag.args).toEqual(["-y", "@getreka/mcp@latest"]);
    // Legacy env survives the merge unless overwritten by the new entry
    expect(rag.env.EXTRA).toBe("kept");
    expect(rag.env.REKA_API_KEY).toBe("rk_demo_legacy");
    expect(rag.env.PROJECT_NAME).toBe("demo");
  });

  it("is idempotent: re-running setup yields the same single 'rag' entry", async () => {
    const run = () =>
      findTool("setup_project").handler(
        { projectPath: tmpDir, projectName: "demo", updateClaudeMd: false },
        ctx,
      );
    await run();
    const first = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    await run();
    const second = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    expect(second).toBe(first);
    expect(Object.keys(JSON.parse(second).mcpServers)).toEqual(["rag"]);
  });

  it("writes the mcp__rag__* permission to settings.local.json", async () => {
    await findTool("setup_project").handler(
      { projectPath: tmpDir, projectName: "demo", updateClaudeMd: false },
      ctx,
    );
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".claude", "settings.local.json"),
        "utf-8",
      ),
    );
    expect(settings.permissions.allow).toContain("mcp__rag__*");
  });
});
