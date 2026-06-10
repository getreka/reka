/**
 * Rate Limiting Middleware
 *
 * Limits requests to MAX_REQUESTS_PER_MINUTE per IP address using
 * a sliding window algorithm with in-memory storage.
 *
 * Features:
 * - Per-IP tracking with configurable limits
 * - Sliding window for smooth rate limiting (not bursty fixed windows)
 * - Standard rate limit headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset)
 * - Retry-After header on 429 responses
 * - Automatic cleanup of stale entries to prevent memory leaks
 * - Skips rate limiting for /health and /metrics endpoints
 * - Configurable via environment variables
 *
 * Location: rag-api/src/middleware/rate-limiter.ts
 */

import { Request, Response, NextFunction } from "express";
import config from "../config";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_REQUESTS = config.RATE_LIMIT_MAX ?? 100;
const WINDOW_MS = config.RATE_LIMIT_WINDOW_MS ?? 60_000; // 1 minute
const SKIP_PATHS = ["/health", "/metrics"];
const CLEANUP_INTERVAL_MS = 60_000; // Run cleanup every 60s

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ClientBucket {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

/** Per-IP buckets */
const clients = new Map<string, ClientBucket>();

// Periodic cleanup of stale entries to prevent unbounded memory growth
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    let removed = 0;

    for (const [ip, bucket] of clients.entries()) {
      // Remove expired timestamps
      bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
      // Remove the entry entirely if no recent requests
      if (bucket.timestamps.length === 0) {
        clients.delete(ip);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(
        `Rate limiter cleanup: removed ${removed} stale entries, ${clients.size} active`,
      );
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the Node process to exit even if the timer is still running
  cleanupTimer.unref();
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

function getClientIp(req: Request): string {
  // Trust X-Forwarded-For when behind a reverse proxy (nginx, docker)
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    // X-Forwarded-For can contain multiple IPs: client, proxy1, proxy2
    return forwarded.split(",")[0].trim();
  }

  // Fall back to remote address
  return req.socket.remoteAddress || req.ip || "127.0.0.1";
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that enforces per-IP rate limiting.
 *
 * Responds with 429 Too Many Requests when the limit is exceeded,
 * including standard rate limit headers on every response.
 */
export function rateLimiterMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Skip rate limiting for monitoring endpoints
  if (SKIP_PATHS.includes(req.path)) {
    return next();
  }

  // Skip if rate limiting is disabled (RATE_LIMIT_MAX=0)
  if (MAX_REQUESTS <= 0) {
    return next();
  }

  // Ensure cleanup is running
  startCleanup();

  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const clientIp = getClientIp(req);

  // Get or create bucket for this IP
  let bucket = clients.get(clientIp);
  if (!bucket) {
    bucket = { timestamps: [] };
    clients.set(clientIp, bucket);
  }

  // Prune timestamps outside the current sliding window
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

  // Calculate remaining requests
  const currentCount = bucket.timestamps.length;
  const remaining = Math.max(0, MAX_REQUESTS - currentCount);

  // Calculate when the window resets (oldest timestamp + window duration)
  const resetTime =
    bucket.timestamps.length > 0
      ? Math.ceil((bucket.timestamps[0] + WINDOW_MS) / 1000)
      : Math.ceil((now + WINDOW_MS) / 1000);

  // Set standard rate limit headers on every response
  res.setHeader("RateLimit-Limit", MAX_REQUESTS);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetTime);

  // Check if limit is exceeded
  if (currentCount >= MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil(
      (bucket.timestamps[0] + WINDOW_MS - now) / 1000,
    );

    res.setHeader("Retry-After", Math.max(1, retryAfterSeconds));

    logger.warn(`Rate limit exceeded for ${clientIp}`, {
      ip: clientIp,
      count: currentCount,
      limit: MAX_REQUESTS,
      retryAfter: retryAfterSeconds,
      path: req.path,
      method: req.method,
    });

    res.status(429).json({
      error: "Too many requests",
      code: "RATE_LIMIT",
      details: {
        limit: MAX_REQUESTS,
        windowMs: WINDOW_MS,
        retryAfter: Math.max(1, retryAfterSeconds),
      },
    });
    return;
  }

  // Record this request
  bucket.timestamps.push(now);

  next();
}

// ---------------------------------------------------------------------------
// Testing helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Reset all rate limit state (for testing only) */
export function _resetRateLimiter(): void {
  clients.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Get current client count (for monitoring/testing) */
export function _getActiveClients(): number {
  return clients.size;
}
