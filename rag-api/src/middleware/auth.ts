/**
 * API Key Authentication Middleware
 *
 * Validates requests against API_KEY from config.
 * Supports both "Authorization: Bearer <key>" and "X-API-Key: <key>" headers.
 * Skips auth for /health, /metrics, and /api/health endpoints, and when API_KEY is not configured.
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';

const SKIP_AUTH_PATHS = ['/health', '/metrics', '/api/health'];

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractApiKey(req: Request): string | undefined {
  // Check Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check X-API-Key header
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    return xApiKey;
  }

  return undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth if no API_KEY configured (local dev)
  if (!config.API_KEY) {
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

  if (!safeCompare(providedKey, config.API_KEY)) {
    logger.warn(`Auth failed: invalid API key for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Forbidden', code: 'INVALID_API_KEY' });
  }

  next();
}
