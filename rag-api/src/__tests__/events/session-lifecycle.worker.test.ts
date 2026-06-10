import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock factories — declared before the imports that pull in the
// module under test, because vi.mock() calls are hoisted to the top of the
// compiled output (see actor-system.test.ts for the established pattern).
// ---------------------------------------------------------------------------

// The worker module imports { createWorker } from '../queues' at module load.
// Stub it so importing the worker never touches BullMQ/Redis. We also capture
// the registered processor to prove startSessionLifecycleWorker() wires the
// extracted processor unchanged.
const mockCreateWorker = vi.hoisted(() => vi.fn());
vi.mock('../../events/queues', () => ({
  createWorker: mockCreateWorker,
}));

// Lazy-imported deps inside the 'session:ending' branch.
const mockSensoryRead = vi.hoisted(() => vi.fn());
vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: {
    read: mockSensoryRead,
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

const mockWmClear = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWmProcessEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/working-memory', () => ({
  workingMemory: {
    clear: mockWmClear,
    processEvent: mockWmProcessEvent,
  },
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import {
  processSessionLifecycleJob,
  startSessionLifecycleWorker,
} from '../../events/workers/session-lifecycle.worker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A batch of sensory events that takes the FULL consolidation path:
// >= 5 events and no manual remember/batch_remember tool calls, so the
// processor calls consolidationAgent.consolidate() rather than skipping.
function consolidatableEvents() {
  return Array.from({ length: 6 }, (_, i) => ({ toolName: 'search_codebase', value: { i } }));
}

function endingJob(projectName = 'beep', sessionId = 'sess-abc') {
  return {
    name: 'session:ending',
    data: { projectName, sessionId },
  };
}

// ---------------------------------------------------------------------------
// processSessionLifecycleJob — session:ending re-throw semantics (fix #3)
// ---------------------------------------------------------------------------

describe('processSessionLifecycleJob — session:ending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSensoryRead.mockResolvedValue(consolidatableEvents());
    mockConsolidate.mockResolvedValue(undefined);
  });

  it('clears working memory and does NOT throw when consolidation succeeds', async () => {
    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });

  it('does NOT clear working memory and RE-THROWS when consolidation fails (BullMQ retries)', async () => {
    const boom = new Error('LLM timeout');
    mockConsolidate.mockRejectedValueOnce(boom);

    // The processor must re-throw so the BullMQ job fails and the queue's
    // attempts/backoff re-run consolidation.
    await expect(processSessionLifecycleJob(endingJob())).rejects.toThrow('LLM timeout');

    // The sensory buffer / working memory must survive a failed consolidation
    // so the retried job can re-consolidate from it.
    expect(mockWmClear).not.toHaveBeenCalled();
  });

  it('still runs stale-memory detection even when consolidation fails', async () => {
    mockConsolidate.mockRejectedValueOnce(new Error('LLM timeout'));

    await expect(processSessionLifecycleJob(endingJob())).rejects.toThrow();

    // Stale detection runs regardless of consolidation outcome (it precedes
    // the guarded cleanup and the re-throw).
    expect(mockDetectStaleMemories).toHaveBeenCalledWith('beep');
  });

  it('wraps a non-Error rejection before re-throwing', async () => {
    mockConsolidate.mockRejectedValueOnce('plain string failure');

    await expect(processSessionLifecycleJob(endingJob())).rejects.toBeInstanceOf(Error);
    expect(mockWmClear).not.toHaveBeenCalled();
  });

  it('skips consolidation (and clears) for a short session with manual memories', async () => {
    // < 5 events AND a manual remember → skip path: nothing to consolidate,
    // so it is safe to clear and there is no throw.
    mockSensoryRead.mockResolvedValueOnce([
      { toolName: 'remember', value: {} },
      { toolName: 'search_codebase', value: {} },
    ]);

    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    expect(mockConsolidate).not.toHaveBeenCalled();
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });
});

// ---------------------------------------------------------------------------
// startSessionLifecycleWorker — wiring is unchanged by the refactor
// ---------------------------------------------------------------------------

describe('startSessionLifecycleWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a worker on the session-lifecycle queue with concurrency 2', () => {
    startSessionLifecycleWorker();

    expect(mockCreateWorker).toHaveBeenCalledWith('session-lifecycle', expect.any(Function), {
      concurrency: 2,
    });
  });

  it('the registered processor forwards to processSessionLifecycleJob', async () => {
    startSessionLifecycleWorker();

    const registeredProcessor = mockCreateWorker.mock.calls[0][1] as (job: any) => Promise<void>;

    // Drive a success-path session:ending job through the registered processor
    // and confirm it exercises the same consolidation/clear behaviour.
    mockSensoryRead.mockResolvedValue(consolidatableEvents());
    await registeredProcessor(endingJob());

    expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });
});
