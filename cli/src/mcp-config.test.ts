import { describe, it, expect } from "vitest";
import {
  extractExistingKey,
  mergeRagServer,
  McpConfig,
  McpServerEntry,
} from "./mcp-config";

const newEntry: McpServerEntry = {
  command: "npx",
  args: ["-y", "@getreka/mcp@latest"],
  env: {
    REKA_API_URL: "http://localhost:3100",
    PROJECT_NAME: "myapp",
    PROJECT_PATH: "/work/myapp",
    REKA_API_KEY: "rk_myapp_new",
  },
};

describe("mergeRagServer", () => {
  it("creates a single rag entry on a fresh config", () => {
    const { config, removed } = mergeRagServer({}, "myapp", newEntry);
    expect(Object.keys(config.mcpServers!)).toEqual(["rag"]);
    expect(config.mcpServers!.rag.args).toEqual(["-y", "@getreka/mcp@latest"]);
    expect(removed).toEqual([]);
  });

  it("renames a legacy 'reka' entry and preserves env not overwritten", () => {
    const existing: McpConfig = {
      mcpServers: {
        reka: {
          command: "npx",
          args: ["-y", "@getreka/mcp"],
          env: { REKA_API_KEY: "rk_myapp_old", CUSTOM_FLAG: "1" },
        },
      },
    };
    const { config, removed } = mergeRagServer(existing, "myapp", newEntry);
    expect(config.mcpServers!.reka).toBeUndefined();
    expect(removed).toEqual(["reka"]);
    const rag = config.mcpServers!.rag;
    expect(rag.env!.CUSTOM_FLAG).toBe("1"); // preserved
    expect(rag.env!.REKA_API_KEY).toBe("rk_myapp_new"); // new wins
  });

  it("merges duplicate '<project>-rag' + 'reka' + 'rag' into one entry", () => {
    const existing: McpConfig = {
      mcpServers: {
        reka: { command: "npx", args: ["-y", "@crowley/rag-mcp"], env: {} },
        "myapp-rag": {
          command: "npx",
          args: ["-y", "@getreka/mcp@latest"],
          env: { PROJECT_NAME: "myapp" },
        },
        rag: { command: "npx", args: ["-y", "@getreka/mcp@latest"], env: {} },
        other: { command: "node", args: ["server.js"] },
      },
    };
    const { config, removed } = mergeRagServer(existing, "myapp", newEntry);
    expect(Object.keys(config.mcpServers!).sort()).toEqual(["other", "rag"]);
    expect(removed.sort()).toEqual(["myapp-rag", "reka"]);
    expect(config.mcpServers!.other.args).toEqual(["server.js"]); // untouched
  });

  it("ignores same-named entries that are not Reka MCP servers", () => {
    const existing: McpConfig = {
      mcpServers: {
        reka: { command: "node", args: ["something-else.js"] },
      },
    };
    const { config, removed } = mergeRagServer(existing, "myapp", newEntry);
    expect(removed).toEqual([]);
    expect(config.mcpServers!.reka.args).toEqual(["something-else.js"]);
    expect(config.mcpServers!.rag.env!.REKA_API_KEY).toBe("rk_myapp_new");
  });

  it("is idempotent — applying twice yields the same config", () => {
    const once = mergeRagServer(
      { mcpServers: { reka: { command: "npx", args: ["@getreka/mcp"] } } },
      "myapp",
      newEntry,
    ).config;
    const twice = mergeRagServer(once, "myapp", newEntry).config;
    expect(twice).toEqual(once);
    expect(Object.keys(twice.mcpServers!)).toEqual(["rag"]);
  });
});

describe("extractExistingKey", () => {
  it("prefers the 'rag' entry key over legacy entries", () => {
    const config: McpConfig = {
      mcpServers: {
        reka: {
          command: "npx",
          args: ["@getreka/mcp"],
          env: { REKA_API_KEY: "rk_old" },
        },
        rag: {
          command: "npx",
          args: ["@getreka/mcp@latest"],
          env: { REKA_API_KEY: "rk_current" },
        },
      },
    };
    expect(extractExistingKey(config, "myapp")).toBe("rk_current");
    expect(extractExistingKey({}, "myapp")).toBeUndefined();
  });
});
