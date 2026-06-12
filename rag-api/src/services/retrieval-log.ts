/**
 * Retrieval Audit Log — append-only record of every memory delivery (M3 task 2).
 *
 * Records WHICH memories were delivered to a session, WHEN, and through which
 * surface ('digest' | 'recall' | 'enrichment'), so the validate-or-kill metric
 * (memory-roi) and the dashboard session trail are computable server-side.
 *
 * Storage: Redis (via cacheService), chosen over a Qdrant payload-only
 * collection because appends are O(1) LPUSH-style with no embedding cost,
 * TTL/compaction are native (EXPIRE + LTRIM), and the per-session read is a
 * single LRANGE. Volume is tiny (a few entries per session).
 *
 * Keys:
 *   retrieval-log:{project}:{sessionId}   — RPUSH'd JSON entries (oldest-first)
 *   retrieval-log:{project}:digest-index  — ZSET of digest deliveries
 *                                            (member "sid|ts|memCount", score ts)
 *     → cheap per-project digestDeliveries / sessionsWithDigest aggregation.
 *
 * EVERY method is best-effort and never throws: producers call this
 * fire-and-forget and a broken audit log must never fail a recall or block a
 * session start.
 */

import { cacheService } from './cache';
import { logger } from '../utils/logger';

// ── Retention / caps ──────────────────────────────────────

/** ~90d retention (contract: TTL/compaction). */
const TTL_SECONDS = 90 * 24 * 60 * 60;
/** Compaction: keep at most this many entries per session list. */
const MAX_ENTRIES_PER_SESSION = 500;
/** Caps per entry, so a huge digest can't bloat the log. */
const MAX_IDS_PER_ENTRY = 100;
const SNIPPET_CHARS = 150;

// ── Types ─────────────────────────────────────────────────

export type RetrievalSurface = 'digest' | 'recall' | 'enrichment';

export interface RetrievalLogEntry {
  projectName: string;
  sessionId: string;
  surface: RetrievalSurface;
  memoryIds: string[];
  snippets: string[];
  query?: string;
  /** ISO string */
  timestamp: string;
}

export interface LogRetrievalOptions {
  projectName: string;
  sessionId: string;
  surface: RetrievalSurface;
  memoryIds: string[];
  snippets: string[];
  query?: string;
}

export interface DigestDeliveryStats {
  deliveries: number;
  nonEmptyDeliveries: number;
  sessionsWithDigest: number;
}

// ── Service ───────────────────────────────────────────────

class RetrievalLogService {
  private sessionKey(projectName: string, sessionId: string): string {
    return `retrieval-log:${projectName}:${sessionId}`;
  }

  private digestIndexKey(projectName: string): string {
    return `retrieval-log:${projectName}:digest-index`;
  }

  /**
   * Append a retrieval entry. Best-effort: resolves (never rejects) and
   * no-ops when Redis is unavailable. Callers still attach .catch(() => {})
   * defensively — the audit log must NEVER block a recall.
   */
  async log(options: LogRetrievalOptions): Promise<void> {
    try {
      const client = cacheService.getClient();
      if (!client) return;

      const timestamp = new Date().toISOString();
      const entry: RetrievalLogEntry = {
        projectName: options.projectName,
        sessionId: options.sessionId,
        surface: options.surface,
        memoryIds: options.memoryIds.slice(0, MAX_IDS_PER_ENTRY).map(String),
        snippets: options.snippets
          .slice(0, MAX_IDS_PER_ENTRY)
          .map((s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)),
        query: options.query,
        timestamp,
      };

      const key = this.sessionKey(options.projectName, options.sessionId);
      await client.rpush(key, JSON.stringify(entry));
      // Compaction: keep the most recent MAX_ENTRIES_PER_SESSION entries.
      await client.ltrim(key, -MAX_ENTRIES_PER_SESSION, -1);
      await client.expire(key, TTL_SECONDS);

      // Per-project digest-delivery index for cheap memory-roi aggregation.
      if (options.surface === 'digest') {
        const ts = Date.now();
        const indexKey = this.digestIndexKey(options.projectName);
        await client.zadd(indexKey, ts, `${options.sessionId}|${ts}|${entry.memoryIds.length}`);
        // Compaction: drop index entries past the retention window.
        await client.zremrangebyscore(indexKey, '-inf', ts - TTL_SECONDS * 1000);
        await client.expire(indexKey, TTL_SECONDS);
      }
    } catch (error: any) {
      logger.debug('Retrieval log append failed (non-blocking)', { error: error?.message });
    }
  }

  /**
   * Read all retrieval entries for a session, sorted oldest-first.
   * Returns [] when Redis is unavailable or nothing was logged.
   */
  async getSessionRetrievals(projectName: string, sessionId: string): Promise<RetrievalLogEntry[]> {
    try {
      const client = cacheService.getClient();
      if (!client) return [];

      const raw = await client.lrange(this.sessionKey(projectName, sessionId), 0, -1);
      const entries: RetrievalLogEntry[] = [];
      for (const item of raw) {
        try {
          entries.push(JSON.parse(item) as RetrievalLogEntry);
        } catch {
          /* skip malformed entries */
        }
      }
      // RPUSH already yields oldest-first; sort defensively on timestamp.
      entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      return entries;
    } catch (error: any) {
      logger.debug('Retrieval log read failed', { error: error?.message });
      return [];
    }
  }

  /**
   * Digest-delivery stats over a trailing window (for memory-roi).
   */
  async getDigestStats(projectName: string, days: number): Promise<DigestDeliveryStats> {
    const empty: DigestDeliveryStats = {
      deliveries: 0,
      nonEmptyDeliveries: 0,
      sessionsWithDigest: 0,
    };

    try {
      const client = cacheService.getClient();
      if (!client) return empty;

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const members: string[] = await client.zrangebyscore(
        this.digestIndexKey(projectName),
        cutoff,
        '+inf'
      );

      const sessions = new Set<string>();
      let nonEmpty = 0;
      for (const member of members) {
        // member format: "{sessionId}|{ts}|{memCount}"
        const lastSep = member.lastIndexOf('|');
        const midSep = member.lastIndexOf('|', lastSep - 1);
        const sessionId = member.slice(0, midSep);
        const memCount = parseInt(member.slice(lastSep + 1), 10);
        if (sessionId) sessions.add(sessionId);
        if (memCount > 0) nonEmpty++;
      }

      return {
        deliveries: members.length,
        nonEmptyDeliveries: nonEmpty,
        sessionsWithDigest: sessions.size,
      };
    } catch (error: any) {
      logger.debug('Retrieval log digest stats failed', { error: error?.message });
      return empty;
    }
  }
}

export const retrievalLog = new RetrievalLogService();
export default retrievalLog;
