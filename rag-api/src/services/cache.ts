/**
 * Cache Service - Redis caching with session-aware multi-level strategy
 *
 * Features:
 * - L1: Session cache (short TTL, current work context)
 * - L2: Project cache (medium TTL, project-specific patterns)
 * - L3: Cross-project cache (long TTL, common patterns)
 * - Cache warming on session start
 * - Hit rate analytics per session
 */

import Redis from 'ioredis';
import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';

// TTL values in seconds - multi-level strategy
const TTL = {
  // Session-level (L1) - hot cache
  SESSION_EMBEDDING: 1800,      // 30 minutes
  SESSION_SEARCH: 1800,         // 30 minutes

  // Project-level (L2) - warm cache
  EMBEDDING: 3600,              // 1 hour
  SEARCH: 1800,                 // 30 minutes
  COLLECTION_INFO: 30,          // 30 seconds
  CONFLUENCE_PAGE: 3600,        // 1 hour

  // Cross-project (L3) - cold cache
  GLOBAL_EMBEDDING: 86400,      // 24 hours
};

// Cache key prefixes
const PREFIX = {
  SESSION: 'sess',
  PROJECT: 'proj',
  GLOBAL: 'glob',
  EMBEDDING: 'emb',
  SEARCH: 'search',
  STATS: 'stats',
};

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  l1Hits: number;
  l2Hits: number;
  l3Hits: number;
}

export interface SessionCacheOptions {
  sessionId: string;
  projectName: string;
}

class CacheService {
  private client: Redis | null = null;
  private enabled: boolean = false;

