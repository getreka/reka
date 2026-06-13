import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  default: {
    CONSOLIDATION_TIMEOUT_MS: 120000,
    CONSOLIDATION_LLM_TIMEOUT_MS: 30000,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockComplete = vi.hoisted(() => vi.fn());
vi.mock('../../services/llm', () => ({
  llm: { completeWithBestProvider: mockComplete },
}));

const mockWmGetAll = vi.hoisted(() => vi.fn());
vi.mock('../../services/working-memory', () => ({
  workingMemory: { getAll: mockWmGetAll },
}));

const mockSbRead = vi.hoisted(() => vi.fn());
const mockSbAppend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/sensory-buffer', () => ({
  sensoryBuffer: { read: mockSbRead, append: mockSbAppend },
}));

const mockStoreEpisodic = vi.hoisted(() => vi.fn());
const mockStoreSemantic = vi.hoisted(() => vi.fn());
vi.mock('../../services/memory-ltm', () => ({
  memoryLtm: {
    storeEpisodic: mockStoreEpisodic,
    storeSemantic: mockStoreSemantic,
  },
}));

const mockClassify = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../services/relationship-classifier', () => ({
  relationshipClassifier: { classify: mockClassify },
}));

const mockVsSearch = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../services/vector-store', () => ({
  vectorStore: { search: mockVsSearch },
}));

const mockEmbed = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mockEmbed },
}));

const mockIndexMemoryEdges = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../services/graph-store', () => ({
  graphStore: { indexMemoryEdges: mockIndexMemoryEdges },
}));

import {
  consolidationAgent,
  ConsolidationFailedError,
  type AbstractedMemory,
  type ConsolidationSnapshot,
} from '../../services/consolidation-agent';

// A working-memory slot / sensory event batch large enough to trigger LLM steps.
function busySession() {
  mockWmGetAll.mockResolvedValue([
    { toolName: 'search', content: 'how does auth work', salience: 0.8, files: ['a.ts'] },
    { toolName: 'edit', content: 'fixed auth bug', salience: 0.9, files: ['a.ts'] },
  ]);
  mockSbRead.mockResolvedValue([
    { toolName: 'search', inputSummary: 'auth', durationMs: 10, success: true },
    { toolName: 'edit', inputSummary: 'auth.ts', durationMs: 20, success: true },
    { toolName: 'test', inputSummary: 'run', durationMs: 30, success: true },
  ]);
}

