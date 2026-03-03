import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../middleware/async-handler';

function createMocks() {
  const req = {
    path: '/api/test',
    method: 'POST',
    headers: {},
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('asyncHandler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls the handler and does not forward errors when fn resolves successfully', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { req, res, next } = createMocks();

    const handler = asyncHandler(fn);
    await handler(req, res, next);

    expect(fn).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });

  it('calls next(err) when the async handler rejects', async () => {
    const err = new Error('async failure');
    const fn = vi.fn().mockRejectedValue(err);
    const { req, res, next } = createMocks();

    const handler = asyncHandler(fn);
    handler(req, res, next);

    // Flush all pending microtasks by awaiting a setImmediate-level turn
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(err);
  });

  it('calls next(err) when fn throws synchronously inside an async function', async () => {
    const err = new Error('sync throw inside async');
    const fn = vi.fn(async () => {
      throw err;
    });
    const { req, res, next } = createMocks();

    const handler = asyncHandler(fn);
    handler(req, res, next);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(err);
  });
});
