/**
 * Sensory Buffer — captures all tool events into Redis Streams.
 *
 * Inspired by the human sensory register: everything is recorded automatically,
 * but only salient events are promoted to working memory.
 *
 * Redis Stream key: sensory:{projectName}:{sessionId}
 * TTL: configurable (default 24h)
 * Max length: configurable (default 10000 entries)
 */

import config from '../config';
import { logger } from '../utils/logger';
import { cacheService } from './cache';

// ── Types ─────────────────────────────────────────────────

export interface SensoryEvent {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  filesTouched: string[];
  success: boolean;
  durationMs: number;
  salience: number;
  timestamp: string;
}

export interface SensoryReadOptions {
  since?: string; // Redis stream ID to read from (exclusive)
  count?: number; // Max events to return
}

export interface SensoryStats {
  eventCount: number;
  salienceDistribution: Record<string, number>; // bucket → count
  topTools: Array<{ tool: string; count: number }>;
}

// ── Salience Scoring ──────────────────────────────────────

/** Tool categories for salience scoring (deterministic, no LLM) */
const SALIENCE_MAP: Record<string, number> = {
  // Errors and failures (highest salience)
  error: 0.9,

  // Decisions and architecture
  record_adr: 0.85,
  record_pattern: 0.85,
  record_tech_debt: 0.85,

  // Code modifications
  index_codebase: 0.7,

  // Search with results
  search_codebase: 0.5,
  hybrid_search: 0.5,
  find_feature: 0.5,
  find_symbol: 0.5,
  search_graph: 0.5,
  search_docs: 0.5,
  ask_codebase: 0.5,
  explain_code: 0.5,
  context_briefing: 0.5,
  smart_dispatch: 0.5,

  // Memory operations
  remember: 0.4,
  recall: 0.4,
  batch_remember: 0.4,
  promote_memory: 0.4,

  // Low salience
  list_memories: 0.2,
  get_adrs: 0.2,
  get_patterns: 0.2,
  get_tech_debt: 0.2,
  get_index_status: 0.2,
  get_project_stats: 0.2,
  review_memories: 0.2,
};

const DEFAULT_SALIENCE = 0.3;

/**
 * Compute salience score for a tool event.
 * Failed operations get a boost (errors are memorable).
 */
export function computeSalience(toolName: string, success: boolean): number {
  const base = SALIENCE_MAP[toolName] ?? DEFAULT_SALIENCE;
  // Failures are more salient (errors demand attention)
  return success ? base : Math.min(1.0, base + 0.3);
}

// ── Service ───────────────────────────────────────────────

class SensoryBufferService {
  private streamKey(project: string, session: string): string {
    return `sensory:${project}:${session}`;
  }

  /**
   * Append a tool event to the sensory buffer stream.
   * Fire-and-forget safe — never throws.
   */
  async append(
    projectName: string,
    sessionId: string,
    event: SensoryEvent
  ): Promise<string | null> {
    const redis = cacheService.getClient();
    if (!redis) return null;

    try {
      const key = this.streamKey(projectName, sessionId);

      // XADD with MAXLEN trim to prevent unbounded growth
      const id = await redis.xadd(
        key,
        'MAXLEN',
        '~',
        String(config.SENSORY_BUFFER_MAX_LEN),
        '*',
        'toolName',
        event.toolName,
        'inputSummary',
        event.inputSummary,
        'outputSummary',
        event.outputSummary,
        'filesTouched',
        JSON.stringify(event.filesTouched),
        'success',
        event.success ? '1' : '0',
        'durationMs',
        String(event.durationMs),
        'salience',
        String(event.salience),
        'timestamp',
        event.timestamp
      );

      // Set TTL on the stream (only once, won't reset if already set)
      const ttl = await redis.ttl(key);
      if (ttl === -1) {
        await redis.expire(key, config.SENSORY_BUFFER_TTL_HOURS * 3600);
      }

      return id;
    } catch (error) {
      logger.debug('Sensory buffer append failed', { error, projectName, sessionId });
      return null;
    }
  }

  /**
   * Read events from the sensory buffer.
   */
  async read(
    projectName: string,
    sessionId: string,
    opts?: SensoryReadOptions
  ): Promise<SensoryEvent[]> {
    const redis = cacheService.getClient();
    if (!redis) return [];

    try {
      const key = this.streamKey(projectName, sessionId);
      const since = opts?.since ?? '-';
      const count = opts?.count ?? 1000;

      const entries = await redis.xrange(key, since, '+', 'COUNT', count);
      return entries.map(([_id, fields]) => this.parseFields(fields));
    } catch (error) {
      logger.debug('Sensory buffer read failed', { error, projectName, sessionId });
      return [];
    }
  }

  /**
   * Get the number of events in the buffer.
   */
  async getLength(projectName: string, sessionId: string): Promise<number> {
    const redis = cacheService.getClient();
    if (!redis) return 0;

    try {
      return await redis.xlen(this.streamKey(projectName, sessionId));
    } catch {
      return 0;
    }
  }

  /**
   * Get buffer statistics for a session.
   */
  async getStats(projectName: string, sessionId: string): Promise<SensoryStats> {
    const events = await this.read(projectName, sessionId);

    const toolCounts = new Map<string, number>();
    const salienceBuckets: Record<string, number> = {
      'high (0.7-1.0)': 0,
      'medium (0.4-0.7)': 0,
      'low (0.0-0.4)': 0,
    };

    for (const event of events) {
      toolCounts.set(event.toolName, (toolCounts.get(event.toolName) ?? 0) + 1);
      if (event.salience >= 0.7) salienceBuckets['high (0.7-1.0)']++;
      else if (event.salience >= 0.4) salienceBuckets['medium (0.4-0.7)']++;
      else salienceBuckets['low (0.0-0.4)']++;
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return {
      eventCount: events.length,
      salienceDistribution: salienceBuckets,
      topTools,
    };
  }

  /**
   * Delete the sensory buffer for a session.
   */
  async cleanup(projectName: string, sessionId: string): Promise<void> {
    const redis = cacheService.getClient();
    if (!redis) return;

    try {
      await redis.del(this.streamKey(projectName, sessionId));
    } catch (error) {
      logger.debug('Sensory buffer cleanup failed', { error });
    }
  }

  /** Parse Redis stream field array into SensoryEvent */
  private parseFields(fields: string[]): SensoryEvent {
    const map = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1]);
    }

    let filesTouched: string[] = [];
    try {
      filesTouched = JSON.parse(map.get('filesTouched') ?? '[]');
    } catch {
      /* empty */
    }

    return {
      toolName: map.get('toolName') ?? '',
      inputSummary: map.get('inputSummary') ?? '',
      outputSummary: map.get('outputSummary') ?? '',
      filesTouched,
      success: map.get('success') === '1',
      durationMs: parseInt(map.get('durationMs') ?? '0', 10),
      salience: parseFloat(map.get('salience') ?? '0'),
      timestamp: map.get('timestamp') ?? '',
    };
  }
}

export const sensoryBuffer = new SensoryBufferService();
