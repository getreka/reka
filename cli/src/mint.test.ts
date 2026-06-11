import { describe, it, expect, vi } from "vitest";
import { MintDeps, resolveApiKey } from "./mint";

function makeDeps(overrides: Partial<MintDeps> = {}): MintDeps {
  return {
    execFile: vi.fn(async () => ({ stdout: "" })),
    httpGet: vi.fn(async () => ({ status: 200 })),
    prompt: vi.fn(async () => "rk_test_prompted"),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
}

const baseOpts = {
  projectName: "myapp",
  apiUrl: "http://localhost:3100",
  container: "reka-api",
};

describe("resolveApiKey fallback order", () => {
  it("uses --key first and touches nothing else", async () => {
    const deps = makeDeps();
    const result = await resolveApiKey({ ...baseOpts, key: "rk_flag" }, deps);
    expect(result).toEqual({ key: "rk_flag", source: "flag" });
    expect(deps.execFile).not.toHaveBeenCalled();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("reuses a verified existing key without minting", async () => {
    const deps = makeDeps();
    const result = await resolveApiKey(
      { ...baseOpts, existingKey: "rk_existing" },
      deps,
    );
    expect(result).toEqual({ key: "rk_existing", source: "existing" });
    expect(deps.httpGet).toHaveBeenCalledWith(
      "http://localhost:3100/api/whoami",
      { "X-Api-Key": "rk_existing" },
    );
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it("mints via docker when the existing key is rejected", async () => {
    const execFile = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return { stdout: "true\n" };
      if (args[0] === "exec") {
        return {
          stdout:
            'noise\n{"key":"rk_myapp_minted","id":"abc123","live":true}\n',
        };
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    });
    // whoami: rejected for old key, OK for minted key
    const httpGet = vi.fn(async (_url: string, headers?: any) => ({
      status: headers?.["X-Api-Key"] === "rk_stale" ? 403 : 200,
    }));
    const deps = makeDeps({ execFile, httpGet });

    const result = await resolveApiKey(
      { ...baseOpts, existingKey: "rk_stale" },
      deps,
    );
    expect(result.source).toBe("minted");
    expect(result.key).toBe("rk_myapp_minted");
    expect(result.keyId).toBe("abc123");
    expect(result.restarted).toBeFalsy();
  });

  it("restarts the container when the mint was not live, then verifies", async () => {
    const calls: string[] = [];
    const execFile = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args[0]);
      if (args[0] === "inspect") return { stdout: "true" };
      if (args[0] === "exec")
        return { stdout: '{"key":"rk_myapp_x","id":"id9","live":false}' };
      if (args[0] === "restart") return { stdout: "" };
      throw new Error("unexpected");
    });
    const deps = makeDeps({ execFile });

    const result = await resolveApiKey(baseOpts, deps);
    expect(result).toEqual({
      key: "rk_myapp_x",
      source: "minted",
      keyId: "id9",
      restarted: true,
    });
    expect(calls).toEqual(["inspect", "exec", "restart"]);
  });

  it("falls back to the prompt when docker is unavailable", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("docker: command not found");
    });
    const deps = makeDeps({ execFile });

    const result = await resolveApiKey(baseOpts, deps);
    expect(result).toEqual({ key: "rk_test_prompted", source: "prompt" });
    expect(deps.prompt).toHaveBeenCalledOnce();
  });

  it("with --force skips reuse and mints fresh", async () => {
    const execFile = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "inspect") return { stdout: "true" };
      return { stdout: '{"key":"rk_myapp_fresh","id":"n1","live":true}' };
    });
    const deps = makeDeps({ execFile });

    const result = await resolveApiKey(
      { ...baseOpts, existingKey: "rk_existing", force: true },
      deps,
    );
    expect(result.key).toBe("rk_myapp_fresh");
    expect(result.source).toBe("minted");
  });
});
