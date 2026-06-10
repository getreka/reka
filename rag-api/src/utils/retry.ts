/**
 * Retry Logic - Exponential backoff with jitter
 */

import { logger } from './logger';
import { isRetryableError, TimeoutError } from './errors';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs?: number;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 10000,
  timeoutMs: 30000,
};

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add jitter to delay (±10%)
 */
function addJitter(delayMs: number): number {
  const jitter = delayMs * 0.1;
  return delayMs + (Math.random() * 2 - 1) * jitter;
}

/**
 * Calculate delay with exponential backoff
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  return addJitter(cappedDelay);
}

/**
 * Create a timeout promise
 */
function createTimeout<T>(ms: number, operation: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(operation, ms));
    }, ms);
  });
}

/**
 * Execute an operation with retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
  operationName: string = 'operation'
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Execute with optional timeout
      if (opts.timeoutMs) {
        return await Promise.race([operation(), createTimeout<T>(opts.timeoutMs, operationName)]);
      }
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Check if error is retryable
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === opts.maxAttempts) {
        break;
      }

      // Calculate delay
      const delayMs = calculateDelay(attempt, opts);

      // Log retry
      logger.warn(
        `${operationName} failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${Math.round(delayMs)}ms`,
        {
          error: lastError.message,
          attempt,
        }
      );

      // Call onRetry callback
      if (opts.onRetry) {
        opts.onRetry(lastError, attempt, delayMs);
      }

      // Wait before retry
      await sleep(delayMs);
    }
  }

  logger.error(`${operationName} failed after ${opts.maxAttempts} attempts`, {
    error: lastError?.message,
  });
  throw lastError;
}

/**
 * Create a retryable version of a function
 */
export function retryable<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: Partial<RetryOptions> = {},
  operationName?: string
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return withRetry(() => fn(...args), options, operationName || fn.name || 'function');
  }) as T;
}

/**
 * Retry decorator for class methods
 */
export function Retry(options: Partial<RetryOptions> = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      return withRetry(
        () => originalMethod.apply(this, args),
        options,
        `${target.constructor.name}.${propertyKey}`
      );
    };

    return descriptor;
  };
}
