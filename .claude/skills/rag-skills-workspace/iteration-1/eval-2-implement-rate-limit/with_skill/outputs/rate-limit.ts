/**
 * Rate Limiting Middleware
 *
 * Limits requests per IP using an in-memory sliding window.
 * Configurable via RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS env vars.
 * Skips /health and /metrics endpoints.
 * Returns 429 with Retry-After header when limit is exceeded.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { logger } from '../utils/logger';

const SKIP_RATE_LIMIT_PATHS = ['/health', '/metrics'];

interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

/** In-memory store: IP -> request timestamps */
const store = new Map<string, RateLimitEntry>();

/** Interval handle for cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Extract client IP from request.
 * Respects X-Forwarded-For for reverse proxy setups.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // Take the first IP (client IP) from the chain
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Remove expired timestamps from an entry and return the count
 * of requests within the current window.
 */
function pruneAndCount(entry: RateLimitEntry, now: number, windowMs: number): number {
  const windowStart = now - windowMs;
  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
  return entry.timestamps.length;
}

/**
 * Start periodic cleanup of stale entries (every 60 seconds).
 * Prevents memory leaks from IPs that stop sending requests.
 */
export function startCleanup(windowMs: number): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const windowStart = now - windowMs;
    let cleaned = 0;

    for (const [ip, entry] of store.entries()) {
      // Remove all expired timestamps
      entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
      if (entry.timestamps.length === 0) {
        store.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Rate limit cleanup: removed ${cleaned} stale entries, ${store.size} remaining`);
    }
  }, 60_000);

  // Allow Node.js to exit even if interval is running
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Stop the cleanup interval (for testing).
 */
export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Clear all rate limit entries (for testing).
 */
export function resetStore(): void {
  store.clear();
}

/**
 * Get current store size (for monitoring/testing).
 */
export function getStoreSize(): number {
  return store.size;
}

/**
 * Rate limiting middleware.
 *
 * Uses a sliding window algorithm: tracks timestamps of each request per IP,
 * and counts how many fall within the configured window. If the count exceeds
 * the max, the request is rejected with 429.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting if disabled (max = 0)
  if (!config.RATE_LIMIT_MAX || config.RATE_LIMIT_MAX <= 0) {
    return next();
  }

  // Skip rate limiting for monitoring endpoints
  if (SKIP_RATE_LIMIT_PATHS.includes(req.path)) {
    return next();
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW_MS;
  const max = config.RATE_LIMIT_MAX;

  // Get or create entry for this IP
  let entry = store.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(ip, entry);
  }

  // Prune old timestamps and count current requests
  const currentCount = pruneAndCount(entry, now, windowMs);

  // Set rate limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit-headers)
  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, max - currentCount - 1));
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

  if (currentCount >= max) {
    // Calculate retry-after in seconds
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs = oldestInWindow ? oldestInWindow + windowMs - now : windowMs;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    res.setHeader('Retry-After', retryAfterSec);

    logger.warn(`Rate limit exceeded for IP ${ip}`, {
      ip,
      currentCount,
      max,
      windowMs,
      retryAfterSec,
      path: req.path,
      method: req.method,
    });

    res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMIT',
      details: {
        retryAfter: retryAfterSec,
        limit: max,
        windowMs,
      },
    });
    return;
  }

  // Record this request
  entry.timestamps.push(now);

  next();
}

// Start cleanup on module load
startCleanup(config.RATE_LIMIT_WINDOW_MS);
