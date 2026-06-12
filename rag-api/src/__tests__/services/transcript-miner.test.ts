import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  embedBatch: vi.fn(),
}));

vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: { ingest: mocks.ingest },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embedBatch: mocks.embedBatch },
}));

import { transcriptMiner } from '../../services/transcript-miner';

// ---------------------------------------------------------------------------
// JSONL fixture builders — mirror the real Claude Code transcript shape:
// {type, message: {role, content: string | blocks[]}, isMeta?, timestamp,
//  uuid, sessionId, ...}
// ---------------------------------------------------------------------------

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u-1',
    timestamp: '2026-06-12T10:00:00.000Z',
    sessionId: 'sess-fixture',
    cwd: '/project',
    ...extra,
  });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid: 'a-1',
    sessionId: 'sess-fixture',
  });
}

function jsonl(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

const LONG_PAD =
  ' — this sentence pads the turn well past the eighty character minimum for embedding.';

describe('transcriptMiner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Persisted by default (no metadata.skipped).
    mocks.ingest.mockImplementation(async (opts: any) => ({
      id: 'mem-1',
      type: opts.type,
      content: opts.content,
      tags: opts.tags,
      createdAt: '',
      updatedAt: '',
      metadata: {},
    }));
    // Default: every text gets an orthogonal one-hot vector → no clusters.
    mocks.embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => {
        const v = new Array(64).fill(0);
        v[i % 64] = 1;
        return v;
      })
    );
  });

  it('keeps real user turns only and tolerates unparseable (truncated) lines', async () => {
    const transcript = jsonl(
      JSON.stringify({ type: 'mode', mode: 'default', sessionId: 's' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: {} }),
      assistantLine('I did the thing.'),
      userLine('<system-reminder>injected context</system-reminder> plus text'),
      userLine(
        '<task-notification>\n<task-id>abc123</task-id>\nЗапамʼятай: background task finished\n</task-notification>'
      ),
      userLine(
        '<local-command-caveat>Caveat: messages below were generated during local commands.</local-command-caveat>\n<bash-stdout>ok</bash-stdout>'
      ),
      userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'stdout' }]),
      userLine('real human question about the build', { isMeta: true }),
      userLine('   '),
      userLine('a real human turn'),
      userLine([{ type: 'text', text: 'a second human turn, as a text block' }]),
      // tail-truncated mid-line — the client may cut anywhere
      '{"type":"user","message":{"role":"user","content":"trunca'
    );

    const result = await transcriptMiner.mine({
      transcript,
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.linesTotal).toBe(12);
    expect(result.linesUnparseable).toBe(1);
    expect(result.userTexts).toBe(2);
    expect(result.candidates).toBe(0);
    expect(result.ingested).toBe(0);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('explicit_save matches EN and UK phrases incl. apostrophe variants', async () => {
    const transcript = jsonl(
      userLine('Remember this: rotate the npm token after every release.'),
      userLine('Запамʼятай: ключі зберігаються в data/keys.json, формат rk_{project}_{hex}.'),
      userLine('Збережи в память — Redis у Docker працює на порту 6380, не 6379.'),
      userLine('just a normal question about tests')
    );

    const result = await transcriptMiner.mine({
      transcript,
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.byRule.explicit_save).toBe(3);
    expect(result.candidates).toBe(3);
    expect(result.ingested).toBe(3);
    expect(mocks.ingest).toHaveBeenCalledTimes(3);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'proj',
        type: 'context',
        tags: ['transcript', 'explicit_save'],
        source: 'auto_transcript',
        confidence: 0.9,
        content: 'Remember this: rotate the npm token after every release.',
        metadata: expect.objectContaining({
          sessionId: 'sess-1',
          rule: 'explicit_save',
          capturedAt: expect.any(String),
        }),
      })
    );
  });

  it('correction matches only at turn start and only past the junk guard', async () => {
    const transcript = jsonl(
      userLine('Actually, the BGE-M3 batch endpoint is /embed/batch, not /embed_batch.'),
      userLine('Неправильно — Qdrant range filter потребує числові поля, не ISO-рядки.'),
      userLine('ні, не так'), // marker but < 40 chars → junk guard drops it
      userLine('The docs say no, but mid-sentence markers must not trigger corrections at all.')
    );

    const result = await transcriptMiner.mine({
      transcript,
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.byRule.correction).toBe(2);
    expect(result.candidates).toBe(2);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['transcript', 'correction'],
        confidence: 0.65,
      })
    );
  });

  it('repeated_explanation clusters similar turns and keeps the LATER text once', async () => {
    const explainA1 = `The worker must re-throw on failure so BullMQ retries the consolidation job${LONG_PAD}`;
    const unrelated = `Please walk me through how the dashboard renders the quarantine queue table${LONG_PAD}`;
    const explainA2 = `Again: consolidation retries only happen when the worker re-throws the error${LONG_PAD}`;
    const tooShort = 'worker must re-throw, remember the retries'; // < 80 → never embedded

    mocks.embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map((t) => (t.includes('re-throw') || t.includes('retries') ? [1, 0] : [0, 1]))
    );

    const transcript = jsonl(
      userLine(explainA1),
      userLine(unrelated),
      userLine(explainA2),
      userLine(tooShort)
    );

    const result = await transcriptMiner.mine({
      transcript,
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    // Only the >=80-char texts are embedded, in turn order.
    expect(mocks.embedBatch).toHaveBeenCalledWith([explainA1, unrelated, explainA2]);
    expect(result.byRule.repeated_explanation).toBe(1);
    expect(result.candidates).toBe(1);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        content: explainA2, // the LATER turn wins
        tags: ['transcript', 'repeated_explanation'],
        confidence: 0.6,
      })
    );
  });

  it('a verbatim re-paste of the same short command is not a repeated explanation', async () => {
    const command =
      'run the docker compose stack and tail the rag-api logs until healthy please right now';
    expect(command.length).toBeGreaterThanOrEqual(80);
    expect(command.length).toBeLessThan(120);
    // Identical texts embed identically → cosine 1, but the re-paste guard drops the pair.
    mocks.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]));

    const result = await transcriptMiner.mine({
      transcript: jsonl(userLine(command), userLine(command)),
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.candidates).toBe(0);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('dedupes a turn matching several rules, keeping the higher confidence', async () => {
    const transcript = jsonl(
      userLine('Actually, remember this: docker prod runs qwen3.5:9b — never deploy the 27b there.')
    );

    const result = await transcriptMiner.mine({
      transcript,
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.candidates).toBe(1);
    expect(result.byRule).toEqual({ explicit_save: 1, correction: 0, repeated_explanation: 0 });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0.9 }));
  });

  it('caps candidates at 20 per capture, highest confidence first', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(userLine(`No, the port for service number ${i} is wrong — it should be 310${i}.`));
    }
    for (let i = 0; i < 18; i++) {
      lines.push(userLine(`Remember this fact number ${i}: distinct content ${i}.`));
    }

    const result = await transcriptMiner.mine({
      transcript: jsonl(...lines),
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.candidates).toBe(20);
    expect(result.ingested).toBe(20);
    // All 18 explicit_save (0.9) survive; only 2 of 5 corrections (0.65) fit.
    expect(result.byRule).toEqual({ explicit_save: 18, correction: 2, repeated_explanation: 0 });
    expect(mocks.ingest).toHaveBeenCalledTimes(20);
  });

  it('caps each candidate at 1200 chars', async () => {
    const huge = 'Remember this: ' + 'x'.repeat(3000);

    await transcriptMiner.mine({
      transcript: jsonl(userLine(huge)),
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    const content = mocks.ingest.mock.calls[0][0].content as string;
    expect(content.length).toBe(1200);
  });

  it('considers only the first 500 user texts', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(userLine(`plain turn ${i}`));
    }
    lines.push(userLine('Remember this: a fact arriving after the consideration cap.'));

    const result = await transcriptMiner.mine({
      transcript: jsonl(...lines),
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.userTexts).toBe(500);
    expect(result.candidates).toBe(0);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('counts governance threshold drops as skippedBelowThreshold', async () => {
    mocks.ingest.mockImplementation(async (opts: any) => ({
      id: 'mem-x',
      type: opts.type,
      content: opts.content,
      tags: opts.tags,
      createdAt: '',
      updatedAt: '',
      metadata: opts.content.includes('DROPME') ? { skipped: true, reason: 'below_threshold' } : {},
    }));

    const result = await transcriptMiner.mine({
      transcript: jsonl(
        userLine('Remember this: a keeper fact about the build pipeline.'),
        userLine('Remember this: DROPME a low-value fact the gate rejects.')
      ),
      projectName: 'proj',
      sessionId: 'sess-1',
    });

    expect(result.candidates).toBe(2);
    expect(result.ingested).toBe(1);
    expect(result.skippedBelowThreshold).toBe(1);
  });
});
