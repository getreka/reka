/**
 * Tribunal — Adversarial debate orchestrator.
 *
 * 4-phase pipeline:
 *   Phase 1: Framing   — Judge frames the debate question
 *   Phase 2: Arguments — Advocates argue their positions (parallel)
 *   Phase 3: Rebuttal  — Advocates rebut opponents (parallel)
 *   Phase 4: Verdict   — Judge synthesizes and renders decision
 *
 * Leverages LLM service with configurable complexity routing:
 *   - Judge: TRIBUNAL_JUDGE_COMPLEXITY (default: 'complex' → Claude with thinking)
 *   - Advocates: TRIBUNAL_ADVOCATE_COMPLEXITY (default: 'complex' → Claude)
 */

import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { logger } from '../utils/logger';
import { llm } from './llm';
import { modelCostUsd } from './llm-usage-logger';
import { embeddingService } from './embedding';
import { vectorStore } from './vector-store';
import { memoryService } from './memory';
import { workRegistry } from './work-handler';
import { eventBus } from './event-bus';
import { agentRuntime } from './agent-runtime';
import { withSpan } from '../utils/tracing';

// ── Interfaces ──────────────────────────────────────────────

export interface TribunalConfig {
  topic: string;
  positions: string[]; // 2-3 positions to debate
  context?: string; // Additional context provided by user
  projectName: string;
  maxRounds?: number; // Rebuttal rounds (default: 1)
  useCodeContext?: boolean; // Fetch RAG context before debate
  autoRecord?: boolean; // Save verdict as decision in memory
  maxBudget?: number; // Cost guard in USD (default: 0.50)
  deepResearch?: boolean; // Run research agents per position before arguments
}

export interface TribunalArgument {
  position: string;
  content: string;
  round: number;
  tokens: number;
}

export interface TribunalVerdict {
  recommendation: string; // Which position wins
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  scores: Array<{ position: string; score: number; justification: string }>;
  tradeoffs: string;
  dissent: string;
  conditions: string;
}

export interface TribunalPhase {
  name: 'framing' | 'arguments' | 'rebuttal' | 'verdict';
  durationMs: number;
  tokens: number;
  content: string;
}

export interface TribunalResult {
  id: string;
  topic: string;
  positions: string[];
  phases: TribunalPhase[];
  arguments: TribunalArgument[];
  verdict: TribunalVerdict;
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  cost: {
    totalTokens: number;
    estimatedUsd: number;
  };
  durationMs: number;
}

// ── Templates ───────────────────────────────────────────────

function advocateSystemPrompt(position: string): string {
  return `You are an Advocate Agent in a structured debate. Your assigned position is: "${position}".

Argue convincingly for this position using evidence and reasoning.

Rules:
- Every argument must cite concrete evidence (code patterns, benchmarks, industry data, trade-offs)
- Acknowledge the strongest version of opposing arguments before rebutting
- Quantify when possible — use numbers, metrics, or estimates
- Stay focused on your assigned position
- Be concise but thorough — aim for 300-500 words per argument`;
}

function judgeFramingPrompt(topic: string, positions: string[], ragContext?: string): string {
  let prompt = `You are a Judge in a structured debate about: "${topic}"

The positions being debated are:
${positions.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Frame this debate by:
1. Clarifying the core question and what makes this decision important
2. Listing 3-5 evaluation criteria WITH measurable metrics where possible — for example: "latency < 100 ms at p99", "team ramp-up time ≤ 2 weeks", "operational cost < $500/month", "test coverage ≥ 80%". At least 2 of the criteria must be quantified.
3. Noting any constraints or context that advocates should consider

Advocates will use these criteria as concrete targets to argue about, so specificity directly determines the quality of the debate.

Be concise — 200-300 words.`;

  if (ragContext) {
    prompt += `\n\nProject context (from codebase analysis):\n${ragContext}`;
  }
  return prompt;
}

