/**
 * Working Memory — fixed-capacity salience-scored buffer per session.
 *
 * Inspired by human working memory (~7±2 items). Events from the sensory buffer
 * are filtered by an "attention" mechanism (salience threshold) and stored in
 * a fixed-capacity buffer. When capacity is exceeded, the lowest-scored slot
 * is evicted (salience-weighted LRU).
 *
 * Redis Hash key: wm:{projectName}:{sessionId}
 * Each field in the hash is a slot ID → JSON-serialized WorkingMemorySlot.
 */

import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';
import { cacheService } from './cache';
import { sensoryBuffer, computeSalience, type SensoryEvent } from './sensory-buffer';

// ── Types ─────────────────────────────────────────────────

export interface WorkingMemorySlot {
  id: string;
  content: string;         // inputSummary + key output
  toolName: string;
  files: string[];
  salience: number;        // 0-1, from sensory event
  recency: number;         // 0-1, decays over session time
  frequency: number;       // how many times same file/query appeared
  emotionalWeight: number; // 0-1, errors=1.0, slow ops=0.7, normal=0.3
  insertedAt: string;      // ISO timestamp
  accessCount: number;
}

export interface WorkingMemoryState {
  slots: WorkingMemorySlot[];
  capacity: number;
  sessionId: string;
}

// ── Score Calculation ─────────────────────────────────────

const WEIGHTS = {
  salience: 0.4,
  recency: 0.3,
  frequency: 0.2,
  emotionalWeight: 0.1,
};

/**
 * Compute composite score for a working memory slot.
 * Higher score = more likely to survive eviction.
 */
export function computeSlotScore(slot: WorkingMemorySlot, sessionStartTime: number): number {
  // Recency: 1.0 for just inserted, decays toward 0 over session duration
  const ageMs = Date.now() - new Date(slot.insertedAt).getTime();
  const sessionDurationMs = Date.now() - sessionStartTime;
  const recency = sessionDurationMs > 0
    ? Math.max(0, 1 - (ageMs / sessionDurationMs))
    : 1.0;

  // Frequency: normalize to 0-1 (cap at 10 occurrences)
  const frequency = Math.min(1.0, slot.frequency / 10);

  return (
    slot.salience * WEIGHTS.salience +
    recency * WEIGHTS.recency +
    frequency * WEIGHTS.frequency +
    slot.emotionalWeight * WEIGHTS.emotionalWeight
  );
}

/**
 * Compute emotional weight for an event.
 * Errors are highly "emotional" (memorable), slow ops are notable, rest is routine.
 */
function computeEmotionalWeight(event: SensoryEvent): number {
  if (!event.success) return 1.0;
  if (event.durationMs > 10000) return 0.7;  // slow operation
  if (event.durationMs > 5000) return 0.5;
  return 0.3;
}

// ── Service ───────────────────────────────────────────────

class WorkingMemoryService {
  /** Track session start times for recency calculation */
  private sessionStartTimes = new Map<string, number>();

  /** Track content fingerprints per session for frequency counting */
  private contentFingerprints = new Map<string, Map<string, string>>(); // session → fingerprint → slotId

  private hashKey(project: string, session: string): string {
    return `wm:${project}:${session}`;
  }

  private sessionKey(project: string, session: string): string {
    return `${project}:${session}`;
  }

  /**
   * Initialize working memory for a session. Sets TTL.
   */
  async init(projectName: string, sessionId: string): Promise<void> {
    this.sessionStartTimes.set(this.sessionKey(projectName, sessionId), Date.now());

    const redis = cacheService.getClient();
    if (!redis) return;

    try {
      const key = this.hashKey(projectName, sessionId);
      // Set TTL = sensory buffer TTL (session lifetime)
      const ttl = await redis.ttl(key);
      if (ttl === -1 || ttl === -2) {
        // Key doesn't exist or has no TTL — set it
        await redis.expire(key, config.SENSORY_BUFFER_TTL_HOURS * 3600);
      }
    } catch (error) {
      logger.debug('Working memory init failed', { error });
    }
  }

  /**
   * Process a sensory event through the attention filter.
   * If salience >= threshold, promote to working memory.
   * Returns true if the event was promoted.
   */
  async processEvent(projectName: string, sessionId: string, event: SensoryEvent): Promise<boolean> {
    if (event.salience < config.SENSORY_SALIENCE_THRESHOLD) {
      return false;
    }

    const slot: WorkingMemorySlot = {
      id: crypto.randomUUID(),
      content: this.buildContent(event),
      toolName: event.toolName,
      files: event.filesTouched,
      salience: event.salience,
      recency: 1.0,
      frequency: 1,
      emotionalWeight: computeEmotionalWeight(event),
      insertedAt: event.timestamp,
      accessCount: 0,
    };

    return this.insert(projectName, sessionId, slot);
  }

