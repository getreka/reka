import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyProjectFiles, buildRagEntry } from "./setup-files";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reka-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runInit() {
  return applyProjectFiles({
    projectPath: tmpDir,
    projectName: "myapp",
    entry: buildRagEntry({
      apiUrl: "http://localhost:3100",
      projectName: "myapp",
      projectPath: tmpDir,
      apiKey: "rk_myapp_abc",
    }),
  });
}

describe("applyProjectFiles idempotency", () => {
  it("writes .mcp.json, CLAUDE.md and permissions on first run", () => {
    runInit();

    const mcp = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).toEqual(["rag"]);
    expect(mcp.mcpServers.rag.env.REKA_API_KEY).toBe("rk_myapp_abc");
    expect(mcp.mcpServers.rag.env.PROJECT_NAME).toBe("myapp");

    const claudeMd = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("## RAG Integration");

    const settings = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".claude", "settings.local.json"),
        "utf-8",
      ),
    );
    expect(settings.permissions.allow).toEqual(["mcp__rag__*"]);
  });

  it("re-running produces no duplicates anywhere", () => {
    runInit();
    const second = runInit();

    const mcp = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).toEqual(["rag"]);

    const claudeMd = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.match(/## RAG Integration/g)).toHaveLength(1);

    const settings = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".claude", "settings.local.json"),
        "utf-8",
      ),
    );
    expect(settings.permissions.allow).toEqual(["mcp__rag__*"]);

    expect(second.changes.join(" ")).toContain("already exists");
  });

  it("migrates a legacy 'reka' entry into 'rag' on upgrade", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          reka: {
            command: "npx",
            args: ["-y", "@getreka/mcp"],
            env: { REKA_API_KEY: "rk_old", EXTRA: "keep-me" },
          },
        },
      }),
    );

    runInit();

    const mcp = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).toEqual(["rag"]);
    expect(mcp.mcpServers.rag.env.EXTRA).toBe("keep-me");
    expect(mcp.mcpServers.rag.env.REKA_API_KEY).toBe("rk_myapp_abc");
  });
});
