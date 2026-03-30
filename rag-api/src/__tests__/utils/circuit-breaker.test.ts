import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  circuitBreakers,
  embeddingCircuit,
  llmCircuit,
  vectorStoreCircuit,
  confluenceCircuit,
} from '../../utils/circuit-breaker';
import { CircuitOpenError } from '../../utils/errors';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker('test', {
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 5000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('stays CLOSED on successful execution', async () => {
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('stays CLOSED when failures are below threshold', async () => {
    for (let i = 0; i < 2; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('transitions CLOSED -> OPEN after failureThreshold failures', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('throws CircuitOpenError when OPEN and timeout not elapsed', async () => {
    // Force to OPEN
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    await expect(cb.execute(() => Promise.resolve('nope'))).rejects.toThrow(CircuitOpenError);
  });

  it('re-throws the original error from a failed operation', async () => {
    const err = new Error('specific-error');
    await expect(cb.execute(() => Promise.reject(err))).rejects.toThrow('specific-error');
  });

  it('transitions OPEN -> HALF_OPEN after timeout elapses', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(5000);

    // Next execute should transition to HALF_OPEN and run the operation
    const result = await cb.execute(() => Promise.resolve('recovering'));
    expect(result).toBe('recovering');
    // After 1 success, still HALF_OPEN (needs 2 successes)
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it('transitions HALF_OPEN -> CLOSED after successThreshold successes', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    vi.advanceTimersByTime(5000);

    // Two successes in HALF_OPEN
    await cb.execute(() => Promise.resolve('ok'));
    await cb.execute(() => Promise.resolve('ok'));

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('transitions HALF_OPEN -> OPEN on single failure', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    vi.advanceTimersByTime(5000);

    // One success, then one failure
    await cb.execute(() => Promise.resolve('ok'));
    await cb.execute(() => Promise.reject(new Error('fail again'))).catch(() => {});

    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  describe('forceState()', () => {
    it('forces to OPEN', () => {
      cb.forceState(CircuitState.OPEN);
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('forces to HALF_OPEN and resets successes', () => {
      cb.forceState(CircuitState.HALF_OPEN);
      expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('forces to CLOSED and resets counters', () => {
      cb.forceState(CircuitState.OPEN);
      cb.forceState(CircuitState.CLOSED);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('reset()', () => {
    it('resets to CLOSED with zeroed counters', async () => {
      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(cb.getState()).toBe(CircuitState.OPEN);

      cb.reset();

      expect(cb.getState()).toBe(CircuitState.CLOSED);
      const stats = cb.getStats();
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.lastFailure).toBeNull();
      expect(stats.lastSuccess).toBeNull();
    });
  });

  describe('getStats()', () => {
    it('returns correct stats after operations', async () => {
      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});

      const stats = cb.getStats();
      expect(stats.name).toBe('test');
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(1);
      expect(stats.lastFailure).not.toBeNull();
      expect(stats.lastSuccess).not.toBeNull();
    });

    it('returns ISO timestamps', async () => {
      vi.setSystemTime(new Date('2025-06-15T10:00:00.000Z'));
      await cb.execute(() => Promise.resolve('ok'));

      const stats = cb.getStats();
      expect(stats.lastSuccess).toBe('2025-06-15T10:00:00.000Z');
    });
  });

  describe('resetTimeout behavior', () => {
    it('resets failure count after resetTimeout in CLOSED state', async () => {
      const cbWithReset = new CircuitBreaker('resetTest', {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 5000,
        resetTimeout: 10000,
      });

      // Add some failures
      await cbWithReset.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await cbWithReset.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      expect(cbWithReset.getStats().failures).toBe(2);

      // Advance past resetTimeout
      vi.advanceTimersByTime(11000);

      // Success should reset failure count
      await cbWithReset.execute(() => Promise.resolve('ok'));
      expect(cbWithReset.getStats().failures).toBe(0);
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  beforeEach(() => {
    circuitBreakers.resetAll();
  });

  it('get() creates a new breaker', () => {
    const cb = circuitBreakers.get('new-breaker');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('get() reuses existing breaker', () => {
    const cb1 = circuitBreakers.get('reuse-test');
    const cb2 = circuitBreakers.get('reuse-test');
    expect(cb1).toBe(cb2);
  });

  it('getAll() returns all breakers', () => {
    // Pre-configured breakers already exist
    const all = circuitBreakers.getAll();
    expect(all.length).toBeGreaterThanOrEqual(4); // embedding, llm, vectorStore, confluence
  });

  it('getAllStats() returns stats for all breakers', () => {
    const stats = circuitBreakers.getAllStats();
    expect(stats.length).toBeGreaterThanOrEqual(4);
    expect(stats[0]).toHaveProperty('name');
    expect(stats[0]).toHaveProperty('state');
    expect(stats[0]).toHaveProperty('failures');
  });

  it('resetAll() resets all breakers to CLOSED', () => {
    const cb = circuitBreakers.get('to-reset');
    cb.forceState(CircuitState.OPEN);

    circuitBreakers.resetAll();

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('Pre-configured breakers', () => {
  it('embeddingCircuit exists with correct thresholds', () => {
    expect(embeddingCircuit).toBeInstanceOf(CircuitBreaker);
    expect(embeddingCircuit.getStats().name).toBe('embedding');
  });

  it('llmCircuit exists', () => {
    expect(llmCircuit).toBeInstanceOf(CircuitBreaker);
    expect(llmCircuit.getStats().name).toBe('ollama');
  });

  it('vectorStoreCircuit exists', () => {
    expect(vectorStoreCircuit).toBeInstanceOf(CircuitBreaker);
    expect(vectorStoreCircuit.getStats().name).toBe('vectorStore');
  });

  it('confluenceCircuit exists', () => {
    expect(confluenceCircuit).toBeInstanceOf(CircuitBreaker);
    expect(confluenceCircuit.getStats().name).toBe('confluence');
  });
});
