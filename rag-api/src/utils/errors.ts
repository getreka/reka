/**
 * Custom Error Classes - Structured error handling
 */

/**
 * Base application error
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    retryable: boolean = false,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.details,
    };
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, false, details);
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404, false);
  }
}

/**
 * External service error (503) - retryable
 */
export class ExternalServiceError extends AppError {
  public readonly service: string;

  constructor(service: string, message: string, details?: Record<string, unknown>) {
    super(`${service}: ${message}`, 'EXTERNAL_SERVICE_ERROR', 503, true, details);
    this.service = service;
  }
}

/**
 * Rate limit error (429) - retryable
 */
export class RateLimitError extends AppError {
  public readonly retryAfter?: number;

  constructor(service: string, retryAfter?: number) {
    super(`${service} rate limit exceeded`, 'RATE_LIMIT', 429, true, { retryAfter });
    this.retryAfter = retryAfter;
  }
}

/**
 * Timeout error (504) - retryable
 */
export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`, 'TIMEOUT', 504, true);
  }
}

/**
 * Circuit breaker open error (503) - not immediately retryable
 */
export class CircuitOpenError extends AppError {
  constructor(service: string) {
    super(`${service} circuit breaker is open`, 'CIRCUIT_OPEN', 503, false);
  }
}

/**
 * Configuration error (500)
 */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR', 500, false);
  }
}

/**
 * Embedding error (502) — provider returned empty/invalid vector or input was invalid.
 * Not retryable: same input will produce the same failure.
 */
export class EmbeddingError extends AppError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super(`Embedding failed: ${reason}`, 'EMBEDDING_ERROR', 502, false, details);
  }
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }

  // Check for common network errors
  if (error instanceof Error) {
    const code = (error as any).code;
    const retryableCodes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
    ];
    if (code && retryableCodes.includes(code)) {
      return true;
    }

    // Check for HTTP status codes
    const status = (error as any).status || (error as any).response?.status;
    if (status && [429, 500, 502, 503, 504].includes(status)) {
      return true;
    }
  }

  return false;
}

/**
 * Wrap unknown error into AppError
 */
export function wrapError(error: unknown, defaultMessage: string = 'Unknown error'): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const code = (error as any).code;
    const status = (error as any).status || (error as any).response?.status;

    if (code === 'ECONNREFUSED') {
      return new ExternalServiceError('unknown', 'Connection refused');
    }
    if (code === 'ETIMEDOUT') {
      return new TimeoutError('operation', 0);
    }
    if (status === 429) {
      return new RateLimitError('unknown');
    }

    return new AppError(
      error.message || defaultMessage,
      'UNKNOWN_ERROR',
      status || 500,
      isRetryableError(error)
    );
  }

  return new AppError(defaultMessage, 'UNKNOWN_ERROR', 500, false);
}
