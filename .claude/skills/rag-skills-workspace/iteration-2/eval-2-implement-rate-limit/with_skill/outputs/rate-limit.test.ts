/**
 * Tests for Rate Limiting Middleware
 *
 * Verifies: sliding window logic, per-IP isolation, header correctness,
 * /health and /metrics bypass, cleanup, and 429 response format.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Express } from "express";
import request from "supertest";

// Mock config before importing middleware
vi.mock("../config", () => ({
  default: {
    RATE_LIMIT_MAX: 5,
    RATE_LIMIT_WINDOW_MS: 60000,
  },
}));

// Mock logger
vi.mock("../utils/logger", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock metrics
vi.mock("../utils/metrics", () => ({
  rateLimitedRequestsTotal: {
    inc: vi.fn(),
  },
}));

import {
  rateLimitMiddleware,
  resetRateLimitState,
  getRateLimitStatus,
} from "../middleware/rate-limit";

function createApp(): Express {
  const app = express();
  app.use(rateLimitMiddleware);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/metrics", (_req, res) => res.send("metrics"));
  app.get("/api/test", (_req, res) => res.json({ data: "ok" }));
  app.post("/api/search", (_req, res) => res.json({ results: [] }));
  return app;
}

describe("Rate Limiting Middleware", () => {
  let app: Express;

  beforeEach(() => {
    resetRateLimitState();
    app = createApp();
  });

  it("should allow requests within the limit", async () => {
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("should decrement remaining count with each request", async () => {
    // First request: remaining = 5 - 0 - 1 = 4
    const res1 = await request(app).get("/api/test");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("4");

    // Second request: remaining = 5 - 1 - 1 = 3
    const res2 = await request(app).get("/api/test");
    expect(res2.headers["x-ratelimit-remaining"]).toBe("3");
  });

  it("should return 429 when limit is exceeded", async () => {
    // Make 5 requests (the limit)
    for (let i = 0; i < 5; i++) {
      await request(app).get("/api/test");
    }

    // 6th request should be rate-limited
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many requests");
    expect(res.body.code).toBe("RATE_LIMIT");
    expect(res.body.retryAfter).toBeDefined();
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("should skip /health endpoint", async () => {
    // Exhaust limit
    for (let i = 0; i < 6; i++) {
      await request(app).get("/api/test");
    }

    // /health should still work
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("should skip /metrics endpoint", async () => {
    // Exhaust limit
    for (let i = 0; i < 6; i++) {
      await request(app).get("/api/test");
    }

    // /metrics should still work
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
  });

  it("should track IPs independently", async () => {
    // Make 5 requests from IP 1
    for (let i = 0; i < 5; i++) {
      await request(app).get("/api/test").set("X-Forwarded-For", "10.0.0.1");
    }

    // IP 1 should be rate-limited
    const res1 = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.0.1");
    expect(res1.status).toBe(429);

    // IP 2 should still have full quota
    const res2 = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.0.2");
    expect(res2.status).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("4");
  });

  it("should respect X-Forwarded-For header", async () => {
    await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "192.168.1.100, 10.0.0.1");

    const status = getRateLimitStatus("192.168.1.100");
    expect(status.requestCount).toBe(1);
  });

  it("getRateLimitStatus should return correct info", async () => {
    await request(app).get("/api/test").set("X-Forwarded-For", "1.2.3.4");
    await request(app).get("/api/test").set("X-Forwarded-For", "1.2.3.4");

    const status = getRateLimitStatus("1.2.3.4");
    expect(status.requestCount).toBe(2);
    expect(status.limit).toBe(5);
    expect(status.remaining).toBe(3);
    expect(status.windowMs).toBe(60000);
  });

  it("resetRateLimitState should clear all tracking", async () => {
    await request(app).get("/api/test").set("X-Forwarded-For", "1.2.3.4");

    resetRateLimitState();

    const status = getRateLimitStatus("1.2.3.4");
    expect(status.requestCount).toBe(0);
    expect(status.remaining).toBe(5);
  });

  it("should return proper JSON error structure on 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/api/test");
    }

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(429);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Too many requests",
        code: "RATE_LIMIT",
        retryAfter: expect.any(Number),
      }),
    );
  });
});
