import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────
//
// The tribunal `debate()` entry point fans out across llm, agent-runtime,
// vector-store, embedding, memory, work-handler, event-bus and tracing. We
// mock every collaborator so the orchestration runs deterministically and the
// two deferred-coverage behaviors can be asserted in isolation:
//   1. deep-research token usage is added to the cost accumulator (NOT a no-op)
//   2. provider branch selects parseVerdictJson (Anthropic) vs parseVerdict (Ollama)

const mocks = vi.hoisted(() => ({
  completeWithBestProvider: vi.fn(),
  agentRun: vi.fn(),
  embed: vi.fn(),
  vectorSearch: vi.fn(),
  ensureCollection: vi.fn(),
  upsert: vi.fn(),
  remember: vi.fn(),
  recall: vi.fn(),
}));

// config: partial mock layered on top of the global setup.ts config mock so the
// tribunal-specific keys exist. Default to a complexity that routes to Claude.
vi.mock('../../config', () => ({
  default: {
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    TRIBUNAL_JUDGE_COMPLEXITY: 'complex',
    TRIBUNAL_ADVOCATE_COMPLEXITY: 'complex',
  },
}));

vi.mock('../../services/llm', () => ({
  llm: { completeWithBestProvider: mocks.completeWithBestProvider },
}));

vi.mock('../../services/agent-runtime', () => ({
  agentRuntime: { run: mocks.agentRun },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mocks.embed },
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    search: mocks.vectorSearch,
    ensureCollection: mocks.ensureCollection,
    upsert: mocks.upsert,
  },
}));

vi.mock('../../services/memory', () => ({
  memoryService: { remember: mocks.remember, recall: mocks.recall },
}));

// work-handler: return a no-op handle from register().
vi.mock('../../services/work-handler', () => ({
  workRegistry: {
    register: vi.fn(() => ({
      id: 'work-1',
      type: 'agent',
      update: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      getStatus: vi.fn(),
    })),
  },
}));

vi.mock('../../services/event-bus', () => ({
  eventBus: { publish: vi.fn() },
}));

// tracing: withSpan just invokes the callback with a stub span.
vi.mock('../../utils/tracing', () => ({
  withSpan: vi.fn((_name: string, _attrs: unknown, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: vi.fn() })
  ),
}));

// Deterministic debate id.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => 'debate-uuid' };
});

// modelCostUsd is the REAL pricing function (single source of truth) — we do NOT
// mock it, so the test verifies cost actually flows through real Anthropic pricing.
import { tribunalService } from '../../services/tribunal';

// Sonnet pricing from llm-usage-logger.PRICING: input $3/1M, output $15/1M.
const SONNET_INPUT_PER_1M = 3;
const SONNET_OUTPUT_PER_1M = 15;

/**
 * Make every llm.completeWithBestProvider call (framing, advocates, verdict)
 * report ZERO usage so the ONLY non-zero token contribution to the cost
 * accumulator comes from the deep-research agents. This isolates the
 * deep-research token accumulation we want to assert.
 */
function llmZeroUsage(verdictText: string, provider: string = 'anthropic') {
  mocks.completeWithBestProvider.mockImplementation(async () => ({
    text: verdictText,
    provider,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }));
}

const STRUCTURED_VERDICT = JSON.stringify({
  recommendation: 'Position A',
  confidence: 'high',
  reasoning: 'A is better.',
  scores: [
    { position: 'Position A', score: 9, justification: 'strong' },
    { position: 'Position B', score: 4, justification: 'weak' },
  ],
  tradeoffs: 'some tradeoffs',
  dissent: 'B has merits',
  conditions: 'revisit in 6 months',
});

const MARKDOWN_VERDICT = `**RECOMMENDATION:** Position A
**CONFIDENCE:** high

**SCORING:**
Position A 9
Position B 4

**REASONING:**
A wins on the criteria.

**TRADE-OFFS:**
some tradeoffs

**DISSENT:**
B has merits

**CONDITIONS:**
revisit later`;

