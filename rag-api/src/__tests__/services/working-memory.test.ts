import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis — must be hoisted before vi.mock
const mockRedis = vi.hoisted(() => ({
  hset: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue({}),
  hget: vi.fn().mockResolvedValue(null),
  hdel: vi.fn().mockResolvedValue(1),
  hlen: vi.fn().mockResolvedValue(0),
  del: vi.fn().mockResolvedValue(1),
  ttl: vi.fn().mockResolvedValue(-2),
  expire: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../config', () => ({
  default: {
    SENSORY_BUFFER_MAX_LEN: 10000,
    SENSORY_BUFFER_TTL_HOURS: 24,
    WORKING_MEMORY_CAPACITY: 20,
    SENSORY_SALIENCE_THRESHOLD: 0.5,
  },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    getClient: vi.fn(() => mockRedis),
  },
}));

vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: {},
  computeSalience: vi.fn().mockReturnValue(0.5),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  workingMemory,
  computeSlotScore,
  type WorkingMemorySlot,
} from '../../services/working-memory';
import type { SensoryEvent } from '../../services/sensory-buffer';

describe('computeSlotScore', () => {
  const baseSlot: WorkingMemorySlot = {
    id: 'test',
    content: 'test',
    toolName: 'search',
    files: [],
    salience: 0.8,
    recency: 1.0,
    frequency: 5,
    emotionalWeight: 0.3,
    insertedAt: new Date().toISOString(),
    accessCount: 0,
  };

  it('computes weighted score correctly', () => {
    const sessionStart = Date.now() - 1000; // 1s ago
    const score = computeSlotScore(baseSlot, sessionStart);

    // salience * 0.4 + recency * 0.3 + frequency * 0.2 + emotionalWeight * 0.1
    // 0.8 * 0.4 = 0.32, recency ≈ 1.0 * 0.3 = 0.30, freq = 0.5 * 0.2 = 0.10, emo = 0.3 * 0.1 = 0.03
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('gives higher score to salient events', () => {
    const sessionStart = Date.now();
    const highSalience = { ...baseSlot, salience: 1.0 };
    const lowSalience = { ...baseSlot, salience: 0.2 };

    expect(computeSlotScore(highSalience, sessionStart)).toBeGreaterThan(
      computeSlotScore(lowSalience, sessionStart)
    );
  });

  it('gives higher score to frequent events', () => {
    const sessionStart = Date.now();
    const highFreq = { ...baseSlot, frequency: 10 };
    const lowFreq = { ...baseSlot, frequency: 1 };

    expect(computeSlotScore(highFreq, sessionStart)).toBeGreaterThan(
      computeSlotScore(lowFreq, sessionStart)
    );
  });
});

describe('WorkingMemoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('insert', () => {
    it('inserts slot into Redis hash', async () => {
      mockRedis.hlen.mockResolvedValue(0);

      const slot: WorkingMemorySlot = {
        id: 'slot-1',
        content: 'test content',
        toolName: 'search',
        files: ['a.ts'],
        salience: 0.8,
        recency: 1.0,
        frequency: 1,
        emotionalWeight: 0.3,
        insertedAt: new Date().toISOString(),
        accessCount: 0,
      };

      const result = await workingMemory.insert('proj', 'sess1', slot);
      expect(result).toBe(true);
      expect(mockRedis.hset).toHaveBeenCalledOnce();
    });

    it('evicts lowest when at capacity', async () => {
      mockRedis.hlen.mockResolvedValue(20); // at capacity

      // Mock existing slots for eviction — each unique content to avoid dedup
      const slots: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        slots[`slot-${i}`] = JSON.stringify({
          id: `slot-${i}`,
          content: `old content ${i}`,
          toolName: 'list',
          files: [`file-${i}.ts`],
          salience: 0.1,
          recency: 0,
          frequency: 1,
          emotionalWeight: 0.1,
          insertedAt: new Date(Date.now() - 60000).toISOString(),
          accessCount: 0,
        });
      }
      mockRedis.hgetall.mockResolvedValue(slots);

      const newSlot: WorkingMemorySlot = {
        id: 'new-slot',
        content: 'completely unique important content',
        toolName: 'search',
        files: ['unique.ts'],
        salience: 0.9,
        recency: 1.0,
        frequency: 1,
        emotionalWeight: 1.0,
        insertedAt: new Date().toISOString(),
        accessCount: 0,
      };

      await workingMemory.insert('proj', 'sess-evict', newSlot);

      // Should have called hdel to evict one
      expect(mockRedis.hdel).toHaveBeenCalled();
      // And hset to insert new
      expect(mockRedis.hset).toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('returns slots sorted by score descending', async () => {
      const now = new Date().toISOString();
      mockRedis.hgetall.mockResolvedValue({
        low: JSON.stringify({
          id: 'low',
          content: 'low',
          toolName: 'list',
          files: [],
          salience: 0.1,
          recency: 0,
          frequency: 1,
          emotionalWeight: 0.1,
          insertedAt: now,
          accessCount: 0,
        }),
        high: JSON.stringify({
          id: 'high',
          content: 'high',
          toolName: 'search',
          files: [],
          salience: 0.9,
          recency: 1.0,
          frequency: 5,
          emotionalWeight: 1.0,
          insertedAt: now,
          accessCount: 3,
        }),
      });

      // Init session start time
      await workingMemory.init('proj', 'sess1');
      const slots = await workingMemory.getAll('proj', 'sess1');

      expect(slots).toHaveLength(2);
      expect(slots[0].id).toBe('high');
      expect(slots[1].id).toBe('low');
    });
  });

  describe('touch', () => {
    it('increments accessCount and frequency', async () => {
      const slot = JSON.stringify({
        id: 'slot-1',
        content: 'test',
        toolName: 'search',
        files: [],
        salience: 0.5,
        recency: 1,
        frequency: 2,
        emotionalWeight: 0.3,
        insertedAt: new Date().toISOString(),
        accessCount: 1,
      });
      mockRedis.hget.mockResolvedValue(slot);

      const result = await workingMemory.touch('proj', 'sess1', 'slot-1');
      expect(result).toBe(true);

      const saved = JSON.parse(mockRedis.hset.mock.calls[0][2]);
      expect(saved.accessCount).toBe(2);
      expect(saved.frequency).toBe(3);
    });

    it('returns false for non-existent slot', async () => {
      mockRedis.hget.mockResolvedValue(null);
      const result = await workingMemory.touch('proj', 'sess1', 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    it('deletes the hash key', async () => {
      await workingMemory.clear('proj', 'sess1');
      expect(mockRedis.del).toHaveBeenCalledWith('wm:proj:sess1');
    });
  });

  describe('processEvent', () => {
    it('promotes event above salience threshold', async () => {
      mockRedis.hlen.mockResolvedValue(0);

      const event: SensoryEvent = {
        toolName: 'search_codebase',
        inputSummary: 'find auth',
        outputSummary: 'found',
        filesTouched: ['auth.ts'],
        success: true,
        durationMs: 300,
        salience: 0.8,
        timestamp: new Date().toISOString(),
      };

      const promoted = await workingMemory.processEvent('proj', 'sess1', event);
      expect(promoted).toBe(true);
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it('rejects event below salience threshold', async () => {
      const event: SensoryEvent = {
        toolName: 'list',
        inputSummary: 'list',
        outputSummary: 'ok',
        filesTouched: [],
        success: true,
        durationMs: 50,
        salience: 0.2,
        timestamp: new Date().toISOString(),
      };

      const promoted = await workingMemory.processEvent('proj', 'sess1', event);
      expect(promoted).toBe(false);
      expect(mockRedis.hset).not.toHaveBeenCalled();
    });
  });
});
