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

const mockBatchCreate = vi.hoisted(() => vi.fn());
const mockBatchRetrieve = vi.hoisted(() => vi.fn());
const mockBatchResults = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      batches: {
        create: mockBatchCreate,
        retrieve: mockBatchRetrieve,
        results: mockBatchResults,
      },
    };
    constructor(_opts: unknown) {}
  },
}));

const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetQueue = vi.hoisted(() => vi.fn(() => ({ add: mockQueueAdd })));
vi.mock('../../events/queues', () => ({
  getQueue: mockGetQueue,
}));

const mockUsageRecord = vi.hoisted(() => vi.fn());
vi.mock('../../services/llm-usage-logger', () => ({
  llmUsageLogger: { record: mockUsageRecord },
}));

const mockCounterInc = vi.hoisted(() => vi.fn());
const mockHistObserve = vi.hoisted(() => vi.fn());
vi.mock('../../utils/metrics', () => ({
  llmRequestsTotal: { inc: mockCounterInc },
  llmTokensUsed: { inc: mockCounterInc },
  llmDuration: { observe: mockHistObserve },
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import {
  anthropicBatch,
  recordBatchRowUsage,
  BATCH_INITIAL_POLL_DELAY_MS,
} from '../../services/anthropic-batch';

const SCHEMA = {
  type: 'object',
  properties: { patterns: { type: 'array' } },
  required: ['patterns'],
  additionalProperties: false,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    customId: 'row-1',
    request: {
      prompt: 'Session events:\nfoo',
      systemPrompt: 'detect patterns',
      maxTokens: 2000,
      jsonSchema: SCHEMA,
      effort: 'medium' as const,
    },
    continuation: {
      queue: 'session-lifecycle' as const,
      jobName: 'consolidation:abstract',
      payload: { projectName: 'beep', sessionId: 's-1' },
    },
    ...overrides,
  };
}

describe('anthropicBatch.buildParams', () => {
  it('builds json_schema structured output + effort, with NO sampling params and NO thinking', () => {
    const params = anthropicBatch.buildParams(row().request);

    expect(params.model).toBe('claude-opus-4-8');
    expect(params.max_tokens).toBe(2000);
    expect(params.system).toBe('detect patterns');
    expect(params.messages).toEqual([{ role: 'user', content: 'Session events:\nfoo' }]);
    expect(params.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    });
    // Sampling params 400 on current models; thinking intentionally omitted.
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
    expect(params).not.toHaveProperty('thinking');
  });

  it('falls back to config.CLAUDE_EFFORT and omits format without a schema', () => {
    const params = anthropicBatch.buildParams({ prompt: 'hi' });
    expect(params.output_config).toEqual({ effort: 'high' });
    expect(params.max_tokens).toBe(2000);
  });
});

describe('anthropicBatch.submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchCreate.mockResolvedValue({ id: 'batch_abc', processing_status: 'in_progress' });
  });

  it('creates the batch via client.messages.batches.create and schedules the first poll at 60s', async () => {
    const { batchId } = await anthropicBatch.submit({
      caller: 'consolidation',
      projectName: 'beep',
      rows: [row()],
    });

    expect(batchId).toBe('batch_abc');
    expect(mockBatchCreate).toHaveBeenCalledWith({
      requests: [
        { custom_id: 'row-1', params: expect.objectContaining({ model: 'claude-opus-4-8' }) },
      ],
    });

    expect(mockGetQueue).toHaveBeenCalledWith('llm-batch');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'batch:poll',
      expect.objectContaining({
        batchId: 'batch_abc',
        caller: 'consolidation',
        projectName: 'beep',
        pollDelayMs: BATCH_INITIAL_POLL_DELAY_MS,
        rows: [expect.objectContaining({ customId: 'row-1', attempts: 1 })],
      }),
      expect.objectContaining({ delay: BATCH_INITIAL_POLL_DELAY_MS })
    );
    // batchId is persisted in the poll envelope (Redis-flush recovery).
    const pollData = mockQueueAdd.mock.calls[0][1];
    expect(pollData.submittedAt).toEqual(expect.any(String));
  });

  it('preserves explicit attempts on resubmitted rows', async () => {
    await anthropicBatch.submit({
      caller: 'consolidation',
      rows: [{ ...row(), attempts: 2 }],
    });
    const pollData = mockQueueAdd.mock.calls[0][1];
    expect(pollData.rows[0].attempts).toBe(2);
  });

  it('propagates batches.create failures (caller owns the fallback)', async () => {
    mockBatchCreate.mockRejectedValueOnce(new Error('api down'));
    await expect(anthropicBatch.submit({ caller: 'consolidation', rows: [row()] })).rejects.toThrow(
      'api down'
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects an empty row list', async () => {
    await expect(anthropicBatch.submit({ caller: 'consolidation', rows: [] })).rejects.toThrow(
      /zero rows/
    );
  });
});

describe('recordBatchRowUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records usage with batch:true and the caller (M1 plumbing)', () => {
    recordBatchRowUsage({
      model: 'claude-opus-4-8',
      usage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 10 },
      durationMs: 1234,
      caller: 'consolidation',
      projectName: 'beep',
    });

    expect(mockUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        promptTokens: 100,
        completionTokens: 50,
        cacheReadTokens: 10,
        caller: 'consolidation',
        projectName: 'beep',
        batch: true,
      })
    );
  });

  it('records failures with success:false and batch:true', () => {
    recordBatchRowUsage({
      model: 'claude-opus-4-8',
      durationMs: 99,
      caller: 'consolidation',
      success: false,
      error: 'expired',
    });

    expect(mockUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ batch: true, success: false, error: 'expired' })
    );
  });
});
