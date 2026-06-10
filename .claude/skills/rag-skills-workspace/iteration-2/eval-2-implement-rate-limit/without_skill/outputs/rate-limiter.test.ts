/**
 * Rate Limiter Middleware Tests
 *
 * File: rag-api/src/__tests__/middleware/rate-limiter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  rateLimitMiddleware,
  SlidingWindowStore,
  extractClientIP,
  normalizeIP,
  maskIP,
  hashIP,
  _resetStore,
} from "../../middleware/rate-limiter";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock("../../config", () => ({
  default: {
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_MAX: 5, // Low limit for testing
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_SKIP_PATHS: ["/health", "/metrics"],
  },
}));

vi.mock("../../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../utils/metrics", () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
  rateLimitActiveIPs: { set: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    path: "/api/search",
    method: "POST",
    ip: "192.168.1.100",
    headers: {},
    socket: { remoteAddress: "192.168.1.100" },
    requestId: "test-req-id",
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): Response & {
  _status?: number;
  _json?: any;
  _headers: Record<string, any>;
} {
  const res: any = {
    _headers: {},
    _status: undefined,
    _json: undefined,
  };
  res.setHeader = vi.fn((key: string, value: any) => {
    res._headers[key] = value;
    return res;
  });
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res._json = body;
    return res;
  });
  return res;
}

// ---------------------------------------------------------------------------
// Tests: SlidingWindowStore
// ---------------------------------------------------------------------------

describe("SlidingWindowStore", () => {
  let store: SlidingWindowStore;

  beforeEach(() => {
    store = new SlidingWindowStore(60_000);
  });

  afterEach(() => {
    store.destroy();
  });

  it("should count requests within window", () => {
    const now = Date.now();
    const r1 = store.hit("ip1", now);
    expect(r1.count).toBe(1);

    const r2 = store.hit("ip1", now + 1000);
    expect(r2.count).toBe(2);

    const r3 = store.hit("ip1", now + 2000);
    expect(r3.count).toBe(3);
  });

  it("should isolate different IPs", () => {
    const now = Date.now();
    store.hit("ip1", now);
    store.hit("ip1", now);
    store.hit("ip2", now);

    expect(store.hit("ip1", now).count).toBe(3);
    expect(store.hit("ip2", now).count).toBe(2);
  });

  it("should expire old timestamps outside the window", () => {
    const now = Date.now();
    store.hit("ip1", now);
    store.hit("ip1", now + 1000);

    // Jump past the window
    const r = store.hit("ip1", now + 61_000);
    expect(r.count).toBe(1); // Only the latest request
  });

  it("should return correct resetAt time", () => {
    const now = 1000000;
    const r = store.hit("ip1", now);
    expect(r.resetAt).toBe(now + 60_000);
  });

  it("should track store size", () => {
    const now = Date.now();
    store.hit("ip1", now);
    store.hit("ip2", now);
    store.hit("ip3", now);
    expect(store.size).toBe(3);
  });

  it("should peek without recording", () => {
    const now = Date.now();
    store.hit("ip1", now);
    store.hit("ip1", now + 100);

    const peek = store.peek("ip1", now + 200);
    expect(peek.count).toBe(2);

    // Peek again -- count should still be 2 (no new hit recorded)
    const peek2 = store.peek("ip1", now + 300);
    expect(peek2.count).toBe(2);
  });

  it("should return 0 for unknown IP peek", () => {
    const now = Date.now();
    const peek = store.peek("unknown-ip", now);
    expect(peek.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: IP extraction and helpers
// ---------------------------------------------------------------------------

describe("extractClientIP", () => {
  it("should prefer X-Forwarded-For header", () => {
    const req = createMockRequest({
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    expect(extractClientIP(req)).toBe("10.0.0.1");
  });

  it("should use X-Real-IP as fallback", () => {
    const req = createMockRequest({
      headers: { "x-real-ip": "10.0.0.5" },
    });
    expect(extractClientIP(req)).toBe("10.0.0.5");
  });

  it("should fall back to req.ip", () => {
    const req = createMockRequest({ ip: "172.16.0.1" });
    expect(extractClientIP(req)).toBe("172.16.0.1");
  });
});

describe("normalizeIP", () => {
  it("should strip IPv6-mapped IPv4 prefix", () => {
    expect(normalizeIP("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("should leave plain IPv4 unchanged", () => {
    expect(normalizeIP("192.168.1.1")).toBe("192.168.1.1");
  });

  it("should leave plain IPv6 unchanged", () => {
    expect(normalizeIP("::1")).toBe("::1");
  });
});

describe("maskIP", () => {
  it("should mask last two octets of IPv4", () => {
    expect(maskIP("192.168.1.42")).toBe("192.168.x.x");
  });

  it("should mask IPv6 after 4 groups", () => {
    expect(maskIP("2001:db8:85a3:0:0:8a2e:370:7334")).toBe(
      "2001:db8:85a3:0:...",
    );
  });
});

describe("hashIP", () => {
  it("should produce consistent hash", () => {
    expect(hashIP("192.168.1.1")).toBe(hashIP("192.168.1.1"));
  });

  it("should produce different hashes for different IPs", () => {
    expect(hashIP("192.168.1.1")).not.toBe(hashIP("192.168.1.2"));
  });

  it("should return a string", () => {
    expect(typeof hashIP("10.0.0.1")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: Middleware integration
// ---------------------------------------------------------------------------

describe("rateLimitMiddleware", () => {
  beforeEach(() => {
    _resetStore();
  });

  afterEach(() => {
    _resetStore();
  });

  it("should allow requests under the limit", () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    rateLimitMiddleware(req, res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res._headers["X-RateLimit-Limit"]).toBe(5);
    expect(res._headers["X-RateLimit-Remaining"]).toBe(4);
  });

  it("should reject requests over the limit with 429", () => {
    const next = vi.fn();

    // Send 5 requests (at limit)
    for (let i = 0; i < 5; i++) {
      const req = createMockRequest();
      const res = createMockResponse();
      rateLimitMiddleware(req, res, next as NextFunction);
    }

    // 6th request should be rejected
    const req = createMockRequest();
    const res = createMockResponse();
    const nextFinal = vi.fn();

    rateLimitMiddleware(req, res, nextFinal as NextFunction);

    expect(nextFinal).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect(res._json).toMatchObject({
      error: "Rate limit exceeded",
      code: "RATE_LIMIT",
    });
    expect(res._json.details).toHaveProperty("retryAfter");
    expect(res._json.details).toHaveProperty("limit", 5);
    expect(res._headers["Retry-After"]).toBeDefined();
  });

  it("should set rate limit headers on every response", () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    rateLimitMiddleware(req, res, next as NextFunction);

    expect(res._headers).toHaveProperty("X-RateLimit-Limit");
    expect(res._headers).toHaveProperty("X-RateLimit-Remaining");
    expect(res._headers).toHaveProperty("X-RateLimit-Reset");
  });

  it("should skip rate limiting for /health", () => {
    const req = createMockRequest({ path: "/health" });
    const res = createMockResponse();
    const next = vi.fn();

    rateLimitMiddleware(req, res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    // No rate limit headers should be set for skipped paths
    expect(res._headers["X-RateLimit-Limit"]).toBeUndefined();
  });

  it("should skip rate limiting for /metrics", () => {
    const req = createMockRequest({ path: "/metrics" });
    const res = createMockResponse();
    const next = vi.fn();

    rateLimitMiddleware(req, res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res._headers["X-RateLimit-Limit"]).toBeUndefined();
  });

  it("should track different IPs independently", () => {
    const next = vi.fn();

    // Exhaust limit for IP1
    for (let i = 0; i < 6; i++) {
      const req = createMockRequest({ ip: "10.0.0.1" });
      const res = createMockResponse();
      rateLimitMiddleware(req, res, next as NextFunction);
    }

    // IP2 should still be allowed
    const req = createMockRequest({ ip: "10.0.0.2" });
    const res = createMockResponse();
    const nextIP2 = vi.fn();

    rateLimitMiddleware(req, res, nextIP2 as NextFunction);

    expect(nextIP2).toHaveBeenCalled();
    expect(res._headers["X-RateLimit-Remaining"]).toBe(4);
  });

  it("should show correct remaining count", () => {
    const next = vi.fn();

    // 1st request
    const res1 = createMockResponse();
    rateLimitMiddleware(createMockRequest(), res1, next as NextFunction);
    expect(res1._headers["X-RateLimit-Remaining"]).toBe(4);

    // 2nd request
    const res2 = createMockResponse();
    rateLimitMiddleware(createMockRequest(), res2, next as NextFunction);
    expect(res2._headers["X-RateLimit-Remaining"]).toBe(3);

    // 3rd request
    const res3 = createMockResponse();
    rateLimitMiddleware(createMockRequest(), res3, next as NextFunction);
    expect(res3._headers["X-RateLimit-Remaining"]).toBe(2);
  });
});