  /**
   * Insert a slot into working memory. Evicts lowest-scored if at capacity.
   */
  async insert(projectName: string, sessionId: string, slot: WorkingMemorySlot): Promise<boolean> {
    const redis = cacheService.getClient();
    if (!redis) return false;

    try {
      const key = this.hashKey(projectName, sessionId);

      // Check for similar content (frequency tracking)
      const fingerprint = this.fingerprint(slot.content, slot.files);
      const sKey = this.sessionKey(projectName, sessionId);
      if (!this.contentFingerprints.has(sKey)) {
        this.contentFingerprints.set(sKey, new Map());
      }
      const fps = this.contentFingerprints.get(sKey)!;
      const existingSlotId = fps.get(fingerprint);

      if (existingSlotId) {
        // Same content seen before — increment frequency instead of adding new slot
        return this.touch(projectName, sessionId, existingSlotId);
      }

      // Check capacity
      const size = await redis.hlen(key);
      if (size >= config.WORKING_MEMORY_CAPACITY) {
        await this.evictLowest(projectName, sessionId);
      }

      // Insert new slot
      await redis.hset(key, slot.id, JSON.stringify(slot));
      fps.set(fingerprint, slot.id);

      // Refresh TTL
      await redis.expire(key, config.SENSORY_BUFFER_TTL_HOURS * 3600);

      return true;
    } catch (error) {
      logger.debug('Working memory insert failed', { error });
      return false;
    }
  }

  /**
   * Get all working memory slots, sorted by score (highest first).
   */
  async getAll(projectName: string, sessionId: string): Promise<WorkingMemorySlot[]> {
    const redis = cacheService.getClient();
    if (!redis) return [];

    try {
      const key = this.hashKey(projectName, sessionId);
      const data = await redis.hgetall(key);

      const sessionStart = this.sessionStartTimes.get(this.sessionKey(projectName, sessionId)) ?? Date.now();
      const slots: Array<WorkingMemorySlot & { _score: number }> = [];

      for (const [_id, json] of Object.entries(data)) {
        try {
          const slot = JSON.parse(json) as WorkingMemorySlot;
          const score = computeSlotScore(slot, sessionStart);
          slots.push({ ...slot, _score: score });
        } catch { /* skip corrupt entries */ }
      }

      return slots
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...slot }) => slot);
    } catch (error) {
      logger.debug('Working memory getAll failed', { error });
      return [];
    }
  }

  /**
   * Touch a slot: increment accessCount, refresh timestamp.
   */
  async touch(projectName: string, sessionId: string, slotId: string): Promise<boolean> {
    const redis = cacheService.getClient();
    if (!redis) return false;

    try {
      const key = this.hashKey(projectName, sessionId);
      const raw = await redis.hget(key, slotId);
      if (!raw) return false;

      const slot = JSON.parse(raw) as WorkingMemorySlot;
      slot.accessCount++;
      slot.frequency++;
      slot.insertedAt = new Date().toISOString(); // refresh recency

      await redis.hset(key, slotId, JSON.stringify(slot));
      return true;
    } catch (error) {
      logger.debug('Working memory touch failed', { error });
      return false;
    }
  }

  /**
   * Evict the lowest-scored slot from working memory.
   */
  private async evictLowest(projectName: string, sessionId: string): Promise<void> {
    const redis = cacheService.getClient();
    if (!redis) return;

    try {
      const key = this.hashKey(projectName, sessionId);
      const data = await redis.hgetall(key);

      const sessionStart = this.sessionStartTimes.get(this.sessionKey(projectName, sessionId)) ?? Date.now();
      let lowestId: string | null = null;
      let lowestScore = Infinity;

      for (const [id, json] of Object.entries(data)) {
        try {
          const slot = JSON.parse(json) as WorkingMemorySlot;
          const score = computeSlotScore(slot, sessionStart);
          if (score < lowestScore) {
            lowestScore = score;
            lowestId = id;
          }
        } catch { /* skip corrupt */ }
      }

      if (lowestId) {
        await redis.hdel(key, lowestId);

        // Remove from fingerprint index
        const sKey = this.sessionKey(projectName, sessionId);
        const fps = this.contentFingerprints.get(sKey);
        if (fps) {
          for (const [fp, slotId] of fps) {
            if (slotId === lowestId) {
              fps.delete(fp);
              break;
            }
          }
        }
      }
    } catch (error) {
      logger.debug('Working memory eviction failed', { error });
    }
  }

  /**
   * Clear all working memory for a session.
   */
  async clear(projectName: string, sessionId: string): Promise<void> {
    const redis = cacheService.getClient();

    // Clean up in-memory state
    const sKey = this.sessionKey(projectName, sessionId);
    this.sessionStartTimes.delete(sKey);
    this.contentFingerprints.delete(sKey);

    if (!redis) return;

    try {
      await redis.del(this.hashKey(projectName, sessionId));
    } catch (error) {
      logger.debug('Working memory clear failed', { error });
    }
  }

  /**
   * Get working memory state summary.
   */
  async getState(projectName: string, sessionId: string): Promise<WorkingMemoryState> {
    const slots = await this.getAll(projectName, sessionId);
    return {
      slots,
      capacity: config.WORKING_MEMORY_CAPACITY,
      sessionId,
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  /** Build content string from sensory event */
  private buildContent(event: SensoryEvent): string {
    const parts = [event.inputSummary];
    if (event.outputSummary && event.outputSummary.length > 0) {
      parts.push(event.outputSummary.slice(0, 200));
    }
    return parts.join(' → ');
  }

  /** Create a fingerprint for deduplication (same query + same files = same content) */
  private fingerprint(content: string, files: string[]): string {
    const normalized = content.toLowerCase().trim().slice(0, 100) + '|' + files.sort().join(',');
    return crypto.createHash('md5').update(normalized).digest('hex');
  }
}

export const workingMemory = new WorkingMemoryService();
