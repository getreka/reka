/**
 * API Key Authentication Middleware (Self-Hosted)
 *
 * Self-hosted mode: auth is optional. If no API_KEY is set, all requests pass through.
 * If API_KEY is set, it protects the API (useful when exposing to a network).
 *
 * Supports:
 * - Single key via API_KEY env var
 * - Multi-key via API_KEYS env var (comma-separated, format: name:key or just key)
 * - Both "Authorization: Bearer <key>" and "X-API-Key: <key>" headers
 *
 * Skips auth for /health, /metrics, and /api/health endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { timingSafeEqual } from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';

// Extend Express Request with auth context
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

export interface AuthContext {
  keyName: string;
  authenticated: boolean;
}

interface StoredKey {
  name: string;
  hash: string;
  raw: string; // kept in memory for timing-safe comparison
}

const SKIP_AUTH_PATHS = ['/health', '/metrics', '/api/health'];

// Parse keys on startup
const keys: StoredKey[] = [];

function initKeys() {
  // Legacy single key
  if (config.API_KEY) {
    keys.push({
      name: 'default',
      hash: hashKey(config.API_KEY),
      raw: config.API_KEY,
    });
  }

  // Multi-key: API_KEYS=admin:rk_abc123,ci:rk_def456,rk_plain789
  const multiKeys = process.env.API_KEYS;
  if (multiKeys) {
    for (const entry of multiKeys.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const name = trimmed.slice(0, colonIdx);
        const key = trimmed.slice(colonIdx + 1);
        keys.push({ name, hash: hashKey(key), raw: key });
      } else {
        keys.push({ name: `key-${keys.length}`, hash: hashKey(trimmed), raw: trimmed });
      }
    }
  }

  if (keys.length > 0) {
    logger.info(
      `Auth initialized with ${keys.length} API key(s): ${keys.map((k) => k.name).join(', ')}`
    );
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractApiKey(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    return xApiKey;
  }

  return undefined;
}

function findMatchingKey(provided: string): StoredKey | undefined {
  for (const stored of keys) {
    if (safeCompare(provided, stored.raw)) {
      return stored;
    }
  }
  return undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth if no keys configured (local dev)
  if (keys.length === 0) {
    req.authContext = { keyName: 'anonymous', authenticated: false };
    return next();
  }

  // Skip auth for monitoring endpoints
  if (SKIP_AUTH_PATHS.includes(req.path)) {
    return next();
  }

  const providedKey = extractApiKey(req);

  if (!providedKey) {
    logger.warn(`Auth failed: no API key provided for ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  }

  const matched = findMatchingKey(providedKey);
  if (!matched) {
    logger.warn(`Auth failed: invalid API key for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Forbidden', code: 'INVALID_API_KEY' });
  }

  req.authContext = { keyName: matched.name, authenticated: true };
  next();
}

/**
 * Re-initialize keys from config. Called on import and can be called
 * in tests after modifying config.API_KEY.
 */
export function resetKeys(): void {
  keys.length = 0;
  initKeys();
}

// Initialize on import
resetKeys();
