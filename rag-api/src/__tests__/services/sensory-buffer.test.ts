import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    SENSORY_BUFFER_MAX_LEN: 10000,
    SENSORY_BUFFER_TTL_HOURS: 24,
    WORKING_MEMORY_CAPACITY: 20,
    SENSORY_SALIENCE_THRESHOLD: 0.5,
  },
}));

// Mock Redis client returned by cacheService.getClient()
const mockRedis = vi.hoisted(() => ({
  xadd: vi.fn().mockResolvedValue('1234567890-0'),
  xrange: vi.fn().mockResolvedValue([]),
  xlen: vi.fn().mockResolvedValue(0),
  ttl: vi.fn().mockResolvedValue(-1),
  expire: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    getClient: vi.fn(() => mockRedis),
  },
}));

import { sensoryBuffer, computeSalience, type SensoryEvent } from '../../services/sensory-buffer';

describe('computeSalience', () => {
  it('returns 0.9 for error tool name', () => {
    expect(computeSalience('error', true)).toBe(0.9);
  });

  it('returns 0.5 for search_codebase success', () => {
    expect(computeSalience('search_codebase', true)).toBe(0.5);
  });

  it('boosts salience by 0.3 on failure (capped at 1.0)', () => {
    expect(computeSalience('search_codebase', false)).toBe(0.8);
    expect(computeSalience('error', false)).toBe(1.0); // 0.9 + 0.3 = 1.2 → capped to 1.0
  });

  it('returns 0.2 for list_memories', () => {
    expect(computeSalience('list_memories', true)).toBe(0.2);
  });

  it('returns default 0.3 for unknown tools', () => {
    expect(computeSalience('unknown_tool', true)).toBe(0.3);
  });

  it('returns 0.85 for record_adr', () => {
    expect(computeSalience('record_adr', true)).toBe(0.85);
  });
});

describe('SensoryBufferService', () => {
  const event: SensoryEvent = {
    toolName: 'search_codebase',
    inputSummary: 'how does auth work',
    outputSummary: 'Found 3 results',
    filesTouched: ['src/auth.ts'],
    success: true,
    durationMs: 450,
    salience: 0.5,
    timestamp: '2026-03-24T10:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('append', () => {
    it('calls XADD with correct key and fields', async () => {
      const id = await sensoryBuffer.append('proj', 'sess1', event);

      expect(id).toBe('1234567890-0');
      expect(mockRedis.xadd).toHaveBeenCalledOnce();

      const args = mockRedis.xadd.mock.calls[0];
      expect(args[0]).toBe('sensory:proj:sess1');
      expect(args[1]).toBe('MAXLEN');
      // args: key, MAXLEN, ~, maxlen_value, *, field1, val1, ...
      expect(args[2]).toBe('~');
      expect(args[4]).toBe('*');
      expect(args[5]).toBe('toolName');
      expect(args[6]).toBe('search_codebase');
    });

    it('sets TTL on first append', async () => {
      await sensoryBuffer.append('proj', 'sess1', event);

      expect(mockRedis.ttl).toHaveBeenCalledWith('sensory:proj:sess1');
      expect(mockRedis.expire).toHaveBeenCalledWith('sensory:proj:sess1', 24 * 3600);
    });

    it('skips TTL if already set', async () => {
      mockRedis.ttl.mockResolvedValue(3600);

      await sensoryBuffer.append('proj', 'sess1', event);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('returns null when Redis unavailable', async () => {
      const { cacheService } = await import('../../services/cache');
      vi.mocked(cacheService.getClient).mockReturnValueOnce(null);

      const id = await sensoryBuffer.append('proj', 'sess1', event);
      expect(id).toBeNull();
    });
  });

  describe('read', () => {
    it('calls XRANGE with correct key', async () => {
      mockRedis.xrange.mockResolvedValue([
        [
          '1-0',
          [
            'toolName',
            'search_codebase',
            'inputSummary',
            'test',
            'outputSummary',
            'ok',
            'filesTouched',
            '["a.ts"]',
            'success',
            '1',
            'durationMs',
            '100',
            'salience',
            '0.5',
            'timestamp',
            '2026-01-01T00:00:00Z',
          ],
        ],
      ]);

      const events = await sensoryBuffer.read('proj', 'sess1', { count: 10 });

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('search_codebase');
      expect(events[0].filesTouched).toEqual(['a.ts']);
      expect(events[0].success).toBe(true);
      expect(events[0].salience).toBe(0.5);
    });

    it('returns empty array when Redis unavailable', async () => {
      const { cacheService } = await import('../../services/cache');
      vi.mocked(cacheService.getClient).mockReturnValueOnce(null);

      const events = await sensoryBuffer.read('proj', 'sess1');
      expect(events).toEqual([]);
    });
  });

  describe('getLength', () => {
    it('returns XLEN result', async () => {
      mockRedis.xlen.mockResolvedValue(42);
      const len = await sensoryBuffer.getLength('proj', 'sess1');
      expect(len).toBe(42);
    });
  });

  describe('cleanup', () => {
    it('calls DEL on the stream key', async () => {
      await sensoryBuffer.cleanup('proj', 'sess1');
      expect(mockRedis.del).toHaveBeenCalledWith('sensory:proj:sess1');
    });
  });
});