  async initialize(): Promise<void> {
    if (!config.REDIS_URL) {
      logger.info('Cache disabled: REDIS_URL not configured');
      return;
    }

    try {
      this.client = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number): number | null => {
          if (times > 3) {
            logger.warn('Redis connection failed, cache disabled');
            return null;
          }
          return Math.min(times * 200, 1000);
        },
        lazyConnect: true,
      });

      await this.client.connect();
      this.enabled = true;
      logger.info('Cache initialized', { url: config.REDIS_URL.replace(/\/\/.*@/, '//***@') });
    } catch (error) {
      logger.warn('Failed to connect to Redis, cache disabled', { error });
      this.client = null;
      this.enabled = false;
    }
  }

  /**
   * Check if cache is available
   */
  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Get raw Redis client for services that need native operations (Streams, Hashes, etc.)
   * Returns null if Redis is not available.
   */
  getClient(): Redis | null {
    return this.isEnabled() ? this.client : null;
  }

  /**
   * Generate a hash key for caching
   */
  private hash(data: string): string {
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isEnabled()) return null;

    try {
      const value = await this.client!.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      logger.debug('Cache get failed', { key, error });
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client!.setex(key, ttlSeconds, serialized);
      } else {
        await this.client!.set(key, serialized);
      }
    } catch (error) {
      logger.debug('Cache set failed', { key, error });
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      await this.client!.del(key);
    } catch (error) {
      logger.debug('Cache delete failed', { key, error });
    }
  }

  /**
   * Delete all keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const keys = await this.client!.keys(pattern);
      if (keys.length > 0) {
        await this.client!.del(...keys);
      }
    } catch (error) {
      logger.debug('Cache delete pattern failed', { pattern, error });
    }
  }

  /**
   * Atomic increment (for metering counters)
   */
  async increment(key: string, amount: number = 1): Promise<number> {
    if (!this.isEnabled()) return 0;

    try {
      if (amount === 1) {
        return await this.client!.incr(key);
      }
      return await this.client!.incrby(key, Math.round(amount));
    } catch (error) {
      logger.debug('Cache increment failed', { key, error });
      return 0;
    }
  }

  /**
   * Alias for delete (used by key management)
   */
  async del(key: string): Promise<void> {
    return this.delete(key);
  }

  /**
   * Scan keys matching a pattern (safe for large keyspaces)
   */
  async scanKeys(pattern: string, count: number = 100): Promise<string[]> {
    if (!this.isEnabled()) return [];

    const results: string[] = [];
    try {
      let cursor = '0';
      do {
        const [newCursor, keys] = await this.client!.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        cursor = newCursor;
        results.push(...keys);
      } while (cursor !== '0' && results.length < 1000);
    } catch (error) {
      logger.debug('Cache scan failed', { pattern, error });
    }
    return results;
  }

  /**
   * Get or set with callback
   */
  async getOrSet<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fn();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  // ============================================
  // Embedding Cache
  // ============================================

  /**
   * Get cached embedding
   */
  async getEmbedding(text: string): Promise<number[] | null> {
    const key = `emb:${this.hash(text)}`;
    return this.get<number[]>(key);
  }

  /**
   * Cache embedding
   */
  async setEmbedding(text: string, embedding: number[]): Promise<void> {
    const key = `emb:${this.hash(text)}`;
    await this.set(key, embedding, TTL.EMBEDDING);
  }

  /**
   * Get or compute embedding
   */
  async getOrSetEmbedding(
    text: string,
    compute: () => Promise<number[]>
  ): Promise<number[]> {
    const key = `emb:${this.hash(text)}`;
    return this.getOrSet(key, compute, TTL.EMBEDDING);
  }

  // ============================================
  // Search Cache
  // ============================================

  /**
   * Get cached search results
   */
  async getSearchResults<T>(
    collection: string,
    query: string,
    filters?: Record<string, unknown>
  ): Promise<T | null> {
    const filterStr = filters ? JSON.stringify(filters) : '';
    const key = `search:${collection}:${this.hash(query + filterStr)}`;
    return this.get<T>(key);
  }

  /**
   * Cache search results
   */
  async setSearchResults<T>(
    collection: string,
    query: string,
    results: T,
    filters?: Record<string, unknown>
  ): Promise<void> {
    const filterStr = filters ? JSON.stringify(filters) : '';
    const key = `search:${collection}:${this.hash(query + filterStr)}`;
    await this.set(key, results, TTL.SEARCH);
  }

  /**
   * Invalidate search cache for a collection
   */
  async invalidateCollection(collection: string): Promise<void> {
    await this.deletePattern(`search:${collection}:*`);
    await this.deletePattern(`colinfo:${collection}`);
  }

  // ============================================
  // Collection Info Cache
  // ============================================

  /**
   * Get cached collection info
   */
  async getCollectionInfo<T>(collection: string): Promise<T | null> {
    const key = `colinfo:${collection}`;
    return this.get<T>(key);
  }

  /**
   * Cache collection info
   */
  async setCollectionInfo<T>(collection: string, info: T): Promise<void> {
    const key = `colinfo:${collection}`;
    await this.set(key, info, TTL.COLLECTION_INFO);
  }

  // ============================================
  // Stats
  // ============================================

  /**
   * Get cache stats
   */
  async getStats(): Promise<{
    enabled: boolean;
    connected: boolean;
    keys?: number;
    memory?: string;
  }> {
    if (!this.isEnabled()) {
      return { enabled: false, connected: false };
    }

    try {
      const info = await this.client!.info('memory');
      const dbSize = await this.client!.dbsize();
      const memMatch = info.match(/used_memory_human:(.+)/);

      return {
        enabled: true,
        connected: true,
        keys: dbSize,
        memory: memMatch ? memMatch[1].trim() : undefined,
      };
    } catch (error) {
      return { enabled: true, connected: false };
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.enabled = false;
    }
  }

  // ============================================
  // Session-Aware Embedding Cache (Multi-Level)
  // ============================================

  /**
   * Get embedding with session-aware multi-level caching
   * L1 (Session) -> L2 (Project) -> L3 (Global)
   */
  async getSessionEmbedding(
    text: string,
    options: SessionCacheOptions
  ): Promise<{ embedding: number[] | null; level: 'l1' | 'l2' | 'l3' | 'miss' }> {
    const textHash = this.hash(text);

    // L1: Session cache (fastest, most relevant)
    const l1Key = `${PREFIX.SESSION}:${options.sessionId}:${PREFIX.EMBEDDING}:${textHash}`;
    const l1Value = await this.get<number[]>(l1Key);
    if (l1Value) {
      await this.incrementStats(options.sessionId, 'l1_hits');
      return { embedding: l1Value, level: 'l1' };
    }

    // L2: Project cache (medium TTL)
    const l2Key = `${PREFIX.PROJECT}:${options.projectName}:${PREFIX.EMBEDDING}:${textHash}`;
    const l2Value = await this.get<number[]>(l2Key);
    if (l2Value) {
      // Promote to L1
      await this.set(l1Key, l2Value, TTL.SESSION_EMBEDDING);
      await this.incrementStats(options.sessionId, 'l2_hits');
      return { embedding: l2Value, level: 'l2' };
    }

    // L3: Global cache (longest TTL)
    const l3Key = `${PREFIX.GLOBAL}:${PREFIX.EMBEDDING}:${textHash}`;
    const l3Value = await this.get<number[]>(l3Key);
    if (l3Value) {
      // Promote to L1 and L2
      await Promise.all([
        this.set(l1Key, l3Value, TTL.SESSION_EMBEDDING),
        this.set(l2Key, l3Value, TTL.EMBEDDING),
      ]);
      await this.incrementStats(options.sessionId, 'l3_hits');
      return { embedding: l3Value, level: 'l3' };
    }

    await this.incrementStats(options.sessionId, 'misses');
    return { embedding: null, level: 'miss' };
  }

  /**
   * Set embedding in all cache levels
   */
  async setSessionEmbedding(
    text: string,
    embedding: number[],
    options: SessionCacheOptions
  ): Promise<void> {
    const textHash = this.hash(text);

    // Set in all levels concurrently
    await Promise.all([
      // L1: Session cache
      this.set(
        `${PREFIX.SESSION}:${options.sessionId}:${PREFIX.EMBEDDING}:${textHash}`,
        embedding,
        TTL.SESSION_EMBEDDING
      ),
      // L2: Project cache
      this.set(
        `${PREFIX.PROJECT}:${options.projectName}:${PREFIX.EMBEDDING}:${textHash}`,
        embedding,
        TTL.EMBEDDING
      ),
      // L3: Global cache
      this.set(
        `${PREFIX.GLOBAL}:${PREFIX.EMBEDDING}:${textHash}`,
        embedding,
        TTL.GLOBAL_EMBEDDING
      ),
    ]);
  }

  /**
   * Warm session cache from previous session or project cache
   */
  async warmSessionCache(options: {
    sessionId: string;
    projectName: string;
    previousSessionId?: string;
    recentQueries?: string[];
  }): Promise<{ warmedCount: number }> {
    if (!this.isEnabled()) return { warmedCount: 0 };

    let warmedCount = 0;

    try {
      // If resuming from previous session, copy its cache
      if (options.previousSessionId) {
        const pattern = `${PREFIX.SESSION}:${options.previousSessionId}:${PREFIX.EMBEDDING}:*`;
        const keys = await this.client!.keys(pattern);

        for (const oldKey of keys.slice(0, 100)) {
          const value = await this.client!.get(oldKey);
          if (value) {
            const newKey = oldKey.replace(options.previousSessionId, options.sessionId);
            await this.client!.setex(newKey, TTL.SESSION_EMBEDDING, value);
            warmedCount++;
          }
        }
      }

      // Pre-warm with recent queries
      if (options.recentQueries && options.recentQueries.length > 0) {
        for (const query of options.recentQueries.slice(0, 20)) {
          const textHash = this.hash(query);

          // Check L2/L3 and promote to L1
          const l2Key = `${PREFIX.PROJECT}:${options.projectName}:${PREFIX.EMBEDDING}:${textHash}`;
          const l3Key = `${PREFIX.GLOBAL}:${PREFIX.EMBEDDING}:${textHash}`;

          const value = await this.client!.get(l2Key) || await this.client!.get(l3Key);
          if (value) {
            const l1Key = `${PREFIX.SESSION}:${options.sessionId}:${PREFIX.EMBEDDING}:${textHash}`;
            await this.client!.setex(l1Key, TTL.SESSION_EMBEDDING, value);
            warmedCount++;
          }
        }
      }

      logger.info('Session cache warmed', { sessionId: options.sessionId, warmedCount });
    } catch (error: any) {
      logger.warn('Failed to warm session cache', { error: error.message });
    }

    return { warmedCount };
  }

  /**
   * Clear session cache when session ends
   */
  async clearSessionCache(sessionId: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      await this.deletePattern(`${PREFIX.SESSION}:${sessionId}:*`);
      logger.debug('Session cache cleared', { sessionId });
    } catch (error: any) {
      logger.warn('Failed to clear session cache', { error: error.message });
    }
  }

  // ============================================
  // Session-Aware Search Cache
  // ============================================

  /**
   * Get search results with session awareness
   */
  async getSessionSearchResults<T>(
    collection: string,
    query: string,
    options: SessionCacheOptions,
    filters?: Record<string, unknown>
  ): Promise<{ results: T | null; level: 'l1' | 'l2' | 'miss' }> {
    const filterStr = filters ? JSON.stringify(filters) : '';
    const queryHash = this.hash(query + filterStr);

    // L1: Session cache
    const l1Key = `${PREFIX.SESSION}:${options.sessionId}:${PREFIX.SEARCH}:${collection}:${queryHash}`;
    const l1Value = await this.get<T>(l1Key);
    if (l1Value) {
      await this.incrementStats(options.sessionId, 'search_l1_hits');
      return { results: l1Value, level: 'l1' };
    }

    // L2: Project cache
    const l2Key = `${PREFIX.SEARCH}:${collection}:${queryHash}`;
    const l2Value = await this.get<T>(l2Key);
    if (l2Value) {
      // Promote to L1
      await this.set(l1Key, l2Value, TTL.SESSION_SEARCH);
      await this.incrementStats(options.sessionId, 'search_l2_hits');
      return { results: l2Value, level: 'l2' };
    }

    await this.incrementStats(options.sessionId, 'search_misses');
    return { results: null, level: 'miss' };
  }

  /**
   * Set search results with session awareness
   */
  async setSessionSearchResults<T>(
    collection: string,
    query: string,
    results: T,
    options: SessionCacheOptions,
    filters?: Record<string, unknown>
  ): Promise<void> {
    const filterStr = filters ? JSON.stringify(filters) : '';
    const queryHash = this.hash(query + filterStr);

    await Promise.all([
      // L1: Session cache
      this.set(
        `${PREFIX.SESSION}:${options.sessionId}:${PREFIX.SEARCH}:${collection}:${queryHash}`,
        results,
        TTL.SESSION_SEARCH
      ),
      // L2: Project cache
      this.set(
        `${PREFIX.SEARCH}:${collection}:${queryHash}`,
        results,
        TTL.SEARCH
      ),
    ]);
  }

  // ============================================
  // Cache Analytics
  // ============================================

  /**
   * Increment cache stats for a session
   */
  private async incrementStats(sessionId: string, metric: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const key = `${PREFIX.STATS}:${sessionId}:${metric}`;
      await this.client!.incr(key);
      await this.client!.expire(key, 86400); // 24 hours
    } catch (error) {
      // Ignore stats errors
    }
  }

  /**
   * Get cache stats for a session
   */
  async getSessionStats(sessionId: string): Promise<CacheStats> {
    if (!this.isEnabled()) {
      return { hits: 0, misses: 0, hitRate: 0, l1Hits: 0, l2Hits: 0, l3Hits: 0 };
    }

    try {
      const pipeline = this.client!.pipeline();
      const metrics = ['l1_hits', 'l2_hits', 'l3_hits', 'misses', 'search_l1_hits', 'search_l2_hits', 'search_misses'];

      for (const metric of metrics) {
        pipeline.get(`${PREFIX.STATS}:${sessionId}:${metric}`);
      }

      const results = await pipeline.exec();
      const values = results?.map(r => parseInt(r[1] as string || '0', 10)) || [];

      const l1Hits = values[0] + values[4]; // embedding + search L1 hits
      const l2Hits = values[1] + values[5]; // embedding + search L2 hits
      const l3Hits = values[2];             // embedding L3 hits only
      const misses = values[3] + values[6]; // embedding + search misses

      const totalHits = l1Hits + l2Hits + l3Hits;
      const total = totalHits + misses;

      return {
        hits: totalHits,
        misses,
        hitRate: total > 0 ? totalHits / total : 0,
        l1Hits,
        l2Hits,
        l3Hits,
      };
    } catch (error) {
      return { hits: 0, misses: 0, hitRate: 0, l1Hits: 0, l2Hits: 0, l3Hits: 0 };
    }
  }

  /**
   * Get global cache analytics
   */
  async getCacheAnalytics(): Promise<{
    enabled: boolean;
    connected: boolean;
    totalKeys?: number;
    embeddingKeys?: number;
    searchKeys?: number;
    sessionKeys?: number;
    memoryUsage?: string;
  }> {
    if (!this.isEnabled()) {
      return { enabled: false, connected: false };
    }

    try {
      const info = await this.client!.info('memory');
      const memMatch = info.match(/used_memory_human:(.+)/);

      // Count keys by type
      const [embeddingKeys, searchKeys, sessionKeys, totalKeys] = await Promise.all([
        this.countKeys(`*:${PREFIX.EMBEDDING}:*`),
        this.countKeys(`${PREFIX.SEARCH}:*`),
        this.countKeys(`${PREFIX.SESSION}:*`),
        this.client!.dbsize(),
      ]);

      return {
        enabled: true,
        connected: true,
        totalKeys,
        embeddingKeys,
        searchKeys,
        sessionKeys,
        memoryUsage: memMatch ? memMatch[1].trim() : undefined,
      };
    } catch (error) {
      return { enabled: true, connected: false };
    }
  }

  /**
   * Count keys matching a pattern
   */
  private async countKeys(pattern: string): Promise<number> {
    if (!this.isEnabled()) return 0;

    try {
      const keys = await this.client!.keys(pattern);
      return keys.length;
    } catch {
      return 0;
    }
  }

  /**
   * Prune old session caches (maintenance)
   */
  async pruneOldSessions(maxAgeDays: number = 7): Promise<number> {
    if (!this.isEnabled()) return 0;

    try {
      // Session keys have TTL, so they auto-expire
      // This is for manual cleanup if needed
      const pattern = `${PREFIX.STATS}:*`;
      const keys = await this.client!.keys(pattern);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

      let pruned = 0;
      for (const key of keys) {
        const ttl = await this.client!.ttl(key);
        // If TTL is -1 (no expiry) or very long, delete
        if (ttl === -1 || ttl > maxAgeDays * 24 * 60 * 60) {
          await this.client!.del(key);
          pruned++;
        }
      }

      return pruned;
    } catch (error) {
      return 0;
    }
  }
}

export const cacheService = new CacheService();
export default cacheService;