describe('ConsolidationAgentService.consolidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSbAppend.mockResolvedValue(undefined);
  });

  it('returns a successful (no-throw) empty result when there is nothing to consolidate', async () => {
    mockWmGetAll.mockResolvedValue([]);
    mockSbRead.mockResolvedValue([]);

    const result = await consolidationAgent.consolidate('proj', 'sess');

    expect(result.episodic).toHaveLength(0);
    expect(result.semantic).toHaveLength(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('THROWS ConsolidationFailedError when the LLM pattern-detection call fails', async () => {
    busySession();
    mockComplete.mockRejectedValue(new Error('ollama down'));

    await expect(consolidationAgent.consolidate('proj', 'sess')).rejects.toBeInstanceOf(
      ConsolidationFailedError
    );
  });

  it('enforces CONSOLIDATION_LLM_TIMEOUT_MS via a local race (hung LLM → throw)', async () => {
    busySession();
    // LLM never resolves → the local timeout race must reject.
    mockComplete.mockImplementation(() => new Promise(() => {}));

    await expect(
      consolidationAgent.consolidate('proj', 'sess', { timeout: 20 })
    ).rejects.toBeInstanceOf(ConsolidationFailedError);
  });

  it('returns no patterns when WM + events < 3 items (skips the pattern-detection LLM call)', async () => {
    // Two total items (< 3) → detectPatterns short-circuits, but abstraction still
    // runs off the salient WM slot, so we mock a single abstraction LLM call.
    mockWmGetAll.mockResolvedValue([
      { toolName: 'edit', content: 'fixed auth bug', salience: 0.9, files: ['a.ts'] },
    ]);
    mockSbRead.mockResolvedValue([
      { toolName: 'search', inputSummary: 'auth', durationMs: 10, success: true },
    ]);
    mockComplete.mockResolvedValueOnce({ text: JSON.stringify({ memories: [] }) });
    mockStoreSemantic.mockImplementation(async (o: any) => ({ id: 'sem-1', content: o.content }));

    const result = await consolidationAgent.consolidate('proj', 'sess');

    // Exactly one LLM call (abstraction) — pattern detection was skipped.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.patternsDetected).toBe(0);
  });

  it('feeds a significant detected pattern into the abstraction observations', async () => {
    busySession();
    mockComplete
      // Pattern detection returns one significant + one below-threshold pattern.
      .mockResolvedValueOnce({
        text: JSON.stringify({
          patterns: [
            {
              type: 'error_chain',
              description: 'auth failed then was fixed',
              significance: 0.9,
              files: ['auth.ts'],
            },
            { type: 'file_cluster', description: 'noise', significance: 0.2, files: [] },
          ],
        }),
      })
      .mockResolvedValueOnce({ text: JSON.stringify({ memories: [] }) });
    mockStoreSemantic.mockImplementation(async (o: any) => ({ id: 'sem-1', content: o.content }));

    const result = await consolidationAgent.consolidate('proj', 'sess');

    expect(result.patternsDetected).toBe(2);
    // The abstraction prompt (2nd LLM call) must include the significant pattern line.
    const abstractionPrompt = mockComplete.mock.calls[1][0] as string;
    expect(abstractionPrompt).toContain('PATTERN: error_chain');
    expect(abstractionPrompt).not.toContain('file_cluster'); // below-0.5 filtered out
  });

  it('skips the abstraction LLM call entirely when there is nothing to abstract', async () => {
    // Zero WM slots but 3 events (enough for pattern detection); pattern
    // detection finds nothing → abstract([], []) early-returns WITHOUT a
    // second LLM call.
    mockWmGetAll.mockResolvedValue([]);
    mockSbRead.mockResolvedValue([
      { toolName: 'read', inputSummary: 'a', durationMs: 5, success: true },
      { toolName: 'read', inputSummary: 'b', durationMs: 5, success: true },
      { toolName: 'read', inputSummary: 'c', durationMs: 5, success: true },
    ]);
    // Only the pattern-detection call is queued — it returns no patterns.
    mockComplete.mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) });

    const result = await consolidationAgent.consolidate('proj', 'sess');

    // Exactly one LLM call — abstraction was skipped (no WM slots, no patterns).
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.semantic).toHaveLength(0);
    expect(result.episodic).toHaveLength(0);
  });

  it('skips abstraction when WM slots exist but none are salient and no patterns fire', async () => {
    // A below-0.5 WM slot + 3 events; pattern detection finds nothing → the
    // observations string is empty so abstractFromObservations is never called.
    mockWmGetAll.mockResolvedValue([
      { toolName: 'read', content: 'just looked at a file', salience: 0.1, files: [] },
    ]);
    mockSbRead.mockResolvedValue([
      { toolName: 'read', inputSummary: 'a', durationMs: 5, success: true },
      { toolName: 'read', inputSummary: 'b', durationMs: 5, success: true },
      { toolName: 'read', inputSummary: 'c', durationMs: 5, success: true },
    ]);
    mockComplete.mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) });

    const result = await consolidationAgent.consolidate('proj', 'sess');

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.semantic).toHaveLength(0);
  });

  it('treats brace-matching-but-invalid JSON from the LLM as no patterns (parseJson catch)', async () => {
    busySession();
    // The regex finds a {...} block, but JSON.parse throws → parseJson returns null.
    mockComplete
      .mockResolvedValueOnce({ text: 'prefix {not: valid, json} suffix' })
      .mockResolvedValueOnce({ text: JSON.stringify({ memories: [] }) });

    const result = await consolidationAgent.consolidate('proj', 'sess');

    // Pattern detection salvaged nothing; abstraction still ran off WM slots.
    expect(result.patternsDetected).toBe(0);
  });

  describe('episodic vs semantic routing (abstraction step)', () => {
    // Queue the two LLM calls consolidate() makes: pattern detection, then abstraction.
    function mockLlmAbstraction(memories: unknown[]) {
      mockComplete
        .mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) })
        .mockResolvedValueOnce({ text: JSON.stringify({ memories }) });
    }

    beforeEach(() => {
      busySession();
      mockStoreEpisodic.mockImplementation(async (opts: any) => ({
        id: 'ep-1',
        content: opts.content,
        sessionId: opts.sessionId,
      }));
      mockStoreSemantic.mockImplementation(async (opts: any) => ({
        id: 'sem-1',
        content: opts.content,
        subtype: opts.subtype,
      }));
    });

    it('stores isEpisodic:true memories via memoryLtm.storeEpisodic and populates result.episodic', async () => {
      mockLlmAbstraction([
        {
          content:
            'Build failed with ECONNREFUSED to Qdrant; restarting docker-compose fixed it after pruning the network.',
          subtype: 'insight',
          confidence: 0.8,
          tags: ['incident'],
          files: ['docker/docker-compose.yml'],
          isEpisodic: true,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreEpisodic).toHaveBeenCalledTimes(1);
      expect(mockStoreEpisodic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'proj',
          sessionId: 'sess',
          content: expect.stringContaining('ECONNREFUSED'),
        })
      );
      expect(mockStoreSemantic).not.toHaveBeenCalled();
      expect(result.episodic).toHaveLength(1);
      expect(result.episodic[0]).toEqual({
        id: 'ep-1',
        content: expect.stringContaining('ECONNREFUSED'),
      });
      expect(result.semantic).toHaveLength(0);
    });

    it('stores isEpisodic:false memories via memoryLtm.storeSemantic and populates result.semantic', async () => {
      mockLlmAbstraction([
        {
          content: 'The BGE-M3 batch endpoint is /embed/batch, not /embed_batch.',
          subtype: 'insight',
          confidence: 0.9,
          tags: ['api'],
          files: [],
          isEpisodic: false,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(mockStoreSemantic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'proj',
          subtype: 'insight',
          source: 'consolidation',
        })
      );
      expect(mockStoreEpisodic).not.toHaveBeenCalled();
      expect(result.semantic).toHaveLength(1);
      expect(result.semantic[0].id).toBe('sem-1');
      expect(result.episodic).toHaveLength(0);
    });

    it('defaults a missing isEpisodic field to false (semantic path, ?? false fallback)', async () => {
      mockLlmAbstraction([
        {
          content: 'All route validation uses centralized Zod schemas in utils/validation.ts.',
          subtype: 'decision',
          confidence: 0.7,
          tags: [],
          files: [],
          // isEpisodic intentionally omitted
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(mockStoreEpisodic).not.toHaveBeenCalled();
      expect(result.semantic).toHaveLength(1);
      expect(result.episodic).toHaveLength(0);
    });

    it('routes a mixed batch to both stores in one consolidate() run', async () => {
      mockLlmAbstraction([
        {
          content:
            'Deploy hung: tag pushed before lockfile sync; regenerated lockfile and re-tagged.',
          subtype: 'insight',
          confidence: 0.8,
          tags: ['release'],
          files: [],
          isEpisodic: true,
        },
        {
          content: 'Decision: lockfiles must be generated with npm 10 to keep CI npm ci green.',
          subtype: 'decision',
          confidence: 0.9,
          tags: ['ci'],
          files: [],
          isEpisodic: false,
        },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreEpisodic).toHaveBeenCalledTimes(1);
      expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
      expect(result.episodic).toHaveLength(1);
      expect(result.semantic).toHaveLength(1);
    });

    it('cross-links the episodic memory to its anchor files in the graph', async () => {
      mockLlmAbstraction([
        {
          content: 'Touched src/auth.ts during the fix.',
          subtype: 'insight',
          confidence: 0.8,
          tags: [],
          files: ['src/auth.ts'],
          isEpisodic: true,
        },
      ]);

      await consolidationAgent.consolidate('proj', 'sess');

      // Anchor extraction picks up the explicit file → graph edge indexed for it.
      expect(mockIndexMemoryEdges).toHaveBeenCalledWith(
        'proj',
        'ep-1',
        'episodic',
        expect.arrayContaining(['src/auth.ts'])
      );
    });

    it('skips a too-short / blank abstraction item (normalizeAbstracted >10-char filter)', async () => {
      mockLlmAbstraction([
        { content: 'too short', subtype: 'insight', confidence: 0.8, tags: [], files: [] },
      ]);

      const result = await consolidationAgent.consolidate('proj', 'sess');

      expect(mockStoreEpisodic).not.toHaveBeenCalled();
      expect(mockStoreSemantic).not.toHaveBeenCalled();
      expect(result.semantic).toHaveLength(0);
    });
  });
});

// ── normalizeAbstracted — shared sync + batch validation ────

describe('ConsolidationAgentService.normalizeAbstracted', () => {
  it('drops items with no content or content <= 10 chars', () => {
    const out = consolidationAgent.normalizeAbstracted([
      {
        content: 'short',
        subtype: 'insight',
        confidence: 0.5,
        tags: [],
        files: [],
        isEpisodic: false,
      },
      { content: '', subtype: 'insight', confidence: 0.5, tags: [], files: [], isEpisodic: false },
      {
        content: 'this one is definitely long enough to keep',
        subtype: 'insight',
        confidence: 0.5,
        tags: [],
        files: [],
        isEpisodic: false,
      },
    ] as AbstractedMemory[]);

    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('long enough');
  });

  it('coerces an invalid subtype to "insight" and clamps confidence to [0,1]', () => {
    const out = consolidationAgent.normalizeAbstracted([
      {
        content: 'a sufficiently long content string here',
        subtype: 'nonsense' as any,
        confidence: 5,
        tags: [],
        files: [],
        isEpisodic: false,
      },
      {
        content: 'another sufficiently long content string',
        subtype: 'decision',
        confidence: -2,
        tags: [],
        files: [],
        isEpisodic: false,
      },
    ] as AbstractedMemory[]);

    expect(out[0].subtype).toBe('insight');
    expect(out[0].confidence).toBe(1);
    expect(out[1].subtype).toBe('decision');
    expect(out[1].confidence).toBe(0);
  });

  it('caps tags at 10 and files at 20, and truncates content to 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const out = consolidationAgent.normalizeAbstracted([
      {
        content: longContent,
        subtype: 'pattern',
        confidence: 0.6,
        tags: Array.from({ length: 25 }, (_, i) => `t${i}`),
        files: Array.from({ length: 30 }, (_, i) => `f${i}.ts`),
        isEpisodic: false,
      },
    ] as AbstractedMemory[]);

    expect(out[0].content).toHaveLength(2000);
    expect(out[0].tags).toHaveLength(10);
    expect(out[0].files).toHaveLength(20);
  });

  it('defaults non-array tags/files to [] and confidence to 0.6', () => {
    const out = consolidationAgent.normalizeAbstracted([
      {
        content: 'a sufficiently long content string for the filter',
        subtype: 'insight',
        // confidence omitted, tags/files not arrays
        tags: undefined as any,
        files: 'not-an-array' as any,
        isEpisodic: false,
      },
    ] as AbstractedMemory[]);

    expect(out[0].tags).toEqual([]);
    expect(out[0].files).toEqual([]);
    expect(out[0].confidence).toBe(0.6);
  });
});

