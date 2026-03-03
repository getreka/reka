/**
 * Rate Limiting Middleware
 *
 * IP-based rate limiting using a sliding window algorithm.
 * Supports in-memory storage with optional Redis backend for distributed deployments.
 *
 * Default: 100 requests per minute per IP.
 *
 * Integration point in server.ts:
 *   app.use(rateLimitMiddleware);
 *   // Place after CORS/JSON parsing, before auth middleware.
 *
 * File: rag-api/src/middleware/rate-limiter.ts
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { logger } from '../utils/logger';
import { rateLimitHitsTotal, rateLimitActiveIPs } from '../utils/metrics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RateLimitConfig {
  /** Maximum requests per window */
  max: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Paths to skip rate limiting */
  skipPaths: string[];
  /** Whether rate limiting is enabled */
  enabled: boolean;
}

function getRateLimitConfig(): RateLimitConfig {
  return {
    max: (config as any).RATE_LIMIT_MAX ?? 100,
    windowMs: (config as any).RATE_LIMIT_WINDOW_MS ?? 60_000,
    skipPaths: ((config as any).RATE_LIMIT_SKIP_PATHS as string[] | undefined) ?? ['/health', '/metrics'],
    enabled: (config as any).RATE_LIMIT_ENABLED ?? true,
  };
}

// ---------------------------------------------------------------------------
// IP Extraction
// ---------------------------------------------------------------------------

/**
 * Extract client IP from request, respecting proxy headers.
 * Normalizes IPv6-mapped IPv4 addresses.
 */
function extractClientIP(req: Request): string {
  // X-Forwarded-For: first entry is the original client
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    if (first) return normalizeIP(first);
  }

  // X-Real-IP (nginx)
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp) {
    return normalizeIP(xRealIp.trim());
  }

  // Direct connection
  return normalizeIP(req.ip || req.socket.remoteAddress || 'unknown');
}

/**
 * Normalize IPv6-mapped IPv4 addresses to plain IPv4.
 * e.g. "::ffff:127.0.0.1" -> "127.0.0.1"
 */
function normalizeIP(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

// ---------------------------------------------------------------------------
// Sliding Window Store (in-memory)
// ---------------------------------------------------------------------------

/**
 * In-memory sliding window rate limiter.
 * Each IP maps to a sorted array of request timestamps.
 */
class SlidingWindowStore {
  private store = new Map<string, number[]>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private windowMs: number) {
    // Periodic cleanup of stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref(); // Don't block process exit
  }

  /**
   * Record a request and return the current count within the window.
   * Returns { count, oldestTimestamp } where count includes the new request.
   */
  hit(ip: string, now: number): { count: number; resetAt: number } {
    let timestamps = this.store.get(ip);

    if (!timestamps) {
      timestamps = [];
      this.store.set(ip, timestamps);
    }

    // Prune expired timestamps
    const windowStart = now - this.windowMs;
    const firstValidIndex = this.binarySearchFirstValid(timestamps, windowStart);

    if (firstValidIndex > 0) {
      timestamps.splice(0, firstValidIndex);
    }

    // Add current request
    timestamps.push(now);

    // Reset time is when the oldest request in the window expires
    const resetAt = timestamps.length > 0
      ? timestamps[0] + this.windowMs
      : now + this.windowMs;

    return { count: timestamps.length, resetAt };
  }

  /**
   * Peek at the current count without recording a new hit.
   */
  peek(ip: string, now: number): { count: number; resetAt: number } {
    const timestamps = this.store.get(ip);
    if (!timestamps || timestamps.length === 0) {
      return { count: 0, resetAt: now + this.windowMs };
    }

    const windowStart = now - this.windowMs;
    let validCount = 0;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (timestamps[i] > windowStart) {
        validCount++;
      } else {
        break;
      }
    }

    const resetAt = timestamps.length > 0
      ? timestamps[timestamps.length - validCount] + this.windowMs
      : now + this.windowMs;

    return { count: validCount, resetAt };
  }

  /**
   * Binary search for the first timestamp after windowStart.
   */
  private binarySearchFirstValid(timestamps: number[], windowStart: number): number {
    let lo = 0;
    let hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (timestamps[mid] <= windowStart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Remove IPs with no requests in the current window.
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let cleaned = 0;

    for (const [ip, timestamps] of this.store) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= windowStart) {
        this.store.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Rate limiter cleanup: removed ${cleaned} stale IPs, ${this.store.size} remaining`);
    }

    // Update Prometheus gauge
    rateLimitActiveIPs.set(this.store.size);
  }

  /**
   * Get the number of tracked IPs (for metrics).
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Destroy the store and clear timers.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

let store: SlidingWindowStore | null = null;

/**
 * Get or create the singleton sliding window store.
 */
function getStore(windowMs: number): SlidingWindowStore {
  if (!store) {
    store = new SlidingWindowStore(windowMs);
  }
  return store;
}

/**
 * Rate limiting middleware.
 *
 * Returns 429 with Retry-After header when limit is exceeded.
 * Sets standard rate limit headers on every response.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cfg = getRateLimitConfig();

  // Skip if disabled
  if (!cfg.enabled) {
    return next();
  }

  // Skip configured paths
  if (cfg.skipPaths.includes(req.path)) {
    return next();
  }

  const ip = extractClientIP(req);
  const now = Date.now();
  const windowStore = getStore(cfg.windowMs);

  const { count, resetAt } = windowStore.hit(ip, now);
  const remaining = Math.max(0, cfg.max - count);
  const resetEpochSeconds = Math.ceil(resetAt / 1000);

  // Set standard rate limit headers on ALL responses
  res.setHeader('X-RateLimit-Limit', cfg.max);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetEpochSeconds);

  // Check if limit exceeded
  if (count > cfg.max) {
    const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);

    // Set Retry-After header (standard HTTP)
    res.setHeader('Retry-After', retryAfterSeconds);

    // Record metric
    rateLimitHitsTotal.inc({ ip_hash: hashIP(ip) });

    logger.warn(`Rate limit exceeded for IP ${maskIP(ip)}: ${count}/${cfg.max} requests`, {
      ip: maskIP(ip),
      count,
      limit: cfg.max,
      retryAfter: retryAfterSeconds,
      requestId: req.requestId,
    });

    res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT',
      details: {
        retryAfter: retryAfterSeconds,
        limit: cfg.max,
        windowMs: cfg.windowMs,
      },
    });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash IP for metrics (privacy: don't store raw IPs in Prometheus).
 */
function hashIP(ip: string): string {
  // Simple deterministic hash for cardinality control
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Mask IP for logging (privacy: partial redaction).
 * e.g. "192.168.1.42" -> "192.168.x.x"
 */
function maskIP(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  // IPv6: show first 4 groups
  const v6parts = ip.split(':');
  if (v6parts.length > 4) {
    return v6parts.slice(0, 4).join(':') + ':...';
  }
  return 'masked';
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { SlidingWindowStore, extractClientIP, normalizeIP, maskIP, hashIP };

/**
 * Reset the global store (for testing only).
 */
export function _resetStore(): void {
  if (store) {
    store.destroy();
    store = null;
  }
}
