import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodIssue } from 'zod';
import { AppError, NotFoundError } from '../../utils/errors';
import { errorHandler } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';

function createMocks(overrides?: { requestId?: string }) {
  const req = {
    path: '/api/test',
    method: 'POST',
    headers: {},
    requestId: overrides?.requestId,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('errorHandler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handles ZodError with multiple issues → 400 + formatted details array', () => {
    const issues: ZodIssue[] = [
      {
        code: 'invalid_type',
        path: ['body', 'name'],
        message: 'Required',
        expected: 'string',
        received: 'undefined',
      },
      {
        code: 'too_small',
        path: ['body', 'limit'],
        message: 'Too small',
        minimum: 1,
        type: 'number',
        inclusive: true,
      },
    ];
    const zodErr = new ZodError(issues);
    const { req, res, next } = createMocks();

    errorHandler(zodErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: [
        { path: 'body.name', message: 'Required' },
        { path: 'body.limit', message: 'Too small' },
      ],
    });
  });

  it('handles AppError with 404 → 404 + toJSON output, no logging', () => {
    const appErr = new NotFoundError('Project');
    const { req, res, next } = createMocks();

    errorHandler(appErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(appErr.toJSON());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('handles AppError with statusCode 400 → 400, no logging', () => {
    const appErr = new AppError('bad input', 'BAD_INPUT', 400, false);
    const { req, res, next } = createMocks();

    errorHandler(appErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(appErr.toJSON());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('handles AppError with 500 → 500 + toJSON output + logs error', () => {
    const appErr = new AppError('internal failure', 'INTERNAL', 500, false);
    const { req, res, next } = createMocks();

    errorHandler(appErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(appErr.toJSON());
    expect(logger.error).toHaveBeenCalledWith(
      appErr.message,
      expect.objectContaining({ code: appErr.code })
    );
  });

  it('handles regular Error → 500 + logs unhandled error', () => {
    const err = new Error('something unexpected');
    const { req, res, next } = createMocks({ requestId: 'req-abc' });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled error',
      expect.objectContaining({ error: err.message, requestId: 'req-abc' })
    );
  });

  it('handles non-Error thrown value (string) → 500', () => {
    const nonError = 'something went wrong' as unknown as Error;
    const { req, res, next } = createMocks();

    errorHandler(nonError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNKNOWN_ERROR' }));
  });
});
