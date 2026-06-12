import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// M4 acceptance tests for the session-lifecycle worker's batch-consolidation
// split. The pre-existing flag-off behaviour is pinned (unmodified) in
// session-lifecycle.worker.test.ts — this file covers the flag interactions
// and the new continuation job cases.
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  CONSOLIDATION_BATCH_ENABLED: false,
  ANTHROPIC_API_KEY: '' as string | undefined,
}));
vi.mock('../../config', () => ({ default: mockConfig }));

const mockCreateWorker = vi.hoisted(() => vi.fn());
vi.mock('../../events/queues', () => ({
  createWorker: mockCreateWorker,
}));

const mockSensoryRead = vi.hoisted(() => vi.fn());
vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: { read: mockSensoryRead },
}));

const mockConsolidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/consolidation-agent', () => ({
  consolidationAgent: { consolidate: mockConsolidate },
}));

const mockDetectStaleMemories = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/stale-memory-detector', () => ({
  staleMemoryDetector: { detectStaleMemories: mockDetectStaleMemories },
}));

const mockWmClear = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/working-memory', () => ({
  workingMemory: { clear: mockWmClear, processEvent: vi.fn() },
}));

const mockBatchSubmit = vi.hoisted(() => vi.fn());
const mockHandleAbstract = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHandleFinalize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHandleTerminalFailure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/consolidation-batch', () => ({
  consolidationBatch: {
    submit: mockBatchSubmit,
    handleAbstract: mockHandleAbstract,
    handleFinalize: mockHandleFinalize,
    handleTerminalFailure: mockHandleTerminalFailure,
  },
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import { processSessionLifecycleJob } from '../../events/workers/session-lifecycle.worker';

function consolidatableEvents() {
  return Array.from({ length: 6 }, (_, i) => ({ toolName: 'search_codebase', value: { i } }));
}

function endingJob(projectName = 'beep', sessionId = 'sess-abc') {
  return { name: 'session:ending', data: { projectName, sessionId } };
}

const SNAPSHOT = {
  wmSlots: [],
  eventSummary: 'summary',
  wmObservationLines: ['obs'],
  totalEvents: 6,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.CONSOLIDATION_BATCH_ENABLED = false;
  mockConfig.ANTHROPIC_API_KEY = '';
  mockSensoryRead.mockResolvedValue(consolidatableEvents());
  mockConsolidate.mockResolvedValue(undefined);
  mockBatchSubmit.mockResolvedValue('submitted');
});

// ---------------------------------------------------------------------------
// Acceptance (a): flag off → the batch path is never engaged
// ---------------------------------------------------------------------------

