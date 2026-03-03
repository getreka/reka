/**
 * Unit tests for Rate Limiting Middleware
 *
 * Location: rag-api/src/middleware/__tests__/rate-limiter.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock config before importing the module
vi.mock('../../config', () => ({
  default: {
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    LOG_LEVEL: 'error',
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { rateLimiterMiddleware, _resetRateLimiter, _getActiveClients } from '../rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReq(ip: string = '192.168.1.1', path: string = '/api/search'): Partial<Request> {
  return {
    headers: {},
    path,
    method: 'POST',
    ip,
    socket: { remoteAddress: ip } as any,
  };
}

function createMockRes(): Partial<Response> & { statusCode: number; headers: Record<string, string | number> } {
  const res: any = {
    statusCode: 200,
    headers: {},
    setHeader: vi.fn((key: string, value: string | number) => {
      res.headers[key] = value;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(() => res),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimiterMiddleware', () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.clearAllMocks();
  });

  it('should allow requests under the limit', () => {
    const req = createMockReq() as Request;
    const res = createMockRes() as unknown as Response;
    const next = vi.fn() as NextFunction;

    rateLimiterMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', 100);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', 99);
  });

  it('should track remaining requests correctly', () => {
    const req = createMockReq() as Request;
    const next = vi.fn() as NextFunction;

    // Make 5 requests
    for (let i = 0; i < 5; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req, res as unknown as Response, next);
    }

    expect(next).toHaveBeenCalledTimes(5);

    // 6th request should show 94 remaining
    const res = createMockRes();
    rateLimiterMiddleware(req, res as unknown as Response, next);
    expect(res.headers['RateLimit-Remaining']).toBe(94);
  });

  it('should return 429 when limit is exceeded', () => {
    const req = createMockReq() as Request;
    const next = vi.fn() as NextFunction;

    // Exhaust the limit
    for (let i = 0; i < 100; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req, res as unknown as Response, next);
    }

    expect(next).toHaveBeenCalledTimes(100);

    // 101st request should be rejected
    const res = createMockRes();
    rateLimiterMiddleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(100); // not called again
    expect(res.statusCode).toBe(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Too many requests',
        code: 'RATE_LIMIT',
      })
    );
  });

  it('should set Retry-After header on 429', () => {
    const req = createMockReq() as Request;
    const next = vi.fn() as NextFunction;

    // Exhaust the limit
    for (let i = 0; i < 100; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req, res as unknown as Response, next);
    }

    // Trigger 429
    const res = createMockRes();
    rateLimiterMiddleware(req, res as unknown as Response, next);

    expect(res.headers['Retry-After']).toBeDefined();
    expect(typeof res.headers['Retry-After']).toBe('number');
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('should track IPs independently', () => {
    const next = vi.fn() as NextFunction;

    // IP 1: exhaust limit
    const req1 = createMockReq('10.0.0.1') as Request;
    for (let i = 0; i < 100; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req1, res as unknown as Response, next);
    }

    // IP 1 should be blocked
    const res1 = createMockRes();
    rateLimiterMiddleware(req1, res1 as unknown as Response, next);
    expect(res1.statusCode).toBe(429);

    // IP 2: should still be allowed
    const req2 = createMockReq('10.0.0.2') as Request;
    const res2 = createMockRes();
    rateLimiterMiddleware(req2, res2 as unknown as Response, next);
    expect(res2.headers['RateLimit-Remaining']).toBe(99);
  });

  it('should skip rate limiting for /health', () => {
    const req = createMockReq('1.2.3.4', '/health') as Request;
    const res = createMockRes() as unknown as Response;
    const next = vi.fn() as NextFunction;

    rateLimiterMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('should skip rate limiting for /metrics', () => {
    const req = createMockReq('1.2.3.4', '/metrics') as Request;
    const res = createMockRes() as unknown as Response;
    const next = vi.fn() as NextFunction;

    rateLimiterMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('should use X-Forwarded-For header when available', () => {
    const next = vi.fn() as NextFunction;

    // Create request with X-Forwarded-For
    const req = createMockReq('127.0.0.1') as Request;
    req.headers['x-forwarded-for'] = '203.0.113.50, 70.41.3.18';

    // Exhaust limit for the forwarded IP
    for (let i = 0; i < 100; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req, res as unknown as Response, next);
    }

    // Same forwarded IP should be blocked
    const res1 = createMockRes();
    rateLimiterMiddleware(req, res1 as unknown as Response, next);
    expect(res1.statusCode).toBe(429);

    // Different forwarded IP should still work
    const req2 = createMockReq('127.0.0.1') as Request;
    req2.headers['x-forwarded-for'] = '203.0.113.51';
    const res2 = createMockRes();
    rateLimiterMiddleware(req2, res2 as unknown as Response, next);
    expect(res2.headers['RateLimit-Remaining']).toBe(99);
  });

  it('should track active clients', () => {
    const next = vi.fn() as NextFunction;

    expect(_getActiveClients()).toBe(0);

    const req1 = createMockReq('10.0.0.1') as Request;
    const res1 = createMockRes();
    rateLimiterMiddleware(req1, res1 as unknown as Response, next);

    const req2 = createMockReq('10.0.0.2') as Request;
    const res2 = createMockRes();
    rateLimiterMiddleware(req2, res2 as unknown as Response, next);

    expect(_getActiveClients()).toBe(2);
  });

  it('should reset state properly', () => {
    const next = vi.fn() as NextFunction;

    // Add some requests
    const req = createMockReq() as Request;
    const res = createMockRes();
    rateLimiterMiddleware(req, res as unknown as Response, next);

    expect(_getActiveClients()).toBe(1);

    _resetRateLimiter();

    expect(_getActiveClients()).toBe(0);
  });

  it('should include rate limit details in 429 response body', () => {
    const req = createMockReq() as Request;
    const next = vi.fn() as NextFunction;

    // Exhaust the limit
    for (let i = 0; i < 100; i++) {
      const res = createMockRes();
      rateLimiterMiddleware(req, res as unknown as Response, next);
    }

    // Trigger 429
    const res = createMockRes();
    rateLimiterMiddleware(req, res as unknown as Response, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          limit: 100,
          windowMs: 60000,
          retryAfter: expect.any(Number),
        }),
      })
    );
  });

  it('should always set RateLimit headers on allowed requests', () => {
    const req = createMockReq() as Request;
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    rateLimiterMiddleware(req, res as unknown as Response, next);

    // Verify all three standard headers are set
    expect(res.headers['RateLimit-Limit']).toBe(100);
    expect(res.headers['RateLimit-Remaining']).toBe(99);
    expect(res.headers['RateLimit-Reset']).toBeDefined();
    expect(typeof res.headers['RateLimit-Reset']).toBe('number');
  });
});
