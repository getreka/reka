import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  summarizeInput,
  countResults,
  formatToolError,
  TRACKING_EXCLUDE,
  SESSION_TOOLS,
  TOOL_TIMEOUTS,
} from "../tool-middleware.js";

describe("Tool Middleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("summarizeInput", () => {
    it("extracts query field", () => {
      expect(summarizeInput("search", { query: "find auth code" })).toBe(
        "find auth code",
      );
    });

    it("extracts question field", () => {
      expect(summarizeInput("ask", { question: "what is auth?" })).toBe(
        "what is auth?",
      );
    });

    it("extracts content field as fallback", () => {
      expect(summarizeInput("remember", { content: "important note" })).toBe(
        "important note",
      );
    });

    it("extracts file path as fallback", () => {
      expect(summarizeInput("explain", { filePath: "src/auth.ts" })).toBe(
        "src/auth.ts",
      );
    });

    it("truncates long strings to 200 chars", () => {
      const long = "a".repeat(300);
      expect(
        summarizeInput("search", { query: long }).length,
      ).toBeLessThanOrEqual(200);
    });

    it("returns tool name when no useful field", () => {
      expect(summarizeInput("get_stats", {})).toBe("get_stats");
    });
  });

  describe("countResults", () => {
    it('returns 0 for "No results" messages', () => {
      expect(countResults("No results found.")).toBe(0);
    });

    it('returns 0 for "not found" messages', () => {
      expect(countResults("Memory not found")).toBe(0);
    });

    it("counts numbered items", () => {
      const text = "1. First\n2. Second\n3. Third";
      expect(countResults(text)).toBe(3);
    });

    it("counts bullet items", () => {
      const text = "- item1\n- item2";
      expect(countResults(text)).toBe(2);
    });

    it("returns 1 for generic content", () => {
      expect(countResults("Some response text")).toBe(1);
    });
  });

  describe("formatToolError", () => {
    const ctx = {
      api: { defaults: { baseURL: "http://localhost:3100" } },
    } as any;

    it("formats ECONNREFUSED error", () => {
      const err = { code: "ECONNREFUSED" };
      const result = formatToolError(err, ctx);
      expect(result).toContain("Cannot connect");
      expect(result).toContain("localhost:3100");
    });

    it("formats API error with status", () => {
      const err = { response: { status: 404, data: { error: "not found" } } };
      const result = formatToolError(err, ctx);
      expect(result).toContain("404");
    });

    it("formats generic error message", () => {
      const err = { message: "Something broke" };
      const result = formatToolError(err, ctx);
      expect(result).toContain("Something broke");
    });
  });

  describe("constants", () => {
    it("TRACKING_EXCLUDE contains meta tools", () => {
      expect(TRACKING_EXCLUDE.has("get_tool_analytics")).toBe(true);
      expect(TRACKING_EXCLUDE.has("get_quality_metrics")).toBe(true);
    });

    it("SESSION_TOOLS contains session management", () => {
      expect(SESSION_TOOLS.has("start_session")).toBe(true);
      expect(SESSION_TOOLS.has("end_session")).toBe(true);
    });

    it("TOOL_TIMEOUTS has correct tiers", () => {
      expect(TOOL_TIMEOUTS["index_codebase"]).toBe(120_000);
      expect(TOOL_TIMEOUTS["search_codebase"]).toBe(15_000);
      expect(TOOL_TIMEOUTS["recall"]).toBe(10_000);
    });
  });
});