describe('session:ending — flag OFF (acceptance a)', () => {
  it('runs the sync Ollama path and never touches the batch service', async () => {
    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockBatchSubmit).not.toHaveBeenCalled();
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });

  it('flag on but NO key → still the sync path (key is required)', async () => {
    mockConfig.CONSOLIDATION_BATCH_ENABLED = true;
    mockConfig.ANTHROPIC_API_KEY = '';

    await processSessionLifecycleJob(endingJob());

    expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockBatchSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flag ON + key present
// ---------------------------------------------------------------------------

describe('session:ending — flag ON (batch path)', () => {
  beforeEach(() => {
    mockConfig.CONSOLIDATION_BATCH_ENABLED = true;
    mockConfig.ANTHROPIC_API_KEY = 'test-key';
  });

  it('"submitted" → no sync consolidation, no worker-side WM clear (cleared at submit), job succeeds', async () => {
    mockBatchSubmit.mockResolvedValue('submitted');

    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    expect(mockBatchSubmit).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockConsolidate).not.toHaveBeenCalled();
    // WM lifecycle is owned by the batch path (cleared at submit time inside
    // consolidationBatch.submit) — the worker must NOT clear it again here.
    expect(mockWmClear).not.toHaveBeenCalled();
    // Stale detection still runs.
    expect(mockDetectStaleMemories).toHaveBeenCalledWith('beep');
  });

  it('"inflight" (second session:ending before finalize) → NO sync run, NO clear — acceptance (f)', async () => {
    mockBatchSubmit.mockResolvedValue('inflight');

    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    // Running the sync agent here would re-read the still-alive sensory
    // buffer and duplicate the consolidated memories — it must NOT happen.
    expect(mockConsolidate).not.toHaveBeenCalled();
    expect(mockWmClear).not.toHaveBeenCalled();
  });

  it('"empty" → nothing to consolidate, worker clears WM as usual', async () => {
    mockBatchSubmit.mockResolvedValue('empty');

    await processSessionLifecycleJob(endingJob());

    expect(mockConsolidate).not.toHaveBeenCalled();
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });

  it('batches.create throws → byte-identical sync Ollama fallback', async () => {
    mockBatchSubmit.mockRejectedValue(new Error('api down'));

    await expect(processSessionLifecycleJob(endingJob())).resolves.toBeUndefined();

    expect(mockConsolidate).toHaveBeenCalledWith('beep', 'sess-abc');
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });

  it('sync fallback failure after a failed submit still re-throws (BullMQ retry, WM preserved)', async () => {
    mockBatchSubmit.mockRejectedValue(new Error('api down'));
    mockConsolidate.mockRejectedValueOnce(new Error('ollama down'));

    await expect(processSessionLifecycleJob(endingJob())).rejects.toThrow('ollama down');
    expect(mockWmClear).not.toHaveBeenCalled();
  });

  it('short session with manual memories skips consolidation entirely (no batch submit)', async () => {
    mockSensoryRead.mockResolvedValueOnce([
      { toolName: 'remember', value: {} },
      { toolName: 'search_codebase', value: {} },
    ]);

    await processSessionLifecycleJob(endingJob());

    expect(mockBatchSubmit).not.toHaveBeenCalled();
    expect(mockConsolidate).not.toHaveBeenCalled();
    expect(mockWmClear).toHaveBeenCalledWith('beep', 'sess-abc');
  });
});

// ---------------------------------------------------------------------------
// Continuation job dispatch (payload-only — never re-reads the buffer)
// ---------------------------------------------------------------------------

describe('consolidation continuation jobs', () => {
  it('consolidation:abstract → consolidationBatch.handleAbstract(payload)', async () => {
    const data = {
      projectName: 'beep',
      sessionId: 'sess-abc',
      snapshot: SNAPSHOT,
      resultText: '{"patterns": []}',
      batchId: 'batch_1',
    };

    await processSessionLifecycleJob({ name: 'consolidation:abstract', data });

    expect(mockHandleAbstract).toHaveBeenCalledWith(data);
    expect(mockSensoryRead).not.toHaveBeenCalled(); // acceptance (d)
  });

  it('consolidation:finalize → consolidationBatch.handleFinalize(payload)', async () => {
    const data = {
      projectName: 'beep',
      sessionId: 'sess-abc',
      snapshot: SNAPSHOT,
      resultText: '{"memories": []}',
      batchId: 'batch_2',
    };

    await processSessionLifecycleJob({ name: 'consolidation:finalize', data });

    expect(mockHandleFinalize).toHaveBeenCalledWith(data);
    expect(mockSensoryRead).not.toHaveBeenCalled(); // acceptance (d)
  });

  it('consolidation:batch-failed → consolidationBatch.handleTerminalFailure(payload)', async () => {
    const data = {
      projectName: 'beep',
      sessionId: 'sess-abc',
      snapshot: SNAPSHOT,
      reason: 'invalid_request: bad',
    };

    await processSessionLifecycleJob({ name: 'consolidation:batch-failed', data });

    expect(mockHandleTerminalFailure).toHaveBeenCalledWith(data);
  });

  it('continuation handler errors propagate so BullMQ retries the (self-contained) job', async () => {
    mockHandleFinalize.mockRejectedValueOnce(new Error('store failed'));

    await expect(
      processSessionLifecycleJob({
        name: 'consolidation:finalize',
        data: { projectName: 'beep', sessionId: 's', snapshot: SNAPSHOT, resultText: '{}' },
      })
    ).rejects.toThrow('store failed');
  });
});
