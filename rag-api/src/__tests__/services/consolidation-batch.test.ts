import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before importing the module under test.
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  CONSOLIDATION_BATCH_ENABLED: true,
  CONSOLIDATION_BATCH_WINDOW_MS: 0,
  ANTHROPIC_API_KEY: 'test-key',
  CONSOLIDATION_TIMEOUT_MS: 120000,
  CONSOLIDATION_LLM_TIMEOUT_MS: 30000,
}));
vi.mock('../../config', () => ({ default: mockConfig }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('../../services/cache', () => ({
  cacheService: {
    getClient: () => ({ set: mockRedisSet, del: mockRedisDel }),
  },
}));

const mockWmGetAll = vi.hoisted(() => vi.fn());
const mockWmClear = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWmInsert = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../../services/working-memory', () => ({
  workingMemory: { getAll: mockWmGetAll, clear: mockWmClear, insert: mockWmInsert },
}));

const mockSbRead = vi.hoisted(() => vi.fn());
vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: { read: mockSbRead },
}));

const mockBuildSnapshot = vi.hoisted(() => vi.fn());
const mockNormalize = vi.hoisted(() => vi.fn((m: unknown[]) => m));
const mockStoreAbstracted = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ episodic: [], semantic: [] })
);
const mockConsolidateSnapshot = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ episodic: [], semantic: [] })
);
vi.mock('../../services/consolidation-agent', () => ({
  consolidationAgent: {
    buildSnapshot: mockBuildSnapshot,
    normalizeAbstracted: mockNormalize,
    storeAbstracted: mockStoreAbstracted,
    consolidateSnapshot: mockConsolidateSnapshot,
  },
  PATTERN_DETECTION_PROMPT: 'PATTERN_PROMPT',
  ABSTRACTION_PROMPT: 'ABSTRACTION_PROMPT',
  PATTERN_JSON_SCHEMA: { marker: 'pattern-schema' },
  MEMORIES_JSON_SCHEMA: { marker: 'memories-schema' },
}));

