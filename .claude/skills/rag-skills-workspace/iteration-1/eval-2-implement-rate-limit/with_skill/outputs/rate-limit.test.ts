import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  rateLimitMiddleware,
  resetStore,
  stopCleanup,
  getStoreSize,
} from "../../middleware/rate-limit";
import config from "../../config";

// Helper to build mock req/res/next (follows auth.test.ts pattern)
function createMocks(overrides?: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  ip?: string;
}) {
  const req = {
    path: overrides?.path ?? "/api/search",
    method: overrides?.method ?? "POST",
    headers: overrides?.headers ?? {},
    ip: overrides?.ip ?? "127.0.0.1",
    socket: { remoteAddress: overrides?.ip ?? "127.0.0.1" },
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe("rateLimitMiddleware", () => {
  let originalMax: number;
  let originalWindow: number;

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    originalMax = config.RATE_LIMIT_MAX;
    originalWindow = config.RATE_LIMIT_WINDOW_MS;
    // Set test defaults
    (config as any).RATE_LIMIT_MAX = 5;
    (config as any).RATE_LIMIT_WINDOW_MS = 60_000;
  });

  afterEach(() => {
    (config as any).RATE_LIMIT_MAX = originalMax;
    (config as any).RATE_LIMIT_WINDOW_MS = originalWindow;
    stopCleanup();
  });

  it("allows requests under the limit", () => {
    const { req, res, next } = createMocks();
    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("sets rate limit headers on every response", () => {
    const { req, res, next } = createMocks();
    rateLimitMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 5);
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Remaining",
      expect.any(Number),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Reset",
      expect.any(Number),
    );
  });

  it("decrements remaining count with each request", () => {
    const { req, res, next } = createMocks({ ip: "10.0.0.1" });

    rateLimitMiddleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 4);

    const {
      req: req2,
      res: res2,
      next: next2,
    } = createMocks({ ip: "10.0.0.1" });
    rateLimitMiddleware(req2, res2, next2);
    expect(res2.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 3);
  });

  it("returns 429 when limit is exceeded", () => {
    (config as any).RATE_LIMIT_MAX = 3;

    // Make 3 requests (exhaust the limit)
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = createMocks({ ip: "10.0.0.2" });
      rateLimitMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    }

    // 4th request should be rejected
    const { req, res, next } = createMocks({ ip: "10.0.0.2" });
    rateLimitMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Too many requests",
        code: "RATE_LIMIT",
      }),
    );
  });

  it("sets Retry-After header on 429 response", () => {
    (config as any).RATE_LIMIT_MAX = 1;

    // First request passes
    const {
      req: req1,
      res: res1,
      next: next1,
    } = createMocks({ ip: "10.0.0.3" });
    rateLimitMiddleware(req1, res1, next1);

    // Second request should be rate limited
    const { req, res, next } = createMocks({ ip: "10.0.0.3" });
    rateLimitMiddleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.any(Number),
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("tracks requests per IP independently", () => {
    (config as any).RATE_LIMIT_MAX = 2;

    // IP 1: 2 requests
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = createMocks({ ip: "10.0.0.10" });
      rateLimitMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    }

    // IP 1: 3rd request should be blocked
    const {
      req: blockedReq,
      res: blockedRes,
      next: blockedNext,
    } = createMocks({ ip: "10.0.0.10" });
    rateLimitMiddleware(blockedReq, blockedRes, blockedNext);
    expect(blockedRes.status).toHaveBeenCalledWith(429);

    // IP 2: should still be allowed
    const { req, res, next } = createMocks({ ip: "10.0.0.11" });
    rateLimitMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("skips rate limiting for /health endpoint", () => {
    (config as any).RATE_LIMIT_MAX = 1;

    // Exhaust limit
    const {
      req: req1,
      res: res1,
      next: next1,
    } = createMocks({ ip: "10.0.0.20" });
    rateLimitMiddleware(req1, res1, next1);

    // /health should bypass rate limit
    const { req, res, next } = createMocks({
      ip: "10.0.0.20",
      path: "/health",
    });
    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("skips rate limiting for /metrics endpoint", () => {
    const { req, res, next } = createMocks({ path: "/metrics" });
    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled(); // No rate limit headers
  });

  it("skips rate limiting when RATE_LIMIT_MAX is 0 (disabled)", () => {
    (config as any).RATE_LIMIT_MAX = 0;

    const { req, res, next } = createMocks();
    rateLimitMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("uses X-Forwarded-For header for IP detection", () => {
    (config as any).RATE_LIMIT_MAX = 1;

    // Request with X-Forwarded-For
    const {
      req: req1,
      res: res1,
      next: next1,
    } = createMocks({
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18" },
    });
    rateLimitMiddleware(req1, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Same forwarded IP should be rate limited
    const {
      req: req2,
      res: res2,
      next: next2,
    } = createMocks({
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.50" },
    });
    rateLimitMiddleware(req2, res2, next2);
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  it("cleans up store entries", () => {
    const { req, res, next } = createMocks({ ip: "10.0.0.30" });
    rateLimitMiddleware(req, res, next);
    expect(getStoreSize()).toBe(1);

    resetStore();
    expect(getStoreSize()).toBe(0);
  });

  it("includes retryAfter details in 429 response body", () => {
    (config as any).RATE_LIMIT_MAX = 1;

    // Exhaust limit
    const {
      req: req1,
      res: res1,
      next: next1,
    } = createMocks({ ip: "10.0.0.40" });
    rateLimitMiddleware(req1, res1, next1);

    // Trigger 429
    const { req, res, next } = createMocks({ ip: "10.0.0.40" });
    rateLimitMiddleware(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          retryAfter: expect.any(Number),
          limit: 1,
          windowMs: 60_000,
        }),
      }),
    );
  });
});
