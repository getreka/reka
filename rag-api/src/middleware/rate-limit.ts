/**
 * Rate Limiting Middleware - Per-IP sliding window with tiered limits
 *
 * Tiers:
 * - default: 100 req/min (search, memory, health)
 * - llm: 20 req/min (ask, agent, review — expensive LLM calls)
 * - indexing: 5 req/min (index operations — very expensive)
 *
 * Uses in-memory Map with periodic cleanup. Redis-backed variant can be added later.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
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
const LLM_PATHS = ['/api/ask', '/api/agent', '/api/review', '/api/quality'];
const INDEXING_PATHS = ['/api/index'];
const SKIP_PATHS = ['/health', '/metrics', '/api/health'];

function getTier(path: string): string {
  if (LLM_PATHS.some((p) => path.startsWith(p))) return 'llm';
  if (INDEXING_PATHS.some((p) => path.startsWith(p))) return 'indexing';
  return 'default';
}

// Per-tier per-IP stores
const stores: Record<string, Map<string, WindowEntry>> = {
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

function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip rate limiting for monitoring endpoints
  if (SKIP_PATHS.includes(req.path)) {
    return next();
  }

  // Batch ingest bypass: skip rate limiting for memory batch endpoint from localhost
  if (req.path === '/api/memory/batch') {
    return next();
  }

  const tier = getTier(req.path);
  const tierConfig = TIERS[tier];
  const store = stores[tier];
  const ip = getClientIp(req);
  const key = `${ip}`;
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
