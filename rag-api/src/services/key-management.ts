/**
 * API Key Management Service
 *
 * Manages rk_* format API keys with org/project scoping.
 * Stores only SHA-256 hashes — raw key shown once at creation.
 *
 * Key format: rk_live_<tier>_<32 hex chars>
 * Example:    rk_live_team_a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5
 */

import { randomBytes, createHash } from 'crypto';
import { cacheService } from './cache';
import { logger } from '../utils/logger';
import type { Tier } from '../middleware/feature-gate';

export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;      // First 16 chars for identification
  keyHash: string;         // SHA-256 hash
  name: string;            // User-provided label
  orgId: string;
  tier: Tier;
  type: 'personal' | 'team_service' | 'cicd';
  allowedProjects?: string[];
  permissions: Permission[];
  rateLimit: number;       // req/min
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export type Permission = 'search' | 'index' | 'memory:read' | 'memory:write' | 'admin';

const RATE_LIMITS: Record<Tier, number> = {
  community: 60,
  starter: 60,
  team: 120,
  enterprise: 600,
};

// In-memory store (would be Postgres in production)
// Keys stored in Redis for fast lookup
const KEY_STORE_PREFIX = 'reka:keys:';
const KEY_HASH_INDEX = 'reka:key-hashes:';

function generateKeyId(): string {
  return randomBytes(8).toString('hex');
}

function generateRawKey(tier: Tier): string {
  const random = randomBytes(16).toString('hex');
  return `rk_live_${tier}_${random}`;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class KeyManagementService {
  /**
   * Create a new API key. Returns the raw key (shown once).
   */
  async createKey(params: {
    name: string;
    orgId: string;
    tier: Tier;
    type: ApiKeyRecord['type'];
    allowedProjects?: string[];
    permissions?: Permission[];
    expiresAt?: string;
  }): Promise<{ rawKey: string; record: ApiKeyRecord }> {
    const rawKey = generateRawKey(params.tier);
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 16);
    const id = generateKeyId();

    const record: ApiKeyRecord = {
      id,
      keyPrefix,
      keyHash,
      name: params.name,
      orgId: params.orgId,
      tier: params.tier,
      type: params.type,
      allowedProjects: params.allowedProjects,
      permissions: params.permissions || ['search', 'index', 'memory:read', 'memory:write'],
      rateLimit: RATE_LIMITS[params.tier],
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
    };

    // Store record by ID
    await cacheService.set<string>(
      `${KEY_STORE_PREFIX}${id}`,
      JSON.stringify(record),
      86400 * 365 // 1 year TTL
    );

    // Store hash → ID mapping for auth lookup
    await cacheService.set<string>(
      `${KEY_HASH_INDEX}${keyHash}`,
      id,
      86400 * 365
    );

    logger.info(`API key created: ${keyPrefix}... for org ${params.orgId} (${params.tier})`);

    return { rawKey, record };
  }

  /**
   * Validate a raw API key. Returns the key record if valid.
   */
  async validateKey(rawKey: string): Promise<ApiKeyRecord | null> {
    const keyHash = hashKey(rawKey);
    const keyId = await cacheService.get<string>(`${KEY_HASH_INDEX}${keyHash}`);
    if (!keyId) return null;

    const recordJson = await cacheService.get<string>(`${KEY_STORE_PREFIX}${keyId}`);
    if (!recordJson) return null;

    const record: ApiKeyRecord = JSON.parse(recordJson);

    // Check if revoked
    if (record.revokedAt) return null;

    // Check if expired
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;

    // Update last used (async, non-blocking)
    record.lastUsedAt = new Date().toISOString();
    cacheService.set<string>(
      `${KEY_STORE_PREFIX}${keyId}`,
      JSON.stringify(record),
      86400 * 365
    ).catch(() => {});

    return record;
  }

  /**
   * List keys for an org.
   */
  async listKeys(orgId: string): Promise<Omit<ApiKeyRecord, 'keyHash'>[]> {
    // In production this would be a Postgres query.
    // For now, scan Redis (acceptable for small key counts).
    const keys = await cacheService.scanKeys(`${KEY_STORE_PREFIX}*`);
    const results: Omit<ApiKeyRecord, 'keyHash'>[] = [];

    for (const key of keys) {
      const json = await cacheService.get<string>(key);
      if (!json) continue;
      const record: ApiKeyRecord = JSON.parse(json);
      if (record.orgId === orgId && !record.revokedAt) {
        const { keyHash, ...safe } = record;
        results.push(safe);
      }
    }

    return results;
  }

  /**
   * Revoke a key.
   */
  async revokeKey(keyId: string, reason?: string): Promise<boolean> {
    const json = await cacheService.get<string>(`${KEY_STORE_PREFIX}${keyId}`);
    if (!json) return false;

    const record: ApiKeyRecord = JSON.parse(json);
    record.revokedAt = new Date().toISOString();

    await cacheService.set<string>(
      `${KEY_STORE_PREFIX}${keyId}`,
      JSON.stringify(record),
      86400 * 30 // Keep revoked records for 30 days
    );

    // Remove hash index (key can no longer auth)
    await cacheService.del(`${KEY_HASH_INDEX}${record.keyHash}`);

    logger.info(`API key revoked: ${record.keyPrefix}... (${reason || 'no reason'})`);
    return true;
  }
}

export const keyManagement = new KeyManagementService();
