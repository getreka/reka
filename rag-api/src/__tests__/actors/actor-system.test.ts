import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock factories — must be declared before any imports that pull
// in the modules under test, because vi.mock() calls are hoisted to the
// top of the compiled output.
// ---------------------------------------------------------------------------

const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'job-1' }));
const mockQueueClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueGetJobCounts = vi.hoisted(() => vi.fn().mockResolvedValue({}));

const mockWorkerClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWorkerOn = vi.hoisted(() => vi.fn());

const mockRedisGet = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockRedisSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));
const mockRedisDel = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockRedisDisconnect = vi.hoisted(() => vi.fn());

// Capture the Worker processor so individual tests can invoke it directly
let capturedProcessor: ((job: any) => Promise<any>) | null = null;

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: mockQueueAdd,
    close: mockQueueClose,
    getJobCounts: mockQueueGetJobCounts,
  })),
  Worker: vi.fn().mockImplementation((_name: string, processor: (job: any) => Promise<any>) => {
    capturedProcessor = processor;
    return {
      close: mockWorkerClose,
      on: mockWorkerOn,
      processor,
    };
  }),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    disconnect: mockRedisDisconnect,
  })),
}));

// Mock metrics so Prometheus counters/histograms don't crash in test env
vi.mock('../../utils/metrics', () => ({
  eventProcessedTotal: { inc: vi.fn() },
  eventProcessingDuration: { observe: vi.fn() },
  actorLockContentions: { inc: vi.fn() },
  actorStateSizeBytes: { set: vi.fn() },
}));

// Mock event queues used for dead-letter routing
vi.mock('../../events/queues', () => ({
  getQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../events/emitter', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Service mocks required by MemoryActor and SessionActor
// ---------------------------------------------------------------------------

const mockDetectRelationships = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOnRecall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockMergeMemories = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ totalMerged: 0, clusters: [] })
);

vi.mock('../../services/memory', () => ({
  memoryService: {
    _asyncDetectRelationships: mockDetectRelationships,
    mergeMemories: mockMergeMemories,
  },
}));

vi.mock('../../services/reconsolidation', () => ({
  reconsolidation: {
    onRecall: mockOnRecall,
  },
}));

const mockGetSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockPredict = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockPrefetch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../services/session-context', () => ({
  sessionContext: {
    getSession: mockGetSession,
  },
}));

vi.mock('../../services/predictive-loader', () => ({
  predictiveLoader: {
    predict: mockPredict,
    prefetch: mockPrefetch,
  },
}));

const mockConsolidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/consolidation-agent', () => ({
  consolidationAgent: {
    consolidate: mockConsolidate,
  },
}));

const mockDetectStaleMemories = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/stale-memory-detector', () => ({
  staleMemoryDetector: {
    detectStaleMemories: mockDetectStaleMemories,
  },
}));

const mockWmProcessEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWmClear = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/working-memory', () => ({
  workingMemory: {
    processEvent: mockWmProcessEvent,
    clear: mockWmClear,
  },
}));

// ---------------------------------------------------------------------------
// Imports — these come AFTER all vi.mock() declarations
// ---------------------------------------------------------------------------

