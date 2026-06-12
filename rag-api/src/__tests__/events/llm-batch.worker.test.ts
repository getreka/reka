import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('../../config', () => ({
  default: {
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_MODEL: 'claude-opus-4-8',
    CLAUDE_EFFORT: 'high',
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCreateWorker = vi.hoisted(() => vi.fn());
const mockQueueAdds = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const mockGetQueue = vi.hoisted(() =>
  vi.fn((name: string) => {
    if (!mockQueueAdds.has(name)) {
      mockQueueAdds.set(name, vi.fn().mockResolvedValue(undefined));
    }
    return { add: mockQueueAdds.get(name)! };
  })
);
vi.mock('../../events/queues', () => ({
  createWorker: mockCreateWorker,
  getQueue: mockGetQueue,
}));

const mockRetrieve = vi.hoisted(() => vi.fn());
const mockResults = vi.hoisted(() => vi.fn());
const mockSubmit = vi.hoisted(() => vi.fn().mockResolvedValue({ batchId: 'batch_resub' }));
const mockEnqueuePoll = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRecordUsage = vi.hoisted(() => vi.fn());
vi.mock('../../services/anthropic-batch', () => ({
  anthropicBatch: {
    retrieve: mockRetrieve,
    results: mockResults,
    submit: mockSubmit,
    enqueuePoll: mockEnqueuePoll,
  },
  recordBatchRowUsage: mockRecordUsage,
  BATCH_INITIAL_POLL_DELAY_MS: 60_000,
  BATCH_MAX_POLL_DELAY_MS: 300_000,
  BATCH_HARD_STOP_MS: 24 * 60 * 60 * 1000,
  BATCH_MAX_ROW_ATTEMPTS: 3,
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import { processLlmBatchJob, startLlmBatchWorker } from '../../events/workers/llm-batch.worker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelopeRow(overrides: Record<string, unknown> = {}) {
  return {
    customId: 'row-1',
    request: { prompt: 'p', systemPrompt: 's', maxTokens: 2000 },
    continuation: {
      queue: 'session-lifecycle',
      jobName: 'consolidation:abstract',
      payload: { projectName: 'beep', sessionId: 's-1' },
    },
    failureContinuation: {
      queue: 'session-lifecycle',
      jobName: 'consolidation:batch-failed',
      payload: { projectName: 'beep', sessionId: 's-1' },
    },
    attempts: 1,
    ...overrides,
  };
}

function pollJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'batch:poll',
    data: {
      batchId: 'batch_abc',
      caller: 'consolidation',
      projectName: 'beep',
      submittedAt: new Date().toISOString(),
      pollDelayMs: 60_000,
      rows: [envelopeRow()],
      ...overrides,
    },
  };
}

function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function succeededResult(customId = 'row-1', text = '{"patterns": []}') {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded',
      message: {
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  };
}

const lifecycleAdd = () => mockQueueAdds.get('session-lifecycle')!;
const dlqAdd = () => mockQueueAdds.get('dead-letter')!;

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueAdds.clear();
  // Pre-create the queue mocks so assertions on "not called" work.
  mockGetQueue('session-lifecycle');
  mockGetQueue('dead-letter');
  mockGetQueue('llm-batch');
  mockSubmit.mockResolvedValue({ batchId: 'batch_resub' });
});

// ---------------------------------------------------------------------------
// Poll re-enqueue + cap
// ---------------------------------------------------------------------------

describe('processLlmBatchJob — polling', () => {
  it('re-enqueues itself with a DOUBLED delay while the batch is in_progress', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'in_progress' });

    await processLlmBatchJob(pollJob());

    expect(mockEnqueuePoll).toHaveBeenCalledTimes(1);
    const [data, delay] = mockEnqueuePoll.mock.calls[0];
    expect(delay).toBe(120_000);
    expect(data.pollDelayMs).toBe(120_000);
    expect(data.batchId).toBe('batch_abc');
    expect(mockResults).not.toHaveBeenCalled();
  });

  it('caps the re-enqueue delay at 300s', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'in_progress' });

    await processLlmBatchJob(pollJob({ pollDelayMs: 300_000 }));

    const [data, delay] = mockEnqueuePoll.mock.calls[0];
    expect(delay).toBe(300_000);
    expect(data.pollDelayMs).toBe(300_000);
  });

  it('also re-polls while the batch is canceling (not yet ended)', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'canceling' });

    await processLlmBatchJob(pollJob());

    expect(mockEnqueuePoll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 24h hard stop
// ---------------------------------------------------------------------------

describe('processLlmBatchJob — 24h hard stop', () => {
  const STALE = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  it('treats a non-ended batch past 24h as expired and resubmits rows (attempts < 3)', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'in_progress' });

    await processLlmBatchJob(pollJob({ submittedAt: STALE }));

    expect(mockEnqueuePoll).not.toHaveBeenCalled(); // poll chain stops
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: 'consolidation',
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 2 })],
      })
    );
  });

  it('terminally fails rows past 24h that exhausted their attempts (DLQ + failure continuation)', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'in_progress' });

    await processLlmBatchJob(pollJob({ submittedAt: STALE, rows: [envelopeRow({ attempts: 3 })] }));

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(dlqAdd()).toHaveBeenCalledWith(
      'dlq:llm-batch:row',
      expect.objectContaining({ batchId: 'batch_abc', customId: 'row-1' })
    );
    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:batch-failed',
      expect.objectContaining({
        projectName: 'beep',
        sessionId: 's-1',
        batchId: 'batch_abc',
        reason: expect.stringContaining('attempts exhausted'),
      }),
      expect.any(Object)
    );
  });

  it('still processes results normally when the batch ENDED past the hard stop', async () => {
    mockRetrieve.mockResolvedValue({ processing_status: 'ended' });
    mockResults.mockResolvedValue(asAsyncIterable([succeededResult()]));

    await processLlmBatchJob(pollJob({ submittedAt: STALE }));

    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:abstract',
      expect.objectContaining({ resultText: '{"patterns": []}' }),
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// Result dispatch — all 4 result types
// ---------------------------------------------------------------------------

describe('processLlmBatchJob — ended batch result types', () => {
  beforeEach(() => {
    mockRetrieve.mockResolvedValue({ processing_status: 'ended' });
  });

  it('succeeded → records usage (batch:true caller plumbing) and enqueues the continuation named in the envelope', async () => {
    mockResults.mockResolvedValue(asAsyncIterable([succeededResult()]));

    await processLlmBatchJob(pollJob());

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-8',
        caller: 'consolidation',
        projectName: 'beep',
        usage: expect.objectContaining({ promptTokens: 120, completionTokens: 40 }),
      })
    );
    // Continuation carries the original payload + batchId (Redis-flush recovery) + result text.
    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:abstract',
      expect.objectContaining({
        projectName: 'beep',
        sessionId: 's-1',
        batchId: 'batch_abc',
        customId: 'row-1',
        resultText: '{"patterns": []}',
      }),
      expect.any(Object)
    );
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(dlqAdd()).not.toHaveBeenCalled();
  });

  it('errored invalid_request → DLQ no-retry + failure continuation, NEVER resubmitted', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([
        {
          custom_id: 'row-1',
          result: {
            type: 'errored',
            error: {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'bad schema' },
            },
          },
        },
      ])
    );

    await processLlmBatchJob(pollJob());

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(dlqAdd()).toHaveBeenCalledWith(
      'dlq:llm-batch:row',
      expect.objectContaining({
        customId: 'row-1',
        reason: expect.stringContaining('invalid_request'),
      })
    );
    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:batch-failed',
      expect.objectContaining({ reason: expect.stringContaining('invalid_request') }),
      expect.any(Object)
    );
  });

  it('errored server-side (overloaded) → resubmits the row with attempts+1', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([
        {
          custom_id: 'row-1',
          result: {
            type: 'errored',
            error: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
          },
        },
      ])
    );

    await processLlmBatchJob(pollJob());

    expect(dlqAdd()).not.toHaveBeenCalled();
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 2 })],
      })
    );
  });

  it('canceled → resubmits the row (attempts ≤ 3)', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([{ custom_id: 'row-1', result: { type: 'canceled' } }])
    );

    await processLlmBatchJob(pollJob());

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 2 })],
      })
    );
  });

  it('expired → resubmits the row (attempts ≤ 3)', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([{ custom_id: 'row-1', result: { type: 'expired' } }])
    );

    await processLlmBatchJob(pollJob());

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 2 })],
      })
    );
  });

  it('expired with attempts exhausted → terminal failure (DLQ + failure continuation)', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([{ custom_id: 'row-1', result: { type: 'expired' } }])
    );

    await processLlmBatchJob(pollJob({ rows: [envelopeRow({ attempts: 3 })] }));

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(dlqAdd()).toHaveBeenCalled();
    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:batch-failed',
      expect.objectContaining({ reason: expect.stringContaining('expired') }),
      expect.any(Object)
    );
  });

  it('handles a mixed batch: succeeded + invalid_request + retryable in one pass', async () => {
    mockResults.mockResolvedValue(
      asAsyncIterable([
        succeededResult('row-ok'),
        {
          custom_id: 'row-bad',
          result: {
            type: 'errored',
            error: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } },
          },
        },
        { custom_id: 'row-retry', result: { type: 'expired' } },
      ])
    );

    await processLlmBatchJob(
      pollJob({
        rows: [
          envelopeRow({ customId: 'row-ok' }),
          envelopeRow({ customId: 'row-bad' }),
          envelopeRow({ customId: 'row-retry' }),
        ],
      })
    );

    expect(lifecycleAdd()).toHaveBeenCalledWith(
      'consolidation:abstract',
      expect.objectContaining({ customId: 'row-ok' }),
      expect.any(Object)
    );
    expect(dlqAdd()).toHaveBeenCalledWith(
      'dlq:llm-batch:row',
      expect.objectContaining({ customId: 'row-bad' })
    );
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ customId: 'row-retry', attempts: 2 })],
      })
    );
  });

  it('treats rows missing from the results stream as expired (defensive)', async () => {
    mockResults.mockResolvedValue(asAsyncIterable([]));

    await processLlmBatchJob(pollJob());

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 2 })],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------

describe('startLlmBatchWorker', () => {
  it('registers a worker on the llm-batch queue with concurrency 1', () => {
    startLlmBatchWorker();
    expect(mockCreateWorker).toHaveBeenCalledWith('llm-batch', expect.any(Function), {
      concurrency: 1,
    });
  });
});