// ── Snapshot path (M4 batch) — buildSnapshot + consolidateSnapshot ──

function wmSlot(over: Partial<any> = {}) {
  return {
    id: 'slot-1',
    content: 'fixed the auth bug after two searches',
    toolName: 'edit',
    files: ['src/auth.ts'],
    salience: 0.9,
    recency: 1,
    frequency: 1,
    emotionalWeight: 0.3,
    insertedAt: new Date().toISOString(),
    accessCount: 0,
    ...over,
  };
}

function sensoryEvent(over: Partial<any> = {}) {
  return {
    toolName: 'search',
    inputSummary: 'auth',
    outputSummary: 'found',
    filesTouched: ['src/auth.ts'],
    success: true,
    durationMs: 12,
    salience: 0.5,
    timestamp: new Date().toISOString(),
    ...over,
  };
}

describe('ConsolidationAgentService.buildSnapshot', () => {
  it('captures wmSlots verbatim, an event summary, salient-only observation lines, and the event count', () => {
    const slots = [
      wmSlot({ id: 's1', content: 'keep me', salience: 0.8 }),
      wmSlot({ id: 's2', content: 'drop me', salience: 0.2 }), // below 0.5 → excluded from obs lines
    ];
    const events = [sensoryEvent(), sensoryEvent({ success: false })];

    const snap = consolidationAgent.buildSnapshot(slots as any, events as any);

    expect(snap.wmSlots).toBe(slots); // carried verbatim for terminal-failure restore
    expect(snap.totalEvents).toBe(2);
    expect(snap.eventSummary).toContain('[WM] edit: keep me');
    expect(snap.eventSummary).toContain('[OK] search');
    expect(snap.eventSummary).toContain('[ERR] search');
    // Only the salience >= 0.5 slot becomes an observation line.
    expect(snap.wmObservationLines).toHaveLength(1);
    expect(snap.wmObservationLines[0]).toContain('keep me');
  });
});