import { Queue, Worker } from 'bullmq';
import { ActorRef, Actor, type ActorMessage } from '../../actors/base-actor';
import { MemoryActor } from '../../actors/memory-actor';
import { sessionActor, type SessionActorState } from '../../actors/session-actor';
import { actorSystem } from '../../actors/actor-system';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage<T>(type: string, payload: T, actorId = 'test:proj'): ActorMessage<T> {
  return { type, payload, actorId, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// TestActor — minimal concrete subclass for testing the base class
// ---------------------------------------------------------------------------

class TestActor extends Actor<{ count: number }, { value: number }> {
  constructor(supervision?: any) {
    super('test', { count: 0 }, supervision);
  }

  async handle(
    _actorId: string,
    msg: ActorMessage<{ value: number }>,
    state: { count: number }
  ): Promise<{ count: number }> {
    return { count: state.count + msg.payload.value };
  }
}

// ---------------------------------------------------------------------------
// ActorRef
// ---------------------------------------------------------------------------

describe('ActorRef', () => {
  let mockQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueue = {
      name: 'actor-test',
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('send() enqueues a message with correct envelope fields', async () => {
    const ref = new ActorRef(mockQueue, 'memory:beep-services', 'memory');

    await ref.send('memory:created', { content: 'hello' });

    expect(mockQueue.add).toHaveBeenCalledOnce();
    const [jobName, message, opts] = mockQueue.add.mock.calls[0];

    expect(jobName).toBe('memory:created');
    expect(message.type).toBe('memory:created');
    expect(message.payload).toEqual({ content: 'hello' });
    expect(message.actorId).toBe('memory:beep-services');
    expect(typeof message.timestamp).toBe('string');
    // Timestamp should be a valid ISO string
    expect(new Date(message.timestamp).toISOString()).toBe(message.timestamp);
  });

  it('send() passes retry/backoff options to queue.add()', async () => {
    const ref = new ActorRef(mockQueue, 'memory:proj', 'memory');

    await ref.send('memory:created', {});

    const [, , opts] = mockQueue.add.mock.calls[0];
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    expect(opts.removeOnComplete).toBe(100);
    expect(opts.removeOnFail).toBe(50);
  });

  it('actorId and actorType are accessible on the ref', () => {
    const ref = new ActorRef(mockQueue, 'session:myproject:abc123', 'session');
    expect(ref.actorId).toBe('session:myproject:abc123');
    expect(ref.actorType).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Actor base class
// ---------------------------------------------------------------------------

describe('Actor base class', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;
  });

  it('constructor sets actorType correctly', () => {
    const actor = new TestActor();
    expect(actor.actorType).toBe('test');
  });

  it('constructor creates a BullMQ Queue named actor-{type}', () => {
    new TestActor();
    expect(Queue).toHaveBeenCalledWith('actor-test', expect.any(Object));
  });

  it('ref() returns an ActorRef with the correct actorId', () => {
    const actor = new TestActor();
    const ref = actor.ref('test:my-instance');
    expect(ref).toBeInstanceOf(ActorRef);
    expect(ref.actorId).toBe('test:my-instance');
    expect(ref.actorType).toBe('test');
  });

  it('start() creates a BullMQ Worker', () => {
    const actor = new TestActor();
    actor.start();
    expect(Worker).toHaveBeenCalledWith(
      'actor-test',
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 })
    );
  });

  it('start() respects custom concurrency', () => {
    const actor = new TestActor();
    actor.start(10);
    expect(Worker).toHaveBeenCalledWith(
      'actor-test',
      expect.any(Function),
      expect.objectContaining({ concurrency: 10 })
    );
  });

  it('stop() calls worker.close() and queue.close()', async () => {
    const actor = new TestActor();
    actor.start();
    await actor.stop();
    expect(mockWorkerClose).toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalled();
  });

  it('stop() is safe to call when worker was never started', async () => {
    const actor = new TestActor();
    // No start() call — worker is null
    await expect(actor.stop()).resolves.not.toThrow();
    expect(mockQueueClose).toHaveBeenCalled();
  });

  it('clearState() deletes the Redis state key', async () => {
    const actor = new TestActor();
    await actor.clearState('test:proj-x');
    expect(mockRedisDel).toHaveBeenCalledWith('actor-test:test:proj-x:state');
  });

  describe('Worker processor', () => {
    /**
     * Helper: return the LAST redis.set() call whose key contains ':state'.
     * The processor calls set() twice when no prior state exists:
     *   1. saveState(defaultState)  — before handle()
     *   2. saveState(newState)      — after handle()
     * We want the final persisted state.
     */
    function lastStateSave(): any[] | undefined {
      const stateCalls = mockRedisSet.mock.calls.filter((c) => (c[0] as string).includes(':state'));
      return stateCalls[stateCalls.length - 1];
    }

    it('loads default state when Redis returns null and calls handle()', async () => {
      const actor = new TestActor();
      actor.start();

      // Default mockRedisSet already returns 'OK' for all calls (lock + state saves).
      // Default mockRedisGet already returns null (no stored state).

      const job = {
        id: 'job-1',
        data: makeMessage('increment', { value: 5 }, 'test:proj'),
      };

      await capturedProcessor!(job);

      // Final persisted state should be count: 5 (0 + 5)
      const savedArg = lastStateSave();
      expect(savedArg).toBeDefined();
      const savedState = JSON.parse(savedArg![1] as string);
      expect(savedState).toEqual({ count: 5 });
    });

    it('loads existing state from Redis and applies handle()', async () => {
      const actor = new TestActor();
      actor.start();

      // Simulate existing state: get() returns JSON for the state key
      mockRedisGet.mockResolvedValueOnce(JSON.stringify({ count: 10 }));

      const job = {
        id: 'job-2',
        data: makeMessage('increment', { value: 3 }, 'test:proj'),
      };

      await capturedProcessor!(job);

      // When existing state is loaded there is only ONE state save (after handle)
      const savedArg = lastStateSave();
      expect(savedArg).toBeDefined();
      const savedState = JSON.parse(savedArg![1] as string);
      expect(savedState).toEqual({ count: 13 });
    });

    it('throws when lock cannot be acquired (actor busy)', async () => {
      const actor = new TestActor();
      actor.start();

      // The lock set() call is the FIRST set() call in the processor.
      // Return null to signal the lock was NOT acquired (NX condition failed).
      mockRedisSet.mockResolvedValueOnce(null);

      const job = {
        id: 'job-3',
        data: makeMessage('increment', { value: 1 }, 'test:proj'),
      };

      await expect(capturedProcessor!(job)).rejects.toThrow(/busy/);
    });

    it('releases the lock in the finally block even on handler error', async () => {
      class FailingActor extends Actor<{ count: number }, { value: number }> {
        constructor() {
          super('failing', { count: 0 });
        }
        async handle(): Promise<{ count: number }> {
          throw new Error('handler exploded');
        }
      }

      const actor = new FailingActor();
      actor.start();

      mockRedisSet.mockResolvedValueOnce('OK'); // lock acquired
      mockRedisGet.mockResolvedValueOnce(null); // no state

      const job = {
        id: 'job-err',
        data: makeMessage('fail', { value: 1 }, 'failing:proj'),
      };

      // Should not throw — error is swallowed after supervision logic
      await capturedProcessor!(job);

      // Lock should have been released
      expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(':lock'));
    });
  });

  describe('Supervision', () => {
    it('messages are dropped (sent to DLQ) after maxRestarts failures within windowMs', async () => {
      class AlwaysFailActor extends Actor<{ count: number }, { value: number }> {
        constructor() {
          // Low limits so we can trigger quickly
          super(
            'alwaysfail',
            { count: 0 },
            {
              maxRestarts: 2,
              windowMs: 60000,
              backoffMs: 0,
            }
          );
        }
        async handle(): Promise<{ count: number }> {
          throw new Error('always fails');
        }
      }

      const { getQueue } = await import('../../events/queues');
      const mockDlqAdd = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getQueue).mockReturnValue({ add: mockDlqAdd } as any);

      const actor = new AlwaysFailActor();
      actor.start();

      const makeJob = (id: string) => ({
        id,
        data: makeMessage('fail', { value: 1 }, 'alwaysfail:proj'),
      });

      // Simulate enough failures to exceed maxRestarts (>2 = 3+)
      for (let i = 0; i < 4; i++) {
        mockRedisSet.mockResolvedValueOnce('OK');
        mockRedisGet.mockResolvedValueOnce(null);
        await capturedProcessor!(makeJob(`job-sup-${i}`));
      }

      // After exceeding restart limit, DLQ should have received messages
      expect(mockDlqAdd).toHaveBeenCalled();
    });

    it('restart counter resets after window expires', async () => {
      // Access private restartTimes via a test-only subclass
      class InspectableActor extends Actor<{ count: number }, { value: number }> {
        constructor() {
          super(
            'inspectable',
            { count: 0 },
            {
              maxRestarts: 1,
              windowMs: 100, // very short window
              backoffMs: 0,
            }
          );
        }
        async handle(): Promise<{ count: number }> {
          throw new Error('fail');
        }
        // expose for testing
        getRestartTimes(): number[] {
          return (this as any).restartTimes;
        }
      }

      const actor = new InspectableActor();
      actor.start();

      // Trigger one failure
      mockRedisSet.mockResolvedValueOnce('OK');
      mockRedisGet.mockResolvedValueOnce(null);
      await capturedProcessor!({
        id: 'j1',
        data: makeMessage('fail', { value: 1 }, 'inspectable:p'),
      });

      // One restart recorded
      expect(actor.getRestartTimes().length).toBe(1);

      // Wait for window to expire then trigger another failure
      await new Promise((r) => setTimeout(r, 150));

      mockRedisSet.mockResolvedValueOnce('OK');
      mockRedisGet.mockResolvedValueOnce(null);
      await capturedProcessor!({
        id: 'j2',
        data: makeMessage('fail', { value: 1 }, 'inspectable:p'),
      });

      // Old restart pruned (outside window), only 1 current restart
      expect(actor.getRestartTimes().length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// MemoryActor
// ---------------------------------------------------------------------------

describe('MemoryActor', () => {
  let actor: MemoryActor;
  const defaultState = () => ({
    recentMemoryIds: [],
    relationshipsDetected: 0,
    reconsolidationsRun: 0,
    lastActivity: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    actor = new MemoryActor();
  });

  it('has actorType "memory"', () => {
    expect(actor.actorType).toBe('memory');
  });

  describe('handle(memory:created)', () => {
    it('calls _asyncDetectRelationships with correct arguments', async () => {
      const state = defaultState();
      const payload = {
        projectName: 'beep',
        memoryId: 'mem-001',
        content: 'decision to use Qdrant',
        type: 'decision',
        tags: ['infra'],
        embedding: [0.1, 0.2, 0.3],
        timestamp: new Date().toISOString(),
        correlationId: 'corr-1',
      };

      const msg = makeMessage('memory:created', payload, 'memory:beep');
      await actor.handle('memory:beep', msg, state);

      expect(mockDetectRelationships).toHaveBeenCalledWith(
        'beep',
        'mem-001',
        'decision to use Qdrant',
        'decision',
        [0.1, 0.2, 0.3]
      );
    });

    it('increments relationshipsDetected on success', async () => {
      const state = defaultState();
      const payload = {
        projectName: 'proj',
        memoryId: 'mem-002',
        content: 'test',
        type: 'insight',
        tags: [],
        embedding: [],
        timestamp: new Date().toISOString(),
        correlationId: 'c2',
      };

      const newState = await actor.handle(
        'memory:proj',
        makeMessage('memory:created', payload, 'memory:proj'),
        state
      );

      expect(newState.relationshipsDetected).toBe(1);
    });

    it('does not increment relationshipsDetected when service throws', async () => {
      mockDetectRelationships.mockRejectedValueOnce(new Error('embed failed'));

      const state = defaultState();
      const payload = {
        projectName: 'proj',
        memoryId: 'mem-003',
        content: 'x',
        type: 'note',
        tags: [],
        embedding: [],
        timestamp: new Date().toISOString(),
        correlationId: 'c3',
      };

      const newState = await actor.handle(
        'memory:proj',
        makeMessage('memory:created', payload, 'memory:proj'),
        state
      );

      expect(newState.relationshipsDetected).toBe(0);
    });

    it('adds memoryId to recentMemoryIds LRU', async () => {
      const state = defaultState();
      const payload = {
        projectName: 'p',
        memoryId: 'lru-1',
        content: 'c',
        type: 'note',
        tags: [],
        embedding: [],
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };

      const newState = await actor.handle(
        'memory:p',
        makeMessage('memory:created', payload, 'memory:p'),
        state
      );

      expect(newState.recentMemoryIds).toContain('lru-1');
    });

    it('LRU does not exceed MAX_LRU_SIZE (100)', async () => {
      // Pre-fill the LRU with 100 items
      const state = {
        ...defaultState(),
        recentMemoryIds: Array.from({ length: 100 }, (_, i) => `old-${i}`),
      };
      const payload = {
        projectName: 'p',
        memoryId: 'new-entry',
        content: 'c',
        type: 'note',
        tags: [],
        embedding: [],
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };

      const newState = await actor.handle(
        'memory:p',
        makeMessage('memory:created', payload, 'memory:p'),
        state
      );

      expect(newState.recentMemoryIds.length).toBeLessThanOrEqual(100);
      // New entry should be at the front
      expect(newState.recentMemoryIds[0]).toBe('new-entry');
    });

    it('moves duplicate memoryId to front of LRU', async () => {
      const state = {
        ...defaultState(),
        recentMemoryIds: ['already-here', 'other-1', 'other-2'],
      };
      const payload = {
        projectName: 'p',
        memoryId: 'already-here',
        content: 'c',
        type: 'note',
        tags: [],
        embedding: [],
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };

      const newState = await actor.handle(
        'memory:p',
        makeMessage('memory:created', payload, 'memory:p'),
        state
      );

      expect(newState.recentMemoryIds[0]).toBe('already-here');
      // No duplicates
      const count = newState.recentMemoryIds.filter((id) => id === 'already-here').length;
      expect(count).toBe(1);
    });
  });

  describe('handle(memory:recalled)', () => {
    it('does NOT call onRecall when RECONSOLIDATION_ENABLED is false', async () => {
      // config mock sets RECONSOLIDATION_ENABLED: false
      const state = defaultState();
      const payload = {
        projectName: 'p',
        query: 'what did we decide?',
        resultCount: 2,
        memoryIds: ['m1', 'm2'],
        recalledMemories: [
          { id: 'm1', content: 'c1' },
          { id: 'm2', content: 'c2' },
        ],
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };

      await actor.handle('memory:p', makeMessage('memory:recalled', payload, 'memory:p'), state);

      expect(mockOnRecall).not.toHaveBeenCalled();
    });

    it('calls onRecall when RECONSOLIDATION_ENABLED is true', async () => {
      // Temporarily override the config mock for this test
      const configMod = await import('../../config');
      const originalValue = (configMod as any).default.RECONSOLIDATION_ENABLED;
      (configMod as any).default.RECONSOLIDATION_ENABLED = true;

      const state = defaultState();
      const payload = {
        projectName: 'proj',
        query: 'recent decisions',
        resultCount: 1,
        memoryIds: ['m-x'],
        recalledMemories: [{ id: 'm-x', content: 'some content' }],
        timestamp: new Date().toISOString(),
        correlationId: 'rc',
      };

      await actor.handle(
        'memory:proj',
        makeMessage('memory:recalled', payload, 'memory:proj'),
        state
      );

      expect(mockOnRecall).toHaveBeenCalledWith(
        'proj',
        payload.recalledMemories,
        'recent decisions'
      );

      // Restore
      (configMod as any).default.RECONSOLIDATION_ENABLED = originalValue;
    });

    it('increments reconsolidationsRun when onRecall succeeds', async () => {
      const configMod = await import('../../config');
      const originalValue = (configMod as any).default.RECONSOLIDATION_ENABLED;
      (configMod as any).default.RECONSOLIDATION_ENABLED = true;

      const state = defaultState();
      const payload = {
        projectName: 'proj',
        query: 'q',
        resultCount: 1,
        memoryIds: ['m1'],
        recalledMemories: [{ id: 'm1', content: 'c' }],
        timestamp: new Date().toISOString(),
        correlationId: 'rc2',
      };

      const newState = await actor.handle(
        'memory:proj',
        makeMessage('memory:recalled', payload, 'memory:proj'),
        state
      );

      expect(newState.reconsolidationsRun).toBe(1);

      (configMod as any).default.RECONSOLIDATION_ENABLED = originalValue;
    });

    it('does not call onRecall when recalledMemories is empty', async () => {
      const configMod = await import('../../config');
      const originalValue = (configMod as any).default.RECONSOLIDATION_ENABLED;
      (configMod as any).default.RECONSOLIDATION_ENABLED = true;

      const state = defaultState();
      const payload = {
        projectName: 'proj',
        query: 'q',
        resultCount: 0,
        memoryIds: [],
        recalledMemories: [],
        timestamp: new Date().toISOString(),
        correlationId: 'rc3',
      };

      await actor.handle(
        'memory:proj',
        makeMessage('memory:recalled', payload, 'memory:proj'),
        state
      );

      expect(mockOnRecall).not.toHaveBeenCalled();

      (configMod as any).default.RECONSOLIDATION_ENABLED = originalValue;
    });
  });
});

// ---------------------------------------------------------------------------
// SessionActor
// ---------------------------------------------------------------------------

describe('SessionActor', () => {
  // SessionActor class is not exported; use the module singleton.
  const actor = sessionActor;
  const defaultState = (): SessionActorState => ({
    projectName: 'beep',
    sessionId: 'sess-abc',
    startedAt: new Date().toISOString(),
    activitiesCount: 0,
    sensoryEventsProcessed: 0,
    prefetchesRun: 0,
    status: 'active',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has actorType "session"', () => {
    expect(actor.actorType).toBe('session');
  });

  describe('onInit', () => {
    it('parses projectName and sessionId from actorId', async () => {
      // onInit is protected; call via the worker path or cast
      const state = await (actor as any).onInit('session:beep-services:sess-xyz');
      expect(state.projectName).toBe('beep-services');
      expect(state.sessionId).toBe('sess-xyz');
      expect(state.status).toBe('active');
    });

    it('handles actorId with colons in projectName', async () => {
      // format: session:{projectName}:{sessionId} — projectName may contain colons
      const state = await (actor as any).onInit('session:my:complex:project:id-999');
      expect(state.sessionId).toBe('id-999');
      expect(state.projectName).toBe('my:complex:project');
    });
  });

  describe('handle(session:started)', () => {
    it('sets status to "active"', async () => {
      const state = defaultState();
      state.status = 'ending'; // simulate previous state

      const payload = { projectName: 'beep', sessionId: 'sess-abc' };
      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:started', payload, 'session:beep:sess-abc'),
        state
      );

      expect(newState.status).toBe('active');
    });

    it('sets projectName and sessionId from payload', async () => {
      const state = { ...defaultState(), projectName: '', sessionId: '' };

      const payload = { projectName: 'proj-x', sessionId: 'sid-1' };
      const newState = await actor.handle(
        'session:proj-x:sid-1',
        makeMessage('session:started', payload, 'session:proj-x:sid-1'),
        state
      );

      expect(newState.projectName).toBe('proj-x');
      expect(newState.sessionId).toBe('sid-1');
    });

    it('runs predictive prefetch when session context has a session', async () => {
      mockGetSession.mockResolvedValueOnce({
        currentFiles: ['src/index.ts'],
        recentQueries: ['how does indexing work?'],
        toolsUsed: ['search_codebase'],
        activeFeatures: ['indexing'],
      });
      mockPredict.mockResolvedValueOnce(['src/services/indexer.ts']);

      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:started', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockPredict).toHaveBeenCalled();
      expect(mockPrefetch).toHaveBeenCalled();
      expect(newState.prefetchesRun).toBe(1);
    });

    it('does not increment prefetchesRun when predictions is empty', async () => {
      mockGetSession.mockResolvedValueOnce({
        currentFiles: [],
        recentQueries: [],
        toolsUsed: [],
        activeFeatures: [],
      });
      mockPredict.mockResolvedValueOnce([]); // no predictions

      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:started', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockPrefetch).not.toHaveBeenCalled();
      expect(newState.prefetchesRun).toBe(0);
    });

    it('tolerates getSession() throwing', async () => {
      mockGetSession.mockRejectedValueOnce(new Error('redis down'));

      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      await expect(
        actor.handle(
          'session:beep:sess-abc',
          makeMessage('session:started', payload, 'session:beep:sess-abc'),
          state
        )
      ).resolves.toBeDefined();
    });
  });

  describe('handle(session:activity)', () => {
    it('increments activitiesCount by 1', async () => {
      const state = defaultState();

      const payload = {
        projectName: 'beep',
        sessionId: 'sess-abc',
        activityType: 'search',
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };

      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:activity', payload, 'session:beep:sess-abc'),
        state
      );

      expect(newState.activitiesCount).toBe(1);
    });

    it('increments activitiesCount cumulatively', async () => {
      let state = defaultState();
      const payload = {
        projectName: 'beep',
        sessionId: 'sess-abc',
        activityType: 'index',
        timestamp: new Date().toISOString(),
        correlationId: 'c',
      };
      const msg = makeMessage('session:activity', payload, 'session:beep:sess-abc');

      state = await actor.handle('session:beep:sess-abc', msg, state);
      state = await actor.handle('session:beep:sess-abc', msg, state);
      state = await actor.handle('session:beep:sess-abc', msg, state);

      expect(state.activitiesCount).toBe(3);
    });
  });

  describe('handle(session:ending)', () => {
    it('runs consolidation agent', async () => {
      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    });

    it('runs stale memory detection', async () => {
      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockDetectStaleMemories).toHaveBeenCalledWith('beep');
    });

    it('clears working memory', async () => {
      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
    });

    it('calls clearState to remove actor state from Redis', async () => {
      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('session:beep:sess-abc:state')
      );
    });

    it('sets status to "ended"', async () => {
      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      expect(newState.status).toBe('ended');
    });

    it('tolerates consolidation errors gracefully', async () => {
      mockConsolidate.mockRejectedValueOnce(new Error('LLM timeout'));

      const state = defaultState();
      const payload = { projectName: 'beep', sessionId: 'sess-abc' };

      const newState = await actor.handle(
        'session:beep:sess-abc',
        makeMessage('session:ending', payload, 'session:beep:sess-abc'),
        state
      );

      // Should still reach 'ended' status despite consolidation failure
      expect(newState.status).toBe('ended');
    });
  });
});

// ---------------------------------------------------------------------------
// ActorSystem
// ---------------------------------------------------------------------------

describe('ActorSystem', () => {
  // Import the singleton but create isolated instances for most tests
  // to avoid state leakage between test runs.
  function makeIsolatedSystem() {
    // Dynamically re-construct since actorSystem is a module singleton
    // We need to test the class behaviour, so we access the class directly.
    // ActorSystem is not exported — test via the exported singleton with cleanup.
    return actorSystem;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain the singleton's actor map between tests using shutdown
    // We call it synchronously so the map is cleared before each test.
    (actorSystem as any).actors.clear();
  });

  it('register() stores and starts the actor', () => {
    const actor = new TestActor();
    const startSpy = vi.spyOn(actor, 'start');

    actorSystem.register(actor);

    expect(startSpy).toHaveBeenCalled();
    expect(actorSystem.get('test')).toBe(actor);
  });

  it('register() passes optional concurrency to start()', () => {
    const actor = new TestActor();
    const startSpy = vi.spyOn(actor, 'start');

    actorSystem.register(actor, 8);

    expect(startSpy).toHaveBeenCalledWith(8);
  });

  it('register() is idempotent — same actorType is not registered twice', () => {
    const actor1 = new TestActor();
    const actor2 = new TestActor();
    const start1 = vi.spyOn(actor1, 'start');
    const start2 = vi.spyOn(actor2, 'start');

    actorSystem.register(actor1);
    actorSystem.register(actor2); // duplicate type 'test'

    expect(start1).toHaveBeenCalledOnce();
    expect(start2).not.toHaveBeenCalled();
    // First actor still accessible
    expect(actorSystem.get('test')).toBe(actor1);
  });

  it('get() returns the registered actor by type', () => {
    const actor = new TestActor();
    actorSystem.register(actor);

    const retrieved = actorSystem.get('test');
    expect(retrieved).toBe(actor);
  });

  it('get() returns undefined for unregistered type', () => {
    expect(actorSystem.get('nonexistent')).toBeUndefined();
  });

  it('shutdown() calls stop() on all registered actors', async () => {
    const actor1 = new TestActor();
    // Need a second type — override actorType via subclass
    class AnotherActor extends Actor<{}, {}> {
      constructor() {
        super('another', {});
      }
      async handle() {
        return {};
      }
    }
    const actor2 = new AnotherActor();

    const stop1 = vi.spyOn(actor1, 'stop').mockResolvedValue(undefined);
    const stop2 = vi.spyOn(actor2, 'stop').mockResolvedValue(undefined);

    actorSystem.register(actor1);
    actorSystem.register(actor2);

    await actorSystem.shutdown();

    expect(stop1).toHaveBeenCalled();
    expect(stop2).toHaveBeenCalled();
  });

  it('shutdown() clears the actor registry', async () => {
    const actor = new TestActor();
    vi.spyOn(actor, 'stop').mockResolvedValue(undefined);

    actorSystem.register(actor);
    expect(actorSystem.get('test')).toBeDefined();

    await actorSystem.shutdown();

    expect(actorSystem.get('test')).toBeUndefined();
  });

  it('shutdown() continues even if one actor stop() rejects', async () => {
    const actor1 = new TestActor();
    class BrokenActor extends Actor<{}, {}> {
      constructor() {
        super('broken', {});
      }
      async handle() {
        return {};
      }
    }
    const actor2 = new BrokenActor();

    vi.spyOn(actor1, 'stop').mockRejectedValue(new Error('redis gone'));
    vi.spyOn(actor2, 'stop').mockResolvedValue(undefined);

    actorSystem.register(actor1);
    actorSystem.register(actor2);

    await expect(actorSystem.shutdown()).resolves.not.toThrow();
  });

  it('allows re-registration of a type after shutdown()', async () => {
    const actor1 = new TestActor();
    vi.spyOn(actor1, 'stop').mockResolvedValue(undefined);

    actorSystem.register(actor1);
    await actorSystem.shutdown();

    const actor2 = new TestActor();
    const startSpy = vi.spyOn(actor2, 'start');
    actorSystem.register(actor2);

    expect(startSpy).toHaveBeenCalled();
  });
});