const mockBatchSubmit = vi.hoisted(() => vi.fn().mockResolvedValue({ batchId: 'batch_1' }));
vi.mock('../../services/anthropic-batch', () => ({
  anthropicBatch: { submit: mockBatchSubmit },
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import { consolidationBatch } from '../../services/consolidation-batch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WM_SLOTS = [
  { id: 'slot-1', content: 'fixed auth bug', toolName: 'edit', salience: 0.9, files: ['a.ts'] },
  { id: 'slot-2', content: 'searched auth', toolName: 'search', salience: 0.6, files: [] },
];

const SNAPSHOT = {
  wmSlots: WM_SLOTS,
  eventSummary: '[WM] edit: fixed auth bug\n[OK] search: auth (10ms)',
  wmObservationLines: ['[edit] fixed auth bug (files: a.ts)'],
  totalEvents: 6,
};

function basePayload(extra: Record<string, unknown> = {}) {
  return { projectName: 'beep', sessionId: 's-1', snapshot: SNAPSHOT, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.CONSOLIDATION_BATCH_ENABLED = true;
  mockConfig.CONSOLIDATION_BATCH_WINDOW_MS = 0;
  mockConfig.ANTHROPIC_API_KEY = 'test-key';
  mockRedisSet.mockResolvedValue('OK'); // NX claim succeeds by default
  mockWmGetAll.mockResolvedValue(WM_SLOTS);
  mockSbRead.mockResolvedValue(
    Array.from({ length: 6 }, (_, i) => ({ toolName: 'search', inputSummary: `q${i}` }))
  );
  mockBuildSnapshot.mockReturnValue(SNAPSHOT);
  mockBatchSubmit.mockResolvedValue({ batchId: 'batch_1' });
  mockNormalize.mockImplementation((m: unknown[]) => m);
  mockStoreAbstracted.mockResolvedValue({ episodic: [], semantic: [] });
  mockConsolidateSnapshot.mockResolvedValue({ episodic: [], semantic: [] });
});

// ---------------------------------------------------------------------------
// isEnabled — flag + key required
// ---------------------------------------------------------------------------

describe('consolidationBatch.isEnabled', () => {
  it('is true only when the flag is on AND a key is present', () => {
    expect(consolidationBatch.isEnabled()).toBe(true);

    mockConfig.CONSOLIDATION_BATCH_ENABLED = false;
    expect(consolidationBatch.isEnabled()).toBe(false);

    mockConfig.CONSOLIDATION_BATCH_ENABLED = true;
    mockConfig.ANTHROPIC_API_KEY = '';
    expect(consolidationBatch.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submit — acceptance (b) WM cleared at submit, (f) dup-guard
// ---------------------------------------------------------------------------

describe('consolidationBatch.submit', () => {
  it('snapshots the session and submits step-1 with json_schema, effort medium, caller consolidation', async () => {
    const outcome = await consolidationBatch.submit('beep', 's-1');

    expect(outcome).toBe('submitted');
    expect(mockBuildSnapshot).toHaveBeenCalledWith(WM_SLOTS, expect.any(Array));
    expect(mockBatchSubmit).toHaveBeenCalledTimes(1);

    const args = mockBatchSubmit.mock.calls[0][0];
    expect(args.caller).toBe('consolidation');
    expect(args.rows).toHaveLength(1);
    const row = args.rows[0];
    expect(row.request.systemPrompt).toBe('PATTERN_PROMPT');
    expect(row.request.jsonSchema).toEqual({ marker: 'pattern-schema' });
    expect(row.request.effort).toBe('medium');
    expect(row.request.prompt).toContain('Session events:');
    // Continuation named in the envelope; payload carries the snapshot.
    expect(row.continuation).toEqual(
      expect.objectContaining({
        queue: 'session-lifecycle',
        jobName: 'consolidation:abstract',
        payload: expect.objectContaining({ snapshot: SNAPSHOT }),
      })
    );
    expect(row.failureContinuation).toEqual(
      expect.objectContaining({ jobName: 'consolidation:batch-failed' })
    );
  });

  it('clears working memory AT SUBMIT (after batches.create succeeded) — acceptance (b)', async () => {
    await consolidationBatch.submit('beep', 's-1');

    expect(mockWmClear).toHaveBeenCalledWith('beep', 's-1');
    // Order: WM clear happens AFTER the batch was created.
    const submitOrder = mockBatchSubmit.mock.invocationCallOrder[0];
    const clearOrder = mockWmClear.mock.invocationCallOrder[0];
    expect(clearOrder).toBeGreaterThan(submitOrder);
  });

  it('a second submit before finalize is rejected by the inflight marker — acceptance (f)', async () => {
    await consolidationBatch.submit('beep', 's-1');
    mockRedisSet.mockResolvedValueOnce(null); // NX claim fails — already inflight

    const outcome = await consolidationBatch.submit('beep', 's-1');

    expect(outcome).toBe('inflight');
    expect(mockBatchSubmit).toHaveBeenCalledTimes(1); // no second batch → no duplicates
  });

  it('claims the marker with SET NX + TTL', async () => {
    await consolidationBatch.submit('beep', 's-1');
    expect(mockRedisSet).toHaveBeenCalledWith(
      'consolidation:batch:inflight:beep:s-1',
      expect.any(String),
      'EX',
      expect.any(Number),
      'NX'
    );
  });

  it('returns "empty" (and releases the marker) when there is nothing to consolidate', async () => {
    mockWmGetAll.mockResolvedValue([]);
    mockSbRead.mockResolvedValue([]);

    const outcome = await consolidationBatch.submit('beep', 's-1');

    expect(outcome).toBe('empty');
    expect(mockBatchSubmit).not.toHaveBeenCalled();
    expect(mockWmClear).not.toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalledWith('consolidation:batch:inflight:beep:s-1');
  });

  it('releases the marker and re-throws when batches.create fails (sync fallback unblocked)', async () => {
    mockBatchSubmit.mockRejectedValueOnce(new Error('api down'));

    await expect(consolidationBatch.submit('beep', 's-1')).rejects.toThrow('api down');

    expect(mockRedisDel).toHaveBeenCalledWith('consolidation:batch:inflight:beep:s-1');
    // WM must NOT be cleared when the submit failed — the sync fallback needs it.
    expect(mockWmClear).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAbstract — step-1 → step-2; acceptance (d) + (e)
// ---------------------------------------------------------------------------

describe('consolidationBatch.handleAbstract', () => {
  it('parses step-1 patterns strictly and submits step-2 with the memories schema', async () => {
    await consolidationBatch.handleAbstract(
      basePayload({
        resultText: JSON.stringify({
          patterns: [
            {
              type: 'error_chain',
              description: 'auth bug fixed after two failed searches',
              significance: 0.8,
              files: ['a.ts'],
            },
            { type: 'file_cluster', description: 'low signal', significance: 0.2, files: [] },
          ],
        }),
        batchId: 'batch_1',
      })
    );

    expect(mockBatchSubmit).toHaveBeenCalledTimes(1);
    const row = mockBatchSubmit.mock.calls[0][0].rows[0];
    expect(row.request.systemPrompt).toBe('ABSTRACTION_PROMPT');
    expect(row.request.jsonSchema).toEqual({ marker: 'memories-schema' });
    expect(row.request.effort).toBe('medium');
    // Significance filter applied (only the 0.8 pattern) + WM observation lines.
    expect(row.request.prompt).toContain('error_chain');
    expect(row.request.prompt).not.toContain('file_cluster');
    expect(row.request.prompt).toContain('[edit] fixed auth bug');
    expect(row.continuation.jobName).toBe('consolidation:finalize');
    expect(row.continuation.payload).toEqual(
      expect.objectContaining({ snapshot: SNAPSHOT, patternsDetected: 2 })
    );
  });

  it('NEVER re-reads the sensory buffer or working memory — acceptance (d)', async () => {
    await consolidationBatch.handleAbstract(
      basePayload({ resultText: JSON.stringify({ patterns: [] }) })
    );

    expect(mockSbRead).not.toHaveBeenCalled();
    expect(mockWmGetAll).not.toHaveBeenCalled();
  });

  it('REJECTS prose-wrapped JSON instead of regex-salvaging it — acceptance (e)', async () => {
    // The legacy Ollama path's parseJson would happily extract the {...}
    // from this string. The batch path must NOT — json_schema output is
    // strict JSON, so anything else is a malformed result → failure path.
    await consolidationBatch.handleAbstract(
      basePayload({ resultText: 'Sure! Here are your patterns: {"patterns": []}' })
    );

    expect(mockBatchSubmit).not.toHaveBeenCalled(); // no step-2
    // Terminal-failure path ran: WM restored from snapshot + sync fallback on snapshot.
    expect(mockWmInsert).toHaveBeenCalledTimes(WM_SLOTS.length);
    expect(mockConsolidateSnapshot).toHaveBeenCalledWith('beep', 's-1', SNAPSHOT);
  });

  it('rejects JSON whose root lacks the "patterns" array (schema-shape check)', async () => {
    await consolidationBatch.handleAbstract(
      basePayload({ resultText: JSON.stringify({ wrong: true }) })
    );

    expect(mockBatchSubmit).not.toHaveBeenCalled();
    expect(mockConsolidateSnapshot).toHaveBeenCalled();
  });

  it('finishes the run (clears marker, no step-2) when there is nothing to abstract', async () => {
    await consolidationBatch.handleAbstract(
      basePayload({
        snapshot: { ...SNAPSHOT, wmObservationLines: [] },
        resultText: JSON.stringify({ patterns: [] }),
      })
    );

    expect(mockBatchSubmit).not.toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalledWith('consolidation:batch:inflight:beep:s-1');
  });

  it('falls back to sync-on-snapshot when the step-2 submit throws', async () => {
    mockBatchSubmit.mockRejectedValueOnce(new Error('api down'));

    await consolidationBatch.handleAbstract(
      basePayload({
        resultText: JSON.stringify({
          patterns: [{ type: 'error_chain', description: 'x', significance: 0.9, files: [] }],
        }),
      })
    );

    expect(mockConsolidateSnapshot).toHaveBeenCalledWith('beep', 's-1', SNAPSHOT);
  });
});

// ---------------------------------------------------------------------------
// handleFinalize — step-2 → store/classify/anchor
// ---------------------------------------------------------------------------

describe('consolidationBatch.handleFinalize', () => {
  const MEMORIES = [
    {
      content: 'Decision: all route validation uses centralized Zod schemas.',
      subtype: 'decision',
      confidence: 0.9,
      tags: ['validation'],
      files: ['utils/validation.ts'],
      isEpisodic: false,
    },
  ];

  it('stores memories via consolidationAgent.storeAbstracted and clears the marker', async () => {
    await consolidationBatch.handleFinalize(
      basePayload({
        resultText: JSON.stringify({ memories: MEMORIES }),
        patternsDetected: 2,
      })
    );

    expect(mockNormalize).toHaveBeenCalledWith(MEMORIES);
    expect(mockStoreAbstracted).toHaveBeenCalledWith(
      'beep',
      's-1',
      MEMORIES,
      expect.objectContaining({
        result: expect.objectContaining({ patternsDetected: 2, totalEventsProcessed: 6 }),
      })
    );
    expect(mockRedisDel).toHaveBeenCalledWith('consolidation:batch:inflight:beep:s-1');
  });

  it('NEVER re-reads the sensory buffer or working memory — acceptance (d)', async () => {
    await consolidationBatch.handleFinalize(
      basePayload({ resultText: JSON.stringify({ memories: MEMORIES }) })
    );

    expect(mockSbRead).not.toHaveBeenCalled();
    expect(mockWmGetAll).not.toHaveBeenCalled();
  });

  it('routes malformed step-2 output to the failure path (no regex salvage) — acceptance (e)', async () => {
    await consolidationBatch.handleFinalize(
      basePayload({ resultText: '```json\n{"memories": []}\n```' })
    );

    expect(mockStoreAbstracted).not.toHaveBeenCalled();
    expect(mockWmInsert).toHaveBeenCalledTimes(WM_SLOTS.length);
    expect(mockConsolidateSnapshot).toHaveBeenCalledWith('beep', 's-1', SNAPSHOT);
  });
});

// ---------------------------------------------------------------------------
// handleTerminalFailure — acceptance (c): restore + sync fallback, no loss
// ---------------------------------------------------------------------------

describe('consolidationBatch.handleTerminalFailure', () => {
  it('restores the snapshot into WM (capacity policy via insert) then consolidates the SNAPSHOT sync', async () => {
    await consolidationBatch.handleTerminalFailure(
      basePayload({ reason: 'invalid_request: bad schema' })
    );

    // Every snapshot slot restored.
    expect(mockWmInsert).toHaveBeenCalledTimes(2);
    expect(mockWmInsert).toHaveBeenCalledWith('beep', 's-1', WM_SLOTS[0]);
    expect(mockWmInsert).toHaveBeenCalledWith('beep', 's-1', WM_SLOTS[1]);
    // Restore happens BEFORE the fallback run (data survives a fallback crash).
    expect(mockWmInsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockConsolidateSnapshot.mock.invocationCallOrder[0]
    );
    // Sync Ollama fallback runs ON THE SNAPSHOT (not on live buffers).
    expect(mockConsolidateSnapshot).toHaveBeenCalledWith('beep', 's-1', SNAPSHOT);
    // Fallback succeeded → restored WM cleared + marker released.
    expect(mockWmClear).toHaveBeenCalledWith('beep', 's-1');
    expect(mockRedisDel).toHaveBeenCalledWith('consolidation:batch:inflight:beep:s-1');
  });

  it('preserves the restored WM and re-throws when the sync fallback fails (BullMQ retry)', async () => {
    mockConsolidateSnapshot.mockRejectedValueOnce(new Error('ollama down'));

    await expect(
      consolidationBatch.handleTerminalFailure(basePayload({ reason: 'expired' }))
    ).rejects.toThrow('ollama down');

    expect(mockWmInsert).toHaveBeenCalledTimes(2); // restored…
    expect(mockWmClear).not.toHaveBeenCalled(); // …and NOT wiped — no memory loss
  });
});
