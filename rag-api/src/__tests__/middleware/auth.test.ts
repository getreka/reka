import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, resetKeys } from '../../middleware/auth';
import config from '../../config';

// Helper to build mock req/res/next
function createMocks(overrides?: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}) {
  const req = {
    path: overrides?.path ?? '/api/search',
    method: overrides?.method ?? 'POST',
    headers: overrides?.headers ?? {},
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies access when no API keys configured (deny-by-default)', () => {
    const original = config.API_KEY;
    (config as any).API_KEY = undefined;
    delete process.env.ALLOW_ANONYMOUS;
    resetKeys();

    const { req, res, next } = createMocks();
    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_NOT_CONFIGURED' }));

    (config as any).API_KEY = original;
  });

  it('allows anonymous access when ALLOW_ANONYMOUS=true', () => {
    const original = config.API_KEY;
    (config as any).API_KEY = undefined;
    process.env.ALLOW_ANONYMOUS = 'true';
    resetKeys();

    const { req, res, next } = createMocks();
    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    (config as any).API_KEY = original;
    delete process.env.ALLOW_ANONYMOUS;
  });

  it('skips auth for /health endpoint', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({ path: '/health' });
    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('requires auth for /metrics endpoint', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({ path: '/metrics' });
    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts valid Bearer token', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({
      headers: { authorization: 'Bearer test-key' },
    });
    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts valid X-API-Key header', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({
      headers: { 'x-api-key': 'test-key' },
    });
    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when no key is provided', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({ headers: {} });
    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
  });

  it('returns 403 when key is invalid', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({
      headers: { authorization: 'Bearer wrong-key' },
    });
    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_API_KEY' }));
  });

  it('returns 403 for key with different length (timing-safe)', () => {
    (config as any).API_KEY = 'test-key';
    resetKeys();

    const { req, res, next } = createMocks({
      headers: { 'x-api-key': 'short' },
    });
    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