describe('ConsolidationAgentService.consolidateSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSbAppend.mockResolvedValue(undefined);
    mockStoreEpisodic.mockImplementation(async (opts: any) => ({
      id: 'ep-1',
      content: opts.content,
    }));
    mockStoreSemantic.mockImplementation(async (opts: any) => ({
      id: 'sem-1',
      content: opts.content,
      subtype: opts.subtype,
    }));
  });

  function snapshot(over: Partial<ConsolidationSnapshot> = {}): ConsolidationSnapshot {
    return {
      wmSlots: [wmSlot()] as any,
      eventSummary: '[WM] edit: fixed the auth bug\n[OK] search: auth (12ms)',
      wmObservationLines: ['[edit] fixed the auth bug (files: src/auth.ts)'],
      totalEvents: 6,
      ...over,
    };
  }

  it('runs pattern detection + abstraction from the snapshot and stores a semantic memory', async () => {
    mockComplete
      .mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) }) // pattern detection
      .mockResolvedValueOnce({
        text: JSON.stringify({
          memories: [
            {
              content: 'Decision: validation lives in utils/validation.ts.',
              subtype: 'decision',
              confidence: 0.9,
              tags: [],
              files: [],
              isEpisodic: false,
            },
          ],
        }),
      }); // abstraction

    const result = await consolidationAgent.consolidateSnapshot('proj', 'sess', snapshot());

    expect(result.totalEventsProcessed).toBe(6); // carried from the snapshot, not a live read
    expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
    expect(result.semantic).toHaveLength(1);
    // Snapshot path NEVER reads the live working memory or sensory buffer.
    expect(mockWmGetAll).not.toHaveBeenCalled();
    expect(mockSbRead).not.toHaveBeenCalled();
  });

  it('skips pattern detection when wmSlots + totalEvents < 3 (still abstracts from WM lines)', async () => {
    // 1 slot + 1 event = 2 < 3 → no pattern-detection LLM call; abstraction still runs.
    mockComplete.mockResolvedValueOnce({
      text: JSON.stringify({
        memories: [
          {
            content: 'A durable fact worth keeping around in semantic memory.',
            subtype: 'insight',
            confidence: 0.7,
            tags: [],
            files: [],
            isEpisodic: false,
          },
        ],
      }),
    });

    const result = await consolidationAgent.consolidateSnapshot(
      'proj',
      'sess',
      snapshot({ totalEvents: 1 })
    );

    // Exactly one LLM call (abstraction only) — pattern detection was skipped.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.patternsDetected).toBe(0);
    expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
  });

  it('returns early (no LLM, no store) when there are no observations to abstract', async () => {
    const result = await consolidationAgent.consolidateSnapshot(
      'proj',
      'sess',
      snapshot({ totalEvents: 1, wmObservationLines: [], eventSummary: '' })
    );

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockStoreSemantic).not.toHaveBeenCalled();
    expect(result.semantic).toHaveLength(0);
  });

  it('THROWS ConsolidationFailedError when snapshot abstraction LLM fails', async () => {
    mockComplete
      .mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) })
      .mockRejectedValueOnce(new Error('ollama down'));

    await expect(
      consolidationAgent.consolidateSnapshot('proj', 'sess', snapshot())
    ).rejects.toBeInstanceOf(ConsolidationFailedError);
  });

  it('treats malformed (non-JSON) abstraction output as "nothing to store" — parseJson salvage', async () => {
    mockComplete
      .mockResolvedValueOnce({ text: JSON.stringify({ patterns: [] }) })
      .mockResolvedValueOnce({ text: 'totally not json, no braces at all' });

    const result = await consolidationAgent.consolidateSnapshot('proj', 'sess', snapshot());

    // parseJson finds no object → empty memories → no store, no throw.
    expect(mockStoreSemantic).not.toHaveBeenCalled();
    expect(result.semantic).toHaveLength(0);
  });
});

