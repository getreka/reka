/**
 * Rate Limiting Middleware - sliding window with tiered limits
 *
 * Tiers:
 * - auth: 10 req/min (login, signup, waitlist — pre-auth, brute-force surface)
 * - default: 100 req/min (search, memory, health)
 * - llm: 20 req/min (ask, agent, review — expensive LLM calls)
 * - indexing: 5 req/min (index operations — very expensive)
 *
 * Keyed by API key when present (so a single client can't multiply its quota by
 * rotating source IPs), falling back to the trusted client IP for public/unauthenticated
 * traffic. The client IP comes from `req.ip`, which honours Express `trust proxy`
 * (configured in server.ts) — never the raw, client-spoofable X-Forwarded-For header.
 *
 * Uses in-memory Map with periodic cleanup. Redis-backed variant can be added later.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

interface WindowEntry {
  timestamps: number[];
}

// Tier configuration
interface RateLimitTier {
  maxRequests: number;
  windowMs: number;
}

const TIERS: Record<string, RateLimitTier> = {
  auth: {
    maxRequests: parseInt(process.env.RATE_LIMIT_AUTH || '10', 10),
    windowMs: 60_000,
  },
  default: {
    maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '100', 10),
    windowMs: 60_000,
  },
  llm: {
    maxRequests: parseInt(process.env.RATE_LIMIT_LLM || '20', 10),
    windowMs: 60_000,
  },
  indexing: {
    maxRequests: parseInt(process.env.RATE_LIMIT_INDEXING || '5', 10),
    windowMs: 60_000,
  },
};

// Path-to-tier mapping
const AUTH_PATHS = ['/api/auth', '/api/waitlist'];
const LLM_PATHS = ['/api/ask', '/api/agent', '/api/review', '/api/quality'];
const INDEXING_PATHS = ['/api/index'];
const SKIP_PATHS = ['/health', '/metrics', '/api/health'];

function getTier(path: string): string {
  if (AUTH_PATHS.some((p) => path.startsWith(p))) return 'auth';
  if (LLM_PATHS.some((p) => path.startsWith(p))) return 'llm';
  if (INDEXING_PATHS.some((p) => path.startsWith(p))) return 'indexing';
  return 'default';
}

// Per-tier stores (keyed by API key or trusted client IP)
const stores: Record<string, Map<string, WindowEntry>> = {
  auth: new Map(),
  default: new Map(),
  llm: new Map(),
  indexing: new Map(),
};

// Periodic cleanup (every 60s)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [tierName, store] of Object.entries(stores)) {
    const tier = TIERS[tierName];
    for (const [key, entry] of store.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < tier.windowMs);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }
}, 60_000);
cleanupInterval.unref();

/**
 * Trusted client IP. Relies on Express `trust proxy` (set in server.ts) so `req.ip`
 * reflects the real client when behind a known proxy and the direct socket address
 * otherwise — the raw X-Forwarded-For header is never read directly (it is
 * client-spoofable and was the previous bypass vector).
 */
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Rate-limit bucket key: prefer the API key (so rotating source IPs can't multiply a
 * single client's quota), falling back to the trusted client IP for unauthenticated
 * traffic. Only a short hash of the key is stored, never the key itself.
 */
function getRateLimitKey(req: Request): string {
  const authHeader = req.headers['authorization'];
  let apiKey: string | undefined;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (typeof req.headers['x-api-key'] === 'string') {
    apiKey = req.headers['x-api-key'] as string;
  }
  if (apiKey) {
    return `key:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  }
  return `ip:${getClientIp(req)}`;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip rate limiting for monitoring endpoints
  if (SKIP_PATHS.includes(req.path)) {
    return next();
  }

  // Batch ingest bypass: only for genuinely local callers. Uses the raw socket address
  // (not req.ip, which is X-Forwarded-For-derived under trust proxy and client-spoofable),
  // so a remote client cannot claim to be local to skip the limit.
  if (req.path === '/api/memory/batch' && isLoopback(req.socket.remoteAddress || '')) {
    return next();
  }

  const tier = getTier(req.path);
  const tierConfig = TIERS[tier];
  const store = stores[tier];
  const key = getRateLimitKey(req);
  const ip = getClientIp(req);
  const now = Date.now();

  // Get or create entry
  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Prune expired timestamps (binary search for efficiency)
  const cutoff = now - tierConfig.windowMs;
  let lo = 0;
  let hi = entry.timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entry.timestamps[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    entry.timestamps = entry.timestamps.slice(lo);
  }

  // Check limit
  if (entry.timestamps.length >= tierConfig.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfter = Math.ceil((oldestInWindow + tierConfig.windowMs - now) / 1000);

    logger.warn(`Rate limit exceeded`, {
      ip,
      tier,
      count: entry.timestamps.length,
      path: req.path,
    });

    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Limit', String(tierConfig.maxRequests));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset', String(Math.ceil((oldestInWindow + tierConfig.windowMs) / 1000)));

    return res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMIT',
      tier,
      retryAfter,
    });
  }

  // Record request
  entry.timestamps.push(now);

  // Set rate limit headers
  res.set('X-RateLimit-Limit', String(tierConfig.maxRequests));
  res.set('X-RateLimit-Remaining', String(tierConfig.maxRequests - entry.timestamps.length));

  next();
}