function judgeVerdictPrompt(
  topic: string,
  framing: string,
  arguments_: TribunalArgument[],
  ragContext?: string
): string {
  let prompt = `You are a Judge rendering the final verdict in a structured debate.

## Topic
${topic}

## Framing
${framing}

## Arguments & Rebuttals
`;

  // Group by position
  const byPosition = new Map<string, TribunalArgument[]>();
  for (const arg of arguments_) {
    const existing = byPosition.get(arg.position) || [];
    existing.push(arg);
    byPosition.set(arg.position, existing);
  }

  for (const [position, args] of byPosition) {
    prompt += `\n### Position: ${position}\n`;
    for (const arg of args) {
      const label = arg.round === 0 ? 'Initial Argument' : `Rebuttal Round ${arg.round}`;
      prompt += `**${label}:**\n${arg.content}\n\n`;
    }
  }

  if (ragContext) {
    prompt += `\n## Project Context\n${ragContext}\n`;
  }

  prompt += `
## Your Task
Render a verdict with this EXACT structure:

**RECOMMENDATION:** [which position wins]
**CONFIDENCE:** [high/medium/low]

**SCORING:**
[For each position: score 1-10 with one-line justification]

**REASONING:**
[2-3 paragraphs explaining the decision]

**TRADE-OFFS:**
[What you sacrifice by choosing this recommendation]

**DISSENT:**
[Strongest counter-argument from the losing side]

**CONDITIONS:**
[When this verdict should be revisited]`;

  return prompt;
}

// ── Verdict Structured Output Schema ────────────────────────

// JSON schema for the judge's verdict — sent as output_config.format on the Anthropic path
// so the verdict comes back as guaranteed-valid JSON (no brittle regex parsing).
const VERDICT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recommendation: { type: 'string', description: 'Which position wins' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string', description: '2-3 paragraphs explaining the decision' },
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          position: { type: 'string' },
          score: { type: 'integer' },
          justification: { type: 'string' },
        },
        required: ['position', 'score', 'justification'],
      },
    },
    tradeoffs: {
      type: 'string',
      description: 'What is sacrificed by choosing this recommendation',
    },
    dissent: { type: 'string', description: 'Strongest counter-argument from the losing side' },
    conditions: { type: 'string', description: 'When this verdict should be revisited' },
  },
  required: [
    'recommendation',
    'confidence',
    'reasoning',
    'scores',
    'tradeoffs',
    'dissent',
    'conditions',
  ],
};

/**
 * Parse a structured (json_schema) verdict response. Used on the Anthropic path where
 * output_config.format guarantees valid JSON. Falls back to the regex parser on any
 * parse failure so a malformed response never crashes the debate.
 */
function parseVerdictJson(text: string, positions: string[]): TribunalVerdict {
  try {
    const raw = JSON.parse(text) as Partial<TribunalVerdict>;
    const confidence = (
      ['high', 'medium', 'low'].includes(raw.confidence as string) ? raw.confidence : 'medium'
    ) as 'high' | 'medium' | 'low';
    const scores = Array.isArray(raw.scores)
      ? raw.scores.map((s) => ({
          position: String(s.position ?? ''),
          score: Number.isFinite(s.score) ? Number(s.score) : 5,
          justification: String(s.justification ?? ''),
        }))
      : positions.map((position) => ({ position, score: 5, justification: '' }));

    return {
      recommendation: String(raw.recommendation ?? ''),
      confidence,
      reasoning: String(raw.reasoning ?? ''),
      scores,
      tradeoffs: String(raw.tradeoffs ?? ''),
      dissent: String(raw.dissent ?? ''),
      conditions: String(raw.conditions ?? ''),
    };
  } catch {
    // Structured output was expected but didn't parse — fall back to the regex parser.
    return parseVerdict(text, positions);
  }
}

// ── Verdict Parser (regex fallback, Ollama path) ────────────