// ── storeAbstracted — relationship classification + anchoring ──

describe('ConsolidationAgentService.storeAbstracted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSbAppend.mockResolvedValue(undefined);
    mockStoreEpisodic.mockImplementation(async (opts: any) => ({
      id: 'ep-1',
      content: opts.content,
    }));
    mockStoreSemantic.mockImplementation(async (opts: any) => ({
      id: 'sem-1',
      content: opts.content,
      subtype: opts.subtype,
    }));
  });

  it('classifies relationships against existing semantic memories and stores them on the new memory', async () => {
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockVsSearch.mockResolvedValue([
      { id: 'existing-1', score: 0.8, payload: { content: 'older fact', subtype: 'insight' } },
    ]);
    mockClassify.mockResolvedValue([
      { targetId: 'existing-1', type: 'supersedes', reason: 'newer info' },
    ]);

    const result = await consolidationAgent.storeAbstracted('proj', 'sess', [
      {
        content: 'A new semantic fact that supersedes the old one.',
        subtype: 'insight',
        confidence: 0.9,
        tags: [],
        files: [],
        isEpisodic: false,
      },
    ]);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    // The classified relationship is threaded into storeSemantic AND the result.
    expect(mockStoreSemantic).toHaveBeenCalledWith(
      expect.objectContaining({
        relationships: [expect.objectContaining({ targetId: 'existing-1', type: 'supersedes' })],
      })
    );
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toEqual(
      expect.objectContaining({ targetId: 'existing-1', type: 'supersedes', confidence: 0.7 })
    );
  });

  it('still stores the memory when relationship classification throws (non-critical)', async () => {
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockVsSearch.mockRejectedValue(new Error('collection missing'));

    const result = await consolidationAgent.storeAbstracted('proj', 'sess', [
      {
        content: 'Semantic fact stored despite classification failure.',
        subtype: 'decision',
        confidence: 0.8,
        tags: [],
        files: [],
        isEpisodic: false,
      },
    ]);

    expect(mockStoreSemantic).toHaveBeenCalledTimes(1);
    expect(result.semantic).toHaveLength(1);
    expect(result.relationships).toHaveLength(0);
  });

  it('extracts file and symbol anchors from content and the explicit file list', async () => {
    await consolidationAgent.storeAbstracted('proj', 'sess', [
      {
        content: 'The RetrievalFusion class in src/retrieval-fusion.ts handles merge.',
        subtype: 'insight',
        confidence: 0.7,
        tags: [],
        files: ['src/explicit.ts'],
        isEpisodic: false,
      },
    ]);

    const storeArgs = mockStoreSemantic.mock.calls[0][0];
    const anchorPaths = storeArgs.anchors
      .filter((a: any) => a.type === 'file')
      .map((a: any) => a.path);
    const symbolNames = storeArgs.anchors
      .filter((a: any) => a.type === 'symbol')
      .map((a: any) => a.name);
    // Explicit file + content-extracted file.
    expect(anchorPaths).toContain('src/explicit.ts');
    expect(anchorPaths.some((p: string) => p.includes('retrieval-fusion.ts'))).toBe(true);
    // PascalCase symbol extracted from content.
    expect(symbolNames).toContain('RetrievalFusion');
  });

  it('swallows a per-memory store failure and keeps processing the rest of the batch', async () => {
    mockStoreSemantic
      .mockRejectedValueOnce(new Error('upsert failed'))
      .mockImplementationOnce(async (opts: any) => ({
        id: 'sem-2',
        content: opts.content,
        subtype: opts.subtype,
      }));

    const result = await consolidationAgent.storeAbstracted('proj', 'sess', [
      {
        content: 'first fact that fails to store cleanly',
        subtype: 'insight',
        confidence: 0.7,
        tags: [],
        files: [],
        isEpisodic: false,
      },
      {
        content: 'second fact that stores successfully',
        subtype: 'insight',
        confidence: 0.7,
        tags: [],
        files: [],
        isEpisodic: false,
      },
    ]);

    expect(mockStoreSemantic).toHaveBeenCalledTimes(2);
    // Only the second survived into the result.
    expect(result.semantic).toHaveLength(1);
    expect(result.semantic[0].id).toBe('sem-2');
  });

  it('stops storing once the per-item timeout budget is exceeded', async () => {
    // startTime far in the past + tiny timeout → the per-item `Date.now() - startTime
    // > timeout` guard breaks before the first store.
    const result = await consolidationAgent.storeAbstracted(
      'proj',
      'sess',
      [
        {
          content: 'a fact that should never be stored due to budget',
          subtype: 'insight',
          confidence: 0.7,
          tags: [],
          files: [],
          isEpisodic: false,
        },
      ],
      { startTime: Date.now() - 10_000, timeout: 1 }
    );

    expect(mockStoreSemantic).not.toHaveBeenCalled();
    expect(result.semantic).toHaveLength(0);
  });
});
