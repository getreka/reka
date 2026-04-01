import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from '../../utils/retry';
import { AppError, ExternalServiceError } from '../../utils/errors';

// Small delays to avoid slow tests while still exercising real retry logic
const fastOpts = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, timeoutMs: undefined };

describe('withRetry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns value immediately on first-try success', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(operation, fastOpts);

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and returns value on eventual success', async () => {
    const retryableErr = new ExternalServiceError('Qdrant', 'connection lost');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(retryableErr)
      .mockRejectedValueOnce(retryableErr)
      .mockResolvedValue('recovered');

    const result = await withRetry(operation, fastOpts);

    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('throws last error after all attempts fail', async () => {
    const retryableErr = new ExternalServiceError('Qdrant', 'unavailable');
    const operation = vi.fn().mockRejectedValue(retryableErr);

    await expect(withRetry(operation, fastOpts)).rejects.toThrow('Qdrant: unavailable');
    expect(operation).toHaveBeenCalledTimes(fastOpts.maxAttempts);
  });

  it('throws immediately for non-retryable error without retrying', async () => {
    const nonRetryable = new AppError('not found', 'NOT_FOUND', 404, false);
    const operation = vi.fn().mockRejectedValue(nonRetryable);

    await expect(withRetry(operation, fastOpts)).rejects.toThrow('not found');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry callback with error, attempt, and delay', async () => {
    const retryableErr = new ExternalServiceError('BGE', 'timeout');
    const operation = vi.fn().mockRejectedValueOnce(retryableErr).mockResolvedValue('done');

    const onRetry = vi.fn();

    await withRetry(operation, { ...fastOpts, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(retryableErr, 1, expect.any(Number));
  });

  it('calls onRetry on each failed attempt except the last', async () => {
    const retryableErr = new ExternalServiceError('BGE', 'error');
    const operation = vi.fn().mockRejectedValue(retryableErr);
    const onRetry = vi.fn();

    await expect(withRetry(operation, { ...fastOpts, maxAttempts: 4, onRetry })).rejects.toThrow();

    // onRetry is called for attempts 1, 2, 3 (not on the last attempt 4)
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('throws TimeoutError when timeoutMs elapses before operation completes', async () => {
    const operation = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));

    await expect(
      withRetry(operation, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('uses custom operationName in logs without affecting behavior', async () => {
    const operation = vi.fn().mockResolvedValue(42);

    const result = await withRetry(operation, fastOpts, 'myCustomOperation');

    expect(result).toBe(42);
  });

  it('retries on network error with ECONNREFUSED code', async () => {
    const networkErr = new Error('connect ECONNREFUSED');
    (networkErr as any).code = 'ECONNREFUSED';

    const operation = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValue('reconnected');

    const result = await withRetry(operation, fastOpts);

    expect(result).toBe('reconnected');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
