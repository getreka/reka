/**
 * Rate Limiting Middleware
 *
 * Enforces per-IP request rate limits using an in-memory sliding window algorithm.
 * Default: 100 requests per minute per IP. Configurable via environment variables.
 *
 * Skips /health and /metrics endpoints (same pattern as auth middleware).
 * Sets standard rate limit headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset.
 * Returns 429 with Retry-After header when limit is exceeded.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { logger } from '../utils/logger';
import { rateLimitedRequestsTotal } from '../utils/metrics';

const SKIP_RATE_LIMIT_PATHS = ['/health', '/metrics'];

/** Timestamps of requests per IP */
const ipRequestMap = new Map<string, number[]>();

/** Interval handle for periodic cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Extract client IP from request, respecting X-Forwarded-For behind proxies.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // Take the first IP in the chain (original client)
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Remove expired request timestamps from the sliding window.
 * Called on every request for the specific IP, and periodically for all IPs.
 */
function pruneExpiredEntries(timestamps: number[], windowStart: number): number[] {
  // Binary search for the first timestamp within the window
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < windowStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Return only timestamps within the window
  return lo > 0 ? timestamps.slice(lo) : timestamps;
}

/**
 * Periodic cleanup of expired IP entries to prevent memory leaks.
 * Runs every 60 seconds by default.
 */
function startCleanupTimer(): void {
  if (cleanupInterval) return;

  const CLEANUP_INTERVAL_MS = 60_000;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const windowStart = now - config.RATE_LIMIT_WINDOW_MS;
    let cleaned = 0;

    for (const [ip, timestamps] of ipRequestMap.entries()) {
      const pruned = pruneExpiredEntries(timestamps, windowStart);
      if (pruned.length === 0) {
        ipRequestMap.delete(ip);
        cleaned++;
      } else if (pruned.length !== timestamps.length) {
        ipRequestMap.set(ip, pruned);
      }
    }

    if (cleaned > 0) {
      logger.debug(`Rate limiter cleanup: removed ${cleaned} expired IP entries, ${ipRequestMap.size} remaining`);
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't prevent process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Rate limiting middleware.
 *
 * Uses a sliding window algorithm: tracks request timestamps per IP
 * within the configured window (default 60s). If the count exceeds
 * the limit (default 100), returns 429 Too Many Requests.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting if disabled (limit = 0)
  if (config.RATE_LIMIT_MAX <= 0) {
    return next();
  }

  // Skip rate limiting for monitoring endpoints
  if (SKIP_RATE_LIMIT_PATHS.includes(req.path)) {
    return next();
  }

  // Start cleanup timer on first request
  startCleanupTimer();

  const now = Date.now();
  const windowStart = now - config.RATE_LIMIT_WINDOW_MS;
  const clientIp = getClientIp(req);

  // Get or create timestamps array for this IP
  let timestamps = ipRequestMap.get(clientIp) || [];

  // Prune expired entries
  timestamps = pruneExpiredEntries(timestamps, windowStart);

  // Calculate remaining requests
  const currentCount = timestamps.length;
  const remaining = Math.max(0, config.RATE_LIMIT_MAX - currentCount - 1);

  // Calculate reset time (end of current window from oldest request, or from now)
  const windowResetMs = timestamps.length > 0
    ? timestamps[0] + config.RATE_LIMIT_WINDOW_MS
    : now + config.RATE_LIMIT_WINDOW_MS;
  const resetEpochSeconds = Math.ceil(windowResetMs / 1000);

  // Set rate limit headers on every response
  res.setHeader('X-RateLimit-Limit', config.RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
  res.setHeader('X-RateLimit-Reset', resetEpochSeconds);

  // Check if limit exceeded
  if (currentCount >= config.RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.ceil((windowResetMs - now) / 1000);

    // Record metric
    const projectName = (req.headers['x-project-name'] as string) || 'unknown';
    rateLimitedRequestsTotal.inc({ ip: clientIp, project: projectName });

    logger.warn(`Rate limit exceeded for IP ${clientIp}: ${currentCount}/${config.RATE_LIMIT_MAX} requests in window`, {
      ip: clientIp,
      count: currentCount,
      limit: config.RATE_LIMIT_MAX,
      path: req.path,
    });

    res.setHeader('Retry-After', retryAfterSeconds);
    res.setHeader('X-RateLimit-Remaining', 0);

    res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMIT',
      retryAfter: retryAfterSeconds,
    });
    return;
  }

  // Record this request timestamp
  timestamps.push(now);
  ipRequestMap.set(clientIp, timestamps);

  next();
}

/**
 * Get current rate limit status for an IP (useful for testing and diagnostics).
 */
export function getRateLimitStatus(ip: string): {
  requestCount: number;
  limit: number;
  remaining: number;
  windowMs: number;
} {
  const now = Date.now();
  const windowStart = now - config.RATE_LIMIT_WINDOW_MS;
  const timestamps = ipRequestMap.get(ip) || [];
  const active = pruneExpiredEntries(timestamps, windowStart);
  return {
    requestCount: active.length,
    limit: config.RATE_LIMIT_MAX,
    remaining: Math.max(0, config.RATE_LIMIT_MAX - active.length),
    windowMs: config.RATE_LIMIT_WINDOW_MS,
  };
}

/**
 * Reset rate limit state (for testing).
 */
export function resetRateLimitState(): void {
  ipRequestMap.clear();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
