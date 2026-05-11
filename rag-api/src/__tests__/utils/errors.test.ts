import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ExternalServiceError,
  RateLimitError,
  TimeoutError,
  CircuitOpenError,
  ConfigurationError,
  EmbeddingError,
  isRetryableError,
  wrapError,
} from '../../utils/errors';

describe('AppError', () => {
  it('sets all properties from constructor', () => {
    const err = new AppError('boom', 'TEST_ERR', 418, true, { key: 'val' });
    expect(err.message).toBe('boom');
    expect(err.code).toBe('TEST_ERR');
    expect(err.statusCode).toBe(418);
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ key: 'val' });
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults statusCode=500 and retryable=false', () => {
    const err = new AppError('msg', 'CODE');
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(false);
  });

  it('toJSON returns structured output', () => {
    const err = new AppError('msg', 'CODE', 500, false, { x: 1 });
    expect(err.toJSON()).toEqual({ error: 'msg', code: 'CODE', details: { x: 1 } });
  });
});

describe('ValidationError', () => {
  it('has statusCode 400 and is not retryable', () => {
    const err = new ValidationError('bad input', { field: 'name' });
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual({ field: 'name' });
  });
});

describe('NotFoundError', () => {
  it('has statusCode 404 and formats resource name', () => {
    const err = new NotFoundError('Widget');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Widget not found');
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('ExternalServiceError', () => {
  it('is retryable with statusCode 503', () => {
    const err = new ExternalServiceError('Qdrant', 'connection lost');
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.service).toBe('Qdrant');
    expect(err.message).toBe('Qdrant: connection lost');
  });
});

describe('RateLimitError', () => {
  it('stores retryAfter and is retryable', () => {
    const err = new RateLimitError('OpenAI', 30);
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBe(30);
  });
});

describe('TimeoutError', () => {
  it('formats message with operation and timeout', () => {
    const err = new TimeoutError('embed', 5000);
    expect(err.message).toBe('embed timed out after 5000ms');
    expect(err.statusCode).toBe(504);
    expect(err.retryable).toBe(true);
  });
});

describe('CircuitOpenError', () => {
  it('is not retryable', () => {
    const err = new CircuitOpenError('BGE-M3');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(503);
  });
});

describe('ConfigurationError', () => {
  it('has statusCode 500', () => {
    const err = new ConfigurationError('missing key');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('EmbeddingError', () => {
  it('has statusCode 502 and is non-retryable', () => {
    const err = new EmbeddingError('empty input', { callsite: 'embedWithOllama' });
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('EMBEDDING_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Embedding failed: empty input');
    expect(err.details).toEqual({ callsite: 'embedWithOllama' });
  });

  it('is not flagged as retryable by isRetryableError', () => {
    expect(isRetryableError(new EmbeddingError('boom'))).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('returns true for retryable AppError', () => {
    expect(isRetryableError(new ExternalServiceError('s', 'm'))).toBe(true);
  });

  it('returns false for non-retryable AppError', () => {
    expect(isRetryableError(new ValidationError('bad'))).toBe(false);
  });

  it('returns true for ECONNREFUSED', () => {
    const err = new Error('fail');
    (err as any).code = 'ECONNREFUSED';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    const err = new Error('timeout');
    (err as any).code = 'ETIMEDOUT';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for HTTP 502', () => {
    const err = new Error('bad gateway');
    (err as any).status = 502;
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for HTTP 429 via response.status', () => {
    const err = new Error('rate limited');
    (err as any).response = { status: 429 };
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for unknown non-Error', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('wrapError', () => {
  it('returns AppError unchanged', () => {
    const original = new ValidationError('bad');
    expect(wrapError(original)).toBe(original);
  });

  it('wraps ECONNREFUSED into ExternalServiceError', () => {
    const err = new Error('fail');
    (err as any).code = 'ECONNREFUSED';
    const wrapped = wrapError(err);
    expect(wrapped).toBeInstanceOf(ExternalServiceError);
    expect(wrapped.retryable).toBe(true);
  });

  it('wraps ETIMEDOUT into TimeoutError', () => {
    const err = new Error('timeout');
    (err as any).code = 'ETIMEDOUT';
    const wrapped = wrapError(err);
    expect(wrapped).toBeInstanceOf(TimeoutError);
  });

  it('wraps 429 into RateLimitError', () => {
    const err = new Error('limit');
    (err as any).status = 429;
    const wrapped = wrapError(err);
    expect(wrapped).toBeInstanceOf(RateLimitError);
  });

  it('wraps generic Error into AppError with UNKNOWN_ERROR', () => {
    const err = new Error('oops');
    const wrapped = wrapError(err);
    expect(wrapped.code).toBe('UNKNOWN_ERROR');
    expect(wrapped.message).toBe('oops');
  });

  it('wraps non-Error into AppError with default message', () => {
    const wrapped = wrapError('random');
    expect(wrapped.code).toBe('UNKNOWN_ERROR');
    expect(wrapped.message).toBe('Unknown error');
  });

  it('uses provided default message for non-Error', () => {
    const wrapped = wrapError(undefined, 'custom default');
    expect(wrapped.message).toBe('custom default');
  });
});
