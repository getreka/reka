/**
 * API Key Authentication Middleware
 *
 * Key → Project resolution:
 * - Each API key maps to exactly one project
 * - Keys stored in data/keys.json (self-hosted) or Redis (cloud)
 * - If no keys exist, falls back to X-Project-Name header (backward compat)
 *
 * Key format: rk_{projectName}_{24 hex chars}
 * Example:    rk_myapp_a3f8b2c1d4e5f6a7b8c9d0e1
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

export interface AuthContext {
  keyName: string;
  projectName: string;
  authenticated: boolean;
}

export interface StoredApiKey {
  id: string;
  key: string; // full key (only stored locally for self-hosted)
  keyHash: string;
  projectName: string;
  createdAt: string;
  label?: string;
}

const SKIP_AUTH_PATHS = ['/health', '/metrics', '/api/health'];
const KEYS_FILE = path.join(process.cwd(), 'data', 'keys.json');

let keyStore: StoredApiKey[] = [];

function loadKeys(): void {
  keyStore = [];

  // Load from keys.json (self-hosted)
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
      keyStore = Array.isArray(data) ? data : [];
      logger.info(`Loaded ${keyStore.length} API key(s) from ${KEYS_FILE}`);
    }
  } catch (err: any) {
    logger.warn(`Failed to load keys file: ${err.message}`);
  }

  // Also support legacy API_KEY env (maps to X-Project-Name header)
  if (config.API_KEY && !keyStore.some((k) => k.key === config.API_KEY)) {
    keyStore.push({
      id: 'legacy',
      key: config.API_KEY,
      keyHash: hashKey(config.API_KEY),
      projectName: '', // resolved from header
      createdAt: new Date().toISOString(),
      label: 'legacy-env',
    });
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

function findMatchingKey(provided: string): StoredApiKey | undefined {
  for (const stored of keyStore) {
    if (safeCompare(provided, stored.key)) {
      return stored;
    }
  }
  return undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth for monitoring endpoints
  if (SKIP_AUTH_PATHS.includes(req.path)) {
    return next();
  }

  // No keys configured — open access, project from header
  if (keyStore.length === 0) {
    const projectName = (req.headers['x-project-name'] as string) || 'default';
    req.authContext = { keyName: 'anonymous', projectName, authenticated: false };
    return next();
  }

  const providedKey = extractApiKey(req);

  if (!providedKey) {
    logger.warn(`Auth failed: no API key for ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  }

  const matched = findMatchingKey(providedKey);
  if (!matched) {
    logger.warn(`Auth failed: invalid API key for ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Forbidden', code: 'INVALID_API_KEY' });
  }

  // Resolve project: from key mapping, or fallback to header (legacy keys)
  const projectName =
    matched.projectName ||
    (req.headers['x-project-name'] as string) ||
    'default';

  req.authContext = {
    keyName: matched.label || matched.id,
    projectName,
    authenticated: true,
  };

  // Inject project name into headers for downstream middleware
  req.headers['x-project-name'] = projectName;

  next();
}

// --- Key Management (self-hosted) ---

export function generateKey(projectName: string, label?: string): StoredApiKey {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(12).toString('hex');
  const key = `rk_${projectName}_${secret}`;

  const entry: StoredApiKey = {
    id,
    key,
    keyHash: hashKey(key),
    projectName,
    createdAt: new Date().toISOString(),
    label,
  };

  keyStore.push(entry);
  saveKeys();

  return entry;
}

export function listKeys(): Array<Omit<StoredApiKey, 'key'> & { keyPrefix: string }> {
  return keyStore
    .filter((k) => k.id !== 'legacy')
    .map(({ key, ...rest }) => ({
      ...rest,
      keyPrefix: key.slice(0, 20) + '...',
    }));
}

export function revokeKey(id: string): boolean {
  const idx = keyStore.findIndex((k) => k.id === id);
  if (idx === -1) return false;
  keyStore.splice(idx, 1);
  saveKeys();
  return true;
}

function saveKeys(): void {
  const dir = path.dirname(KEYS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = keyStore.filter((k) => k.id !== 'legacy');
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

export function resetKeys(): void {
  keyStore = [];
  loadKeys();
}

// Initialize on import
resetKeys();