function parseVerdict(text: string, positions: string[]): TribunalVerdict {
  const get = (label: string): string => {
    const regex = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z]|$)`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  };

  const recommendation = get('RECOMMENDATION');
  const confidenceRaw = get('CONFIDENCE').toLowerCase();
  const confidence = (
    ['high', 'medium', 'low'].includes(confidenceRaw) ? confidenceRaw : 'medium'
  ) as 'high' | 'medium' | 'low';
  const reasoning = get('REASONING');
  const tradeoffs = get('TRADE-OFFS') || get('TRADEOFFS') || get('TRADE_OFFS');
  const dissent = get('DISSENT');
  const conditions = get('CONDITIONS');

  // Parse scores
  const scoringText = get('SCORING');
  const scores = positions.map((position) => {
    const scoreMatch = scoringText.match(
      new RegExp(`${position.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^0-9]*?(\\d+)`, 'i')
    );
    return {
      position,
      score: scoreMatch ? parseInt(scoreMatch[1], 10) : 5,
      justification: scoringText,
    };
  });

  return { recommendation, confidence, reasoning, scores, tradeoffs, dissent, conditions };
}

// ── Cost Estimation ─────────────────────────────────────────
//
// Model pricing knowledge lives in llm-usage-logger.modelCostUsd (single source of
// truth, also prices prompt-cache tokens). Tribunal only tracks token tallies and
// returns 0 for the local Ollama provider.

// Running token tally for a debate, separated into input/output so cost is exact.
interface CostAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheCreationTokens: number; // Anthropic prompt-cache write tokens (~1.25x input cost)
  cacheReadTokens: number; // Anthropic prompt-cache read tokens (~0.1x input cost)
  provider: string; // last provider that handled a call (e.g. 'anthropic', 'ollama')
  model: string; // last model that handled a call
}

/**
 * Provider/model-aware cost estimate using actual prompt/completion token counts.
 * Returns 0 for Ollama (local, no marginal cost). Delegates pricing (incl. cache
 * tokens) to llm-usage-logger.modelCostUsd; unknown Anthropic models fall back to
 * Sonnet pricing there.
 */
function estimateCost(acc: CostAccumulator): number {
  if (acc.provider === 'ollama') return 0;

  // If we have a real input/output split, use it; otherwise fall back to a 60/40 estimate.
  const hasSplit = acc.promptTokens > 0 || acc.completionTokens > 0;
  const promptTokens = hasSplit ? acc.promptTokens : acc.totalTokens * 0.6;
  const completionTokens = hasSplit ? acc.completionTokens : acc.totalTokens * 0.4;

  return modelCostUsd(acc.model, {
    promptTokens,
    completionTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens,
  });
}

// ── Debate Store (in-memory, TTL cleanup) ───────────────────

const DEBATE_TTL_MS = 60 * 60 * 1000; // 1 hour
const debateStore = new Map<string, { result: TribunalResult; expiresAt: number }>();

function storeDebate(result: TribunalResult): void {
  debateStore.set(result.id, { result, expiresAt: Date.now() + DEBATE_TTL_MS });
}

function getDebate(id: string): TribunalResult | undefined {
  const entry = debateStore.get(id);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    debateStore.delete(id);
    return undefined;
  }
  return entry.result;
}

// Cleanup expired entries every 10 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [id, entry] of debateStore) {
      if (now > entry.expiresAt) debateStore.delete(id);
    }
  },
  10 * 60 * 1000
).unref();

// ── Framing Cache Threshold ──────────────────────────────────

const FRAMING_CACHE_THRESHOLD = 0.9; // cosine similarity to reuse framing

// ── Orchestrator ────────────────────────────────────────────

class TribunalService {
  getDebate(id: string): TribunalResult | undefined {
    return getDebate(id);
  }

  /**
   * Search debate history for a project. Optionally filter by topic similarity.
   */
  async getHistory(
    projectName: string,
    limit: number = 10,
    topic?: string
  ): Promise<
    Array<{
      id: string;
      topic: string;
      recommendation: string;
      confidence: string;
      positions: string[];
      cost: number;
      durationMs: number;
      createdAt: string;
      score?: number;
    }>
  > {
    const collection = `${projectName}_tribunals`;

    try {
      if (topic) {
        // Semantic search by topic
        const embedding = await embeddingService.embed(topic);
        const results = await vectorStore.search(collection, embedding, limit);
        return results.map((r) => ({
          id: r.id,
          topic: String(r.payload.topic || ''),
          recommendation: String(r.payload.recommendation || ''),
          confidence: String(r.payload.confidence || ''),
          positions: (r.payload.positions as string[]) || [],
          cost: Number(r.payload.cost || 0),
          durationMs: Number(r.payload.durationMs || 0),
          createdAt: String(r.payload.createdAt || ''),
          score: r.score,
        }));
      }

      // List recent debates (scroll with no filter, sorted by createdAt desc)
      const results = await vectorStore.search(
        collection,
        await embeddingService.embed('tribunal debate'),
        limit
      );
      return results.map((r) => ({
        id: r.id,
        topic: String(r.payload.topic || ''),
        recommendation: String(r.payload.recommendation || ''),
        confidence: String(r.payload.confidence || ''),
        positions: (r.payload.positions as string[]) || [],
        cost: Number(r.payload.cost || 0),
        durationMs: Number(r.payload.durationMs || 0),
        createdAt: String(r.payload.createdAt || ''),
        score: r.score,
      }));
    } catch (err: any) {
      // Collection may not exist yet
      if (err.status === 404 || err.message?.includes('Not found')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Persist a completed debate to Qdrant for history + framing cache.
   */
  private async persistDebate(projectName: string, result: TribunalResult): Promise<void> {
    const collection = `${projectName}_tribunals`;

    try {
      await vectorStore.ensureCollection(collection);

      const embedding = await embeddingService.embed(result.topic);
      await vectorStore.upsert(collection, [
        {
          id: result.id,
          vector: embedding,
          payload: {
            topic: result.topic,
            positions: result.positions,
            recommendation: result.verdict.recommendation,
            confidence: result.verdict.confidence,
            reasoning: result.verdict.reasoning,
            tradeoffs: result.verdict.tradeoffs,
            dissent: result.verdict.dissent,
            conditions: result.verdict.conditions,
            scores: result.verdict.scores,
            framing: result.phases.find((p) => p.name === 'framing')?.content || '',
            cost: result.cost.estimatedUsd,
            totalTokens: result.cost.totalTokens,
            durationMs: result.durationMs,
            status: result.status,
            createdAt: new Date().toISOString(),
          },
        },
      ]);

      logger.debug('Persisted debate to history', { id: result.id, collection });
    } catch (err: any) {
      logger.warn('Failed to persist debate to history', { error: err.message });
    }
  }

  /**
   * Find cached framing for a similar topic (cosine similarity > threshold).
   */
  private async findCachedFraming(projectName: string, topic: string): Promise<string | undefined> {
    const collection = `${projectName}_tribunals`;

    try {
      const embedding = await embeddingService.embed(topic);
      const results = await vectorStore.search(
        collection,
        embedding,
        1,
        undefined,
        FRAMING_CACHE_THRESHOLD
      );

      if (results.length > 0 && results[0].payload.framing) {
        logger.info('Tribunal framing cache hit', {
          topic: topic.slice(0, 80),
          cachedTopic: String(results[0].payload.topic).slice(0, 80),
          similarity: results[0].score,
        });
        return String(results[0].payload.framing);
      }
    } catch (err: any) {
      // Collection may not exist — no cache hit
      logger.debug('Framing cache lookup failed', { error: err.message });
    }

    return undefined;
  }

  async debate(cfg: TribunalConfig & { debateId?: string }): Promise<TribunalResult> {
    return withSpan(
      'tribunal.debate',
      {
        topic: cfg.topic.slice(0, 100),
        positions: cfg.positions.join(','),
        project: cfg.projectName,
        deep_research: cfg.deepResearch || false,
      },
      async (span) => this._debate(cfg, span)
    );
  }

  private async _debate(
    cfg: TribunalConfig & { debateId?: string },
    span?: any
  ): Promise<TribunalResult> {
    const id = cfg.debateId || uuidv4();
    const maxRounds = cfg.maxRounds ?? 1;
    const maxBudget = cfg.maxBudget ?? 0.5;
    const startTime = Date.now();

    const result: TribunalResult = {
      id,
      topic: cfg.topic,
      positions: cfg.positions,
      phases: [],
      arguments: [],
      verdict: {
        recommendation: '',
        confidence: 'low',
        reasoning: '',
        scores: [],
        tradeoffs: '',
        dissent: '',
        conditions: '',
      },
      status: 'completed',
      cost: { totalTokens: 0, estimatedUsd: 0 },
      durationMs: 0,
    };

    // Accumulate actual input/output tokens + the provider/model that handled the calls
    // so the final cost reflects real Anthropic pricing (or 0 for Ollama).
    const costAcc: CostAccumulator = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      provider: 'anthropic',
      model: config.ANTHROPIC_MODEL,
    };
    const addUsage = (usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    }): void => {
      if (!usage) return;
      costAcc.promptTokens += usage.promptTokens || 0;
      costAcc.completionTokens += usage.completionTokens || 0;
      costAcc.totalTokens += usage.totalTokens || 0;
      costAcc.cacheCreationTokens += usage.cacheCreationTokens || 0;
      costAcc.cacheReadTokens += usage.cacheReadTokens || 0;
    };

    // Register in work registry
    const workHandle = workRegistry.register({
      id,
      type: 'agent',
      projectName: cfg.projectName,
      description: `Tribunal: ${cfg.topic.slice(0, 80)}`,
      metadata: { positions: cfg.positions, maxRounds },
    });

    try {
      // ── Fetch RAG context ───────────────────────────────
      let ragContext: string | undefined;
      if (cfg.useCodeContext) {
        ragContext = await this.fetchRagContext(cfg.projectName, cfg.topic, cfg.positions);
      }

      // ── Phase 1: Framing (with cache) ────────────────────
      const framingStart = Date.now();
      let framingText: string;
      let framingTokens = 0;

      const cachedFraming = await this.findCachedFraming(cfg.projectName, cfg.topic);
      if (cachedFraming) {
        framingText = cachedFraming;
        logger.info('Tribunal using cached framing', { id, topic: cfg.topic.slice(0, 80) });
      } else {
        const framingPrompt = judgeFramingPrompt(cfg.topic, cfg.positions, ragContext);
        const framingResult = await llm.completeWithBestProvider(framingPrompt, {
          complexity: config.TRIBUNAL_JUDGE_COMPLEXITY,
          maxTokens: 2048,
          temperature: 0.3,
          think: config.TRIBUNAL_JUDGE_COMPLEXITY === 'complex',
        });
        framingText = framingResult.text;
        framingTokens = framingResult.usage?.totalTokens || 0;
        addUsage(framingResult.usage);
        if (framingResult.provider) costAcc.provider = framingResult.provider;
      }

      result.cost.totalTokens += framingTokens;
      result.phases.push({
        name: 'framing',
        durationMs: Date.now() - framingStart,
        tokens: framingTokens,
        content: framingText,
      });

      workHandle.update({ progress: { current: 1, total: 4, percentage: 25 } });
      eventBus.publish('tribunal:framing', {
        debateId: id,
        topic: cfg.topic,
        content: framingText,
      });
      storeDebate(result);

      // ── Deep Research (optional, before arguments) ──────
      let positionResearch: Map<string, string> | undefined;
      if (cfg.deepResearch) {
        const researchStart = Date.now();
        positionResearch = new Map();

        // Run parallel research agents — one per position
        const researchPromises = cfg.positions.map(async (position) => {
          try {
            const agentResult = await agentRuntime.run({
              projectName: cfg.projectName,
              agentType: 'research',
              task: `Research evidence for the position "${position}" in the context of: ${cfg.topic}. Focus on concrete data: existing code patterns, benchmarks, industry best practices, and trade-offs.`,
              maxIterations: 5,
              timeout: 60_000,
            });
            return {
              position,
              evidence: agentResult.result || '',
              tokens: agentResult.usage?.totalTokens || 0,
            };
          } catch (err: any) {
            logger.warn('Tribunal deep research failed for position', {
              position,
              error: err.message,
            });
            return { position, evidence: '', tokens: 0 };
          }
        });

        const researchResults = await Promise.all(researchPromises);
        let researchTokens = 0;
        for (const { position, evidence, tokens } of researchResults) {
          if (evidence) {
            positionResearch.set(position, evidence);
          }
          // Count every research agent's token usage toward the debate cost — even
          // failed runs may have spent tokens before erroring. agentRuntime only
          // reports an aggregate total (no input/output split). Split it 60/40 here
          // so the cost is reflected even when other phases already populated the
          // accumulator's prompt/completion split (estimateCost's own 60/40 fallback
          // only fires when BOTH are still zero, which research alone wouldn't satisfy).
          researchTokens += tokens;
          addUsage({
            totalTokens: tokens,
            promptTokens: Math.round(tokens * 0.6),
            completionTokens: Math.round(tokens * 0.4),
          });
        }
        result.cost.totalTokens += researchTokens;

        // Budget check after research (costAcc now includes deep-research cost, so this
        // guard is no longer a no-op and estimatedUsd reflects research spend).
        const researchDurationMs = Date.now() - researchStart;
        logger.info('Tribunal deep research completed', {
          id,
          positions: cfg.positions,
          researchTokens,
          durationMs: researchDurationMs,
        });

        if (estimateCost(costAcc) > maxBudget) {
          logger.warn('Tribunal budget exceeded after deep research', {
            id,
            estimatedUsd: estimateCost(costAcc),
            maxBudget,
          });
        }
      }

      // ── Phase 2: Initial Arguments (parallel) ───────────
      const argsStart = Date.now();
      const argPromises = cfg.positions.map((position) => {
        // Inject research evidence if available
        const researchEvidence = positionResearch?.get(position);
        const enrichedRagContext = researchEvidence
          ? `${ragContext || ''}\n\n## Research Evidence\n${researchEvidence}`
          : ragContext;

        return this.runAdvocate(
          position,
          cfg.topic,
          framingText,
          enrichedRagContext,
          undefined, // no opponent args yet
          0
        );
      });

      const initialAdvocateResults = await Promise.all(argPromises);
      const initialArgs = initialAdvocateResults.map((r) => r.argument);
      let argsTokens = 0;
      for (const r of initialAdvocateResults) {
        argsTokens += r.argument.tokens;
        result.arguments.push(r.argument);
        addUsage(r.usage);
        if (r.provider) costAcc.provider = r.provider;
      }
      result.cost.totalTokens += argsTokens;
      result.phases.push({
        name: 'arguments',
        durationMs: Date.now() - argsStart,
        tokens: argsTokens,
        content: initialArgs
          .map((a) => `**${a.position}:** ${a.content.slice(0, 200)}...`)
          .join('\n\n'),
      });

      workHandle.update({ progress: { current: 2, total: 4, percentage: 50 } });
      eventBus.publish('tribunal:argument', {
        debateId: id,
        topic: cfg.topic,
        arguments: initialArgs.map((a) => ({
          position: a.position,
          preview: a.content.slice(0, 200),
        })),
      });
      storeDebate(result);

      // Budget check
      if (estimateCost(costAcc) > maxBudget) {
        logger.warn('Tribunal budget exceeded after arguments, skipping rebuttals', {
          id,
          estimatedUsd: estimateCost(costAcc),
          maxBudget,
        });
      } else {
        // ── Phase 3: Rebuttals (parallel per round) ─────────
        const rebuttalStart = Date.now();
        let rebuttalTokens = 0;

        for (let round = 1; round <= maxRounds; round++) {
          // Each advocate sees all other advocates' latest arguments
          const rebuttalPromises = cfg.positions.map((position) => {
            const opponentArgs = result.arguments.filter(
              (a) => a.position !== position && a.round === round - 1
            );
            return this.runAdvocate(
              position,
              cfg.topic,
              framingText,
              ragContext,
              opponentArgs,
              round
            );
          });

          const roundRebuttals = await Promise.all(rebuttalPromises);
          for (const r of roundRebuttals) {
            rebuttalTokens += r.argument.tokens;
            result.arguments.push(r.argument);
            addUsage(r.usage);
            if (r.provider) costAcc.provider = r.provider;
          }

          // Budget check between rounds (costAcc already includes this round's usage)
          if (estimateCost(costAcc) > maxBudget) {
            logger.warn('Tribunal budget exceeded during rebuttals', { id, round });
            break;
          }
        }

        result.cost.totalTokens += rebuttalTokens;
        result.phases.push({
          name: 'rebuttal',
          durationMs: Date.now() - rebuttalStart,
          tokens: rebuttalTokens,
          content: `${maxRounds} round(s), ${result.arguments.filter((a) => a.round > 0).length} rebuttals`,
        });
      }

      workHandle.update({ progress: { current: 3, total: 4, percentage: 75 } });
      eventBus.publish('tribunal:rebuttal', {
        debateId: id,
        topic: cfg.topic,
        rebuttalCount: result.arguments.filter((a) => a.round > 0).length,
      });
      storeDebate(result);

      // ── Phase 4: Verdict ────────────────────────────────
      const verdictStart = Date.now();
      const verdictPrompt = judgeVerdictPrompt(
        cfg.topic,
        framingText,
        result.arguments,
        ragContext
      );
      const verdictResult = await llm.completeWithBestProvider(verdictPrompt, {
        complexity: config.TRIBUNAL_JUDGE_COMPLEXITY,
        maxTokens: 4096,
        temperature: 0.2,
        think: config.TRIBUNAL_JUDGE_COMPLEXITY === 'complex',
        // Structured outputs: enforced on the Anthropic path via output_config.format.
        // Ignored by the Ollama path, which still emits the labelled-markdown verdict.
        jsonSchema: VERDICT_JSON_SCHEMA,
      });

      const verdictTokens = verdictResult.usage?.totalTokens || 0;
      result.cost.totalTokens += verdictTokens;
      addUsage(verdictResult.usage);
      if (verdictResult.provider) costAcc.provider = verdictResult.provider;
      // Anthropic returns guaranteed-valid JSON (json_schema); Ollama returns the
      // labelled-markdown format parsed by the regex fallback.
      result.verdict =
        verdictResult.provider === 'anthropic'
          ? parseVerdictJson(verdictResult.text, cfg.positions)
          : parseVerdict(verdictResult.text, cfg.positions);
      result.phases.push({
        name: 'verdict',
        durationMs: Date.now() - verdictStart,
        tokens: verdictTokens,
        content: verdictResult.text,
      });

      workHandle.update({ progress: { current: 4, total: 4, percentage: 100 } });
      eventBus.publish('tribunal:verdict', {
        debateId: id,
        topic: cfg.topic,
        recommendation: result.verdict.recommendation,
        confidence: result.verdict.confidence,
      });

      // ── Auto-record verdict as decision ─────────────────
      if (cfg.autoRecord) {
        try {
          await memoryService.remember({
            projectName: cfg.projectName,
            content:
              `# Tribunal Decision: ${cfg.topic}\n\n` +
              `**Recommendation:** ${result.verdict.recommendation}\n` +
              `**Confidence:** ${result.verdict.confidence}\n\n` +
              `**Reasoning:**\n${result.verdict.reasoning}\n\n` +
              `**Trade-offs:**\n${result.verdict.tradeoffs}\n\n` +
              `**Dissent:**\n${result.verdict.dissent}\n\n` +
              `**Conditions:**\n${result.verdict.conditions}`,
            type: 'decision',
            tags: [
              'tribunal',
              'debate',
              ...cfg.positions.map((p) => p.toLowerCase().replace(/\s+/g, '-')),
            ],
            relatedTo: cfg.topic,
          });
        } catch (err: any) {
          logger.warn('Failed to auto-record tribunal verdict', { error: err.message });
        }
      }

      result.cost.estimatedUsd = estimateCost(costAcc);
      result.durationMs = Date.now() - startTime;
      result.status = 'completed';
      workHandle.complete({
        verdict: result.verdict.recommendation,
        cost: result.cost.estimatedUsd,
      });

      storeDebate(result);

      // Persist to Qdrant for history + framing cache
      await this.persistDebate(cfg.projectName, result);

      eventBus.publish('tribunal:completed', {
        debateId: id,
        topic: cfg.topic,
        recommendation: result.verdict.recommendation,
        confidence: result.verdict.confidence,
        cost: result.cost.estimatedUsd,
        durationMs: result.durationMs,
      });

      if (span?.setAttribute) {
        span.setAttribute('verdict', result.verdict.recommendation);
        span.setAttribute('confidence', result.verdict.confidence);
        span.setAttribute('total_tokens', result.cost.totalTokens);
        span.setAttribute('cost_usd', result.cost.estimatedUsd);
        span.setAttribute('duration_ms', result.durationMs);
      }

      logger.info('Tribunal debate completed', {
        id,
        topic: cfg.topic,
        verdict: result.verdict.recommendation,
        confidence: result.verdict.confidence,
        totalTokens: result.cost.totalTokens,
        estimatedUsd: result.cost.estimatedUsd,
        durationMs: result.durationMs,
      });
    } catch (error: any) {
      result.status = 'failed';
      result.error = error.message;
      result.durationMs = Date.now() - startTime;
      storeDebate(result);
      workHandle.fail(error.message);
      eventBus.publish('tribunal:failed', { debateId: id, topic: cfg.topic, error: error.message });
      logger.error('Tribunal debate failed', { id, error: error.message });
    }

    return result;
  }

  // ── Advocate Runner ─────────────────────────────────────

  private async runAdvocate(
    position: string,
    topic: string,
    framing: string,
    ragContext: string | undefined,
    opponentArgs: TribunalArgument[] | undefined,
    round: number
  ): Promise<{
    argument: TribunalArgument;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    };
    provider?: string;
  }> {
    let prompt = `## Debate Topic\n${topic}\n\n## Framing\n${framing}\n\n`;

    if (ragContext) {
      prompt += `## Project Context\n${ragContext}\n\n`;
    }

    if (opponentArgs && opponentArgs.length > 0) {
      prompt += `## Opponent Arguments (you must rebut these)\n`;
      for (const arg of opponentArgs) {
        prompt += `### ${arg.position}\n${arg.content}\n\n`;
      }
      prompt += `Now provide your rebuttal for position: "${position}". Address each opponent's specific claims.\n`;
    } else {
      prompt += `Present your initial argument for position: "${position}".\n`;
    }

    const result = await llm.completeWithBestProvider(prompt, {
      complexity: config.TRIBUNAL_ADVOCATE_COMPLEXITY,
      systemPrompt: advocateSystemPrompt(position),
      maxTokens: 2048,
      think: false,
    });

    return {
      argument: {
        position,
        content: result.text,
        round,
        tokens: result.usage?.totalTokens || 0,
      },
      usage: result.usage,
      provider: result.provider,
    };
  }

  // ── RAG Context Fetcher ─────────────────────────────────

  private async fetchRagContext(
    projectName: string,
    topic: string,
    positions: string[]
  ): Promise<string> {
    const parts: string[] = [];

    try {
      // Search codebase for topic relevance
      const query = `${topic} ${positions.join(' ')}`;
      const embedding = await embeddingService.embed(query);
      const codeResults = await vectorStore.search(`${projectName}_codebase`, embedding, 3);
      if (codeResults.length > 0) {
        parts.push('### Relevant Code');
        for (const r of codeResults) {
          parts.push(`- ${r.payload.file}: ${String(r.payload.content).slice(0, 200)}`);
        }
      }
    } catch (err: any) {
      logger.debug('Tribunal: codebase search failed', { error: err.message });
    }

    try {
      // Fetch existing ADRs and patterns
      const adrs = await memoryService.recall({
        projectName,
        query: `decision ${topic}`,
        type: 'decision',
        limit: 3,
      });
      if (adrs.length > 0) {
        parts.push('### Existing Decisions (ADRs)');
        for (const adr of adrs) {
          parts.push(`- ${adr.memory.content.slice(0, 300)}`);
        }
      }
    } catch (err: any) {
      logger.debug('Tribunal: memory recall failed', { error: err.message });
    }

    try {
      const patterns = await memoryService.recall({
        projectName,
        query: `pattern ${topic}`,
        type: 'context',
        limit: 3,
      });
      if (patterns.length > 0) {
        parts.push('### Existing Patterns');
        for (const p of patterns) {
          parts.push(`- ${p.memory.content.slice(0, 300)}`);
        }
      }
    } catch (err: any) {
      logger.debug('Tribunal: patterns recall failed', { error: err.message });
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }
}

export const tribunalService = new TribunalService();
export default tribunalService;