describe('TribunalService.debate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Vector + embedding collaborators: empty/no-ops so framing cache misses,
    // RAG context is empty, and persistence succeeds quietly.
    mocks.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    mocks.vectorSearch.mockResolvedValue([]); // no framing cache hit
    mocks.ensureCollection.mockResolvedValue(undefined);
    mocks.upsert.mockResolvedValue(undefined);
    mocks.recall.mockResolvedValue([]);
    mocks.remember.mockResolvedValue(undefined);
  });

  // ── Deferred coverage #1: deep-research token accumulation ──
  it('adds each research agent token usage to the cost accumulator (deep-research cost is NOT a no-op)', async () => {
    // Two positions → two research agents, each reporting a KNOWN totalTokens.
    const RESEARCH_TOKENS = 1000;
    mocks.agentRun.mockImplementation(async () => ({
      result: 'concrete evidence',
      usage: { totalTokens: RESEARCH_TOKENS },
    }));

    // All llm calls report zero usage so the cost is driven solely by research.
    llmZeroUsage(STRUCTURED_VERDICT, 'anthropic');

    const result = await tribunalService.debate({
      topic: 'A vs B',
      positions: ['Position A', 'Position B'],
      projectName: 'proj',
      deepResearch: true,
      maxRounds: 0, // skip rebuttals — keep the token accounting focused
      maxBudget: 100, // high so no early budget exit
    });

    // Each position ran a research agent and propagated its tokens.
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);

    // result.cost.totalTokens accumulates the raw research tokens (2 x 1000).
    expect(result.cost.totalTokens).toBe(2 * RESEARCH_TOKENS);

    // The accumulator splits research tokens 60/40 → assert estimatedUsd reflects
    // the deep-research spend through REAL Anthropic Sonnet pricing. With all other
    // phases at zero usage, the only cost is the 2*1000 research tokens.
    const totalResearchTokens = 2 * RESEARCH_TOKENS;
    const promptTokens = Math.round(RESEARCH_TOKENS * 0.6) * 2; // 1200
    const completionTokens = Math.round(RESEARCH_TOKENS * 0.4) * 2; // 800
    const expectedUsd =
      (promptTokens / 1_000_000) * SONNET_INPUT_PER_1M +
      (completionTokens / 1_000_000) * SONNET_OUTPUT_PER_1M;

    expect(result.cost.estimatedUsd).toBeCloseTo(expectedUsd, 10);
    // Sanity: the guard/cost is genuinely non-zero (the deferred bug was a no-op).
    expect(result.cost.estimatedUsd).toBeGreaterThan(0);
    expect(totalResearchTokens).toBeGreaterThan(0);
  });

  it('triggers the post-research budget guard using deep-research cost', async () => {
    // Huge research token usage + a tiny budget → estimateCost(costAcc) > maxBudget
    // must be evaluated AFTER research (proving research tokens entered the
    // accumulator). The guard only logs, so we assert the debate still completes
    // with a cost that exceeds the budget — i.e. the guard had real input.
    const BIG_TOKENS = 5_000_000;
    mocks.agentRun.mockImplementation(async () => ({
      result: 'evidence',
      usage: { totalTokens: BIG_TOKENS },
    }));
    llmZeroUsage(STRUCTURED_VERDICT, 'anthropic');

    const result = await tribunalService.debate({
      topic: 'A vs B',
      positions: ['Position A', 'Position B'],
      projectName: 'proj',
      deepResearch: true,
      maxRounds: 0,
      maxBudget: 0.01, // tiny budget — research cost blows past it
    });

    expect(result.status).toBe('completed');
    expect(result.cost.estimatedUsd).toBeGreaterThan(0.01);
  });

  it('does NOT run research agents and reports zero research tokens when deepResearch is disabled', async () => {
    mocks.agentRun.mockResolvedValue({ result: 'x', usage: { totalTokens: 999 } });
    llmZeroUsage(STRUCTURED_VERDICT, 'anthropic');

    const result = await tribunalService.debate({
      topic: 'A vs B',
      positions: ['Position A', 'Position B'],
      projectName: 'proj',
      deepResearch: false,
      maxRounds: 0,
      maxBudget: 100,
    });

    expect(mocks.agentRun).not.toHaveBeenCalled();
    // No research, all other phases zero-usage → no cost at all.
    expect(result.cost.totalTokens).toBe(0);
    expect(result.cost.estimatedUsd).toBe(0);
  });

  // ── Deferred coverage #2: provider branch (json_schema vs regex) ──
  describe('verdict provider branch', () => {
    it('Anthropic path: sends jsonSchema and parses structured verdict via parseVerdictJson', async () => {
      mocks.completeWithBestProvider.mockImplementation(async () => ({
        text: STRUCTURED_VERDICT,
        provider: 'anthropic',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }));

      const result = await tribunalService.debate({
        topic: 'A vs B',
        positions: ['Position A', 'Position B'],
        projectName: 'proj',
        maxRounds: 0,
        maxBudget: 100,
      });

      // The verdict LLM call carries the structured-output schema (jsonSchema option).
      const verdictCall = mocks.completeWithBestProvider.mock.calls.find(
        (c) => c[1] && (c[1] as { jsonSchema?: unknown }).jsonSchema !== undefined
      );
      expect(verdictCall).toBeDefined();
      const opts = verdictCall![1] as { jsonSchema?: Record<string, unknown> };
      expect(opts.jsonSchema).toBeDefined();
      expect(opts.jsonSchema!.type).toBe('object');

      // parseVerdictJson produced a fully-populated, structured verdict (numeric
      // scores from JSON, not the regex fallback's all-same justification blob).
      expect(result.verdict.recommendation).toBe('Position A');
      expect(result.verdict.confidence).toBe('high');
      expect(result.verdict.reasoning).toBe('A is better.');
      expect(result.verdict.scores).toEqual([
        { position: 'Position A', score: 9, justification: 'strong' },
        { position: 'Position B', score: 4, justification: 'weak' },
      ]);
      expect(result.verdict.conditions).toBe('revisit in 6 months');
    });

    it('Ollama path: falls back to the regex parser (parseVerdict) on labelled markdown', async () => {
      // Verdict call returns Ollama provider + markdown; provider !== 'anthropic'
      // means parseVerdictJson is NOT used — the markdown is parsed by regex.
      mocks.completeWithBestProvider.mockImplementation(async () => ({
        text: MARKDOWN_VERDICT,
        provider: 'ollama',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }));

      const result = await tribunalService.debate({
        topic: 'A vs B',
        positions: ['Position A', 'Position B'],
        projectName: 'proj',
        maxRounds: 0,
        maxBudget: 100,
      });

      // Regex parser extracts the labelled fields from the markdown verdict.
      expect(result.verdict.recommendation).toBe('Position A');
      expect(result.verdict.confidence).toBe('high');
      expect(result.verdict.scores.map((s) => s.score)).toEqual([9, 4]);
      // Ollama is local → cost is zero regardless of tokens.
      expect(result.cost.estimatedUsd).toBe(0);
    });

    it('Anthropic path with malformed JSON falls back to regex parser (parseVerdict)', async () => {
      // Provider is anthropic (selects parseVerdictJson) but the body is the
      // labelled-markdown format → JSON.parse throws → regex fallback fires.
      mocks.completeWithBestProvider.mockImplementation(async () => ({
        text: MARKDOWN_VERDICT,
        provider: 'anthropic',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }));

      const result = await tribunalService.debate({
        topic: 'A vs B',
        positions: ['Position A', 'Position B'],
        projectName: 'proj',
        maxRounds: 0,
        maxBudget: 100,
      });

      // Fallback still yields a usable verdict (recommendation parsed from markdown).
      expect(result.verdict.recommendation).toBe('Position A');
      expect(result.verdict.confidence).toBe('high');
    });
  });
});
