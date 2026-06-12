/**
 * Consolidation Agent — the "sleep" process for memory.
 *
 * Like the brain's hippocampal replay during sleep, this agent processes
 * a session's sensory buffer and working memory to decide what to store
 * in long-term memory and how.
 *
 * 7-step pipeline:
 * 1. REPLAY — Read working memory + sensory buffer
 * 2. PATTERN DETECTION — Find repeated queries, recurring files, error chains
 * 3. SIGNIFICANCE TAGGING — Score event clusters by importance
 * 4. ABSTRACTION — Convert episodes → semantic facts
 * 5. RELATIONSHIP CLASSIFICATION — LLM-powered edge typing
 * 6. INTEGRATION — Check against existing LTM for conflicts
 * 7. ANCHORING — Extract file/symbol references as cross-graph edges
 */

import { llm } from './llm';
import { sensoryBuffer, type SensoryEvent } from './sensory-buffer';
import { workingMemory, type WorkingMemorySlot } from './working-memory';
import { memoryLtm, type SemanticSubtype, type Anchor } from './memory-ltm';
import { relationshipClassifier, type ClassifiedRelation } from './relationship-classifier';
import { vectorStore } from './vector-store';
import { embeddingService } from './embedding';
import { graphStore } from './graph-store';
import { logger } from '../utils/logger';
import config from '../config';
import type { MemoryRelation } from './memory';

// ── Types ─────────────────────────────────────────────────

export interface ConsolidationResult {
  episodic: Array<{ id: string; content: string }>;
  semantic: Array<{ id: string; content: string; subtype: SemanticSubtype }>;
  relationships: ClassifiedRelation[];
  anchors: Anchor[];
  patternsDetected: number;
  totalEventsProcessed: number;
  durationMs: number;
}

export interface ExtractedPattern {
  type: 'repeated_query' | 'error_chain' | 'file_cluster' | 'decision_point';
  description: string;
  events: string[]; // event summaries
  files: string[];
  significance: number; // 0-1
}

export interface AbstractedMemory {
  content: string;
  subtype: SemanticSubtype;
  confidence: number;
  tags: string[];
  files: string[];
  isEpisodic: boolean; // true = store as episodic, false = semantic
}

/**
 * Self-contained snapshot of a session's consolidation inputs, taken at
 * batch-submit time (M4). Carried inside job payloads so retries NEVER
 * re-read the 24h-TTL sensory buffer, and so the raw WM slots can be
 * restored into working memory on terminal batch failure.
 */
export interface ConsolidationSnapshot {
  /** Raw WM slots — restored via workingMemory.insert on terminal failure. */
  wmSlots: WorkingMemorySlot[];
  /** Step-1 (pattern detection) input, built from WM slots + sensory events. */
  eventSummary: string;
  /** WM-derived observation lines (salience ≥ 0.5) — step-2 input alongside patterns. */
  wmObservationLines: string[];
  /** Sensory event count at snapshot time (drives the <3-items pattern skip). */
  totalEvents: number;
}

/**
 * Raised when an LLM step (pattern detection / abstraction) fails or times out.
 * Propagated out of consolidate() so the BullMQ job fails and is retried,
 * rather than reporting a fake "success" with zero output.
 */
export class ConsolidationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidationFailedError';
  }
}

// ── Prompts ───────────────────────────────────────────────

export const PATTERN_DETECTION_PROMPT = `Analyze these tool events from a coding session and identify important patterns.

Look for:
1. REPEATED QUERIES: Same or similar searches done multiple times (indicates difficulty finding something)
2. ERROR CHAINS: Errors followed by fixes (important debugging knowledge)
3. FILE CLUSTERS: Groups of files accessed together (indicates related components)
4. DECISION POINTS: Moments where a choice was made (architecture, approach, tool selection)

For each pattern, provide:
- type: one of "repeated_query", "error_chain", "file_cluster", "decision_point"
- description: what the pattern means (1-2 sentences)
- significance: 0.0 to 1.0 (how important is this for future sessions)
- files: related file paths

Respond with JSON: {"patterns": [...]}
Only include patterns with significance >= 0.5. If no significant patterns, return {"patterns": []}`;

export const ABSTRACTION_PROMPT = `Convert these session observations into reusable knowledge.

For each observation, classify it as EPISODIC or SEMANTIC:

EPISODIC (isEpisodic: true) — an event-shaped, time-anchored narrative whose sequence of events is the knowledge, worth keeping verbatim:
- Error-chain investigations: symptom → hypothesis → fix (the debugging path itself is what's valuable)
- Deploy/release incidents: what broke, what was tried, how it was resolved
- One-off session events where the order of steps explains the outcome
Examples:
- "Build failed with ECONNREFUSED to Qdrant; suspected a stale container; restarting docker-compose after pruning the network fixed it."
- "Release deploy hung: tag was pushed before the lockfile sync, so CI npm ci failed; regenerated the lockfile and re-tagged."

SEMANTIC (isEpisodic: false) — a durable, generalized fact, decision, or pattern that stays true independent of when it was learned:
- API contracts, naming conventions, configuration rules
- Architecture decisions and their rationale
- Recurring approaches and step-by-step procedures
Examples:
- "The BGE-M3 batch endpoint is /embed/batch, not /embed_batch."
- "Decision: all route validation uses centralized Zod schemas in utils/validation.ts."

Classify as EPISODIC only when the item is genuinely event-shaped — a specific occurrence whose sequence matters. If the lasting value is a general rule or fact, strip the narrative and store it as SEMANTIC. When in doubt, prefer SEMANTIC.

Always set a subtype: "decision" (a choice made), "insight" (a discovery), "pattern" (a recurring approach), "procedure" (step-by-step how-to). For EPISODIC items use the best fit (usually "insight").

For SEMANTIC items, abstract away session-specific details so the fact is useful in future sessions. For EPISODIC items, keep the concrete event sequence — that is the value.

Respond with JSON: {"memories": [{"content": "...", "subtype": "decision|insight|pattern|procedure", "confidence": 0.0-1.0, "tags": [...], "files": [...], "isEpisodic": true|false}]}

Rules:
- Don't store routine operations (just reading a file, listing memories)
- Don't store things that can be derived from the code itself
- Focus on: decisions made, bugs found and how they were fixed, architectural insights, workflow procedures, notable incidents
- Keep content concise but complete (1-3 sentences; episodic items may keep their step-by-step sequence)
- Include file paths when relevant`;

// ── Structured-output JSON schemas (M4 batch path) ────────
//
// Sent as `output_config.format` json_schema on the Batches path so the
// output is server-constrained — consumers parse with strict JSON.parse,
// never the regex parseJson salvage used on the Ollama path.

export const PATTERN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['repeated_query', 'error_chain', 'file_cluster', 'decision_point'],
          },
          description: { type: 'string' },
          significance: { type: 'number' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'description', 'significance', 'files'],
        additionalProperties: false,
      },
    },
  },
  required: ['patterns'],
  additionalProperties: false,
};

export const MEMORIES_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          subtype: { type: 'string', enum: ['decision', 'insight', 'pattern', 'procedure'] },
          confidence: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          isEpisodic: { type: 'boolean' },
        },
        required: ['content', 'subtype', 'confidence', 'tags', 'files', 'isEpisodic'],
        additionalProperties: false,
      },
    },
  },
  required: ['memories'],
  additionalProperties: false,
};

// ── Service ───────────────────────────────────────────────

class ConsolidationAgentService {
  /**
   * Run the full consolidation pipeline for a session.
   */
  async consolidate(
    projectName: string,
    sessionId: string,
    options?: { timeout?: number }
  ): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? config.CONSOLIDATION_TIMEOUT_MS;

    const result: ConsolidationResult = {
      episodic: [],
      semantic: [],
      relationships: [],
      anchors: [],
      patternsDetected: 0,
      totalEventsProcessed: 0,
      durationMs: 0,
    };

    try {
      // Step 1: REPLAY — gather all session data
      const [wmSlots, events] = await Promise.all([
        workingMemory.getAll(projectName, sessionId),
        sensoryBuffer.read(projectName, sessionId, { count: 500 }),
      ]);

      result.totalEventsProcessed = events.length;

      if (wmSlots.length === 0 && events.length === 0) {
        logger.debug('Consolidation: no events to process', { projectName, sessionId });
        result.durationMs = Date.now() - startTime;
        return result;
      }

      // Step 2: PATTERN DETECTION
      const patterns = await this.detectPatterns(
        wmSlots,
        events,
        timeout - (Date.now() - startTime)
      );
      result.patternsDetected = patterns.length;

      if (Date.now() - startTime > timeout)
        return this.finalize(result, startTime, projectName, sessionId);

      // Step 3: SIGNIFICANCE TAGGING (implicit in pattern detection scores)
      const significantPatterns = patterns.filter((p) => p.significance >= 0.5);

      // Step 4: ABSTRACTION — convert patterns + WM slots to memories
      const abstracted = await this.abstract(
        wmSlots,
        significantPatterns,
        timeout - (Date.now() - startTime)
      );

      if (Date.now() - startTime > timeout)
        return this.finalize(result, startTime, projectName, sessionId);

      // Steps 5 & 6 & 7: store memories with relationships and anchors
      return await this.storeAbstracted(projectName, sessionId, abstracted, {
        result,
        startTime,
        timeout,
      });
    } catch (error: any) {
      logger.warn('Consolidation failed', { error: error.message, projectName, sessionId });
      result.durationMs = Date.now() - startTime;
      // Ingest consolidation failure into sensory buffer (best-effort observability).
      this.ingestConsolidationEvent(projectName, sessionId, result, false, error.message);
      // THROW instead of returning a partial "success": this fails the BullMQ job so
      // it retries, and lets callers guard workingMemory.clear() (don't wipe the 24h
      // buffer on a failed/empty run).
      throw error instanceof ConsolidationFailedError
        ? error
        : new ConsolidationFailedError(`Consolidation failed: ${error.message}`);
    }
  }

  // ── Snapshot path (M4 batch consolidation) ────────────────

  /**
   * Build a self-contained consolidation snapshot from WM slots + sensory
   * events. Taken at batch-submit time so retries/continuations never have
   * to re-read the 24h-TTL sensory buffer.
   */
  buildSnapshot(wmSlots: WorkingMemorySlot[], events: SensoryEvent[]): ConsolidationSnapshot {
    return {
      wmSlots,
      eventSummary: this.buildEventSummary(wmSlots, events),
      wmObservationLines: this.buildWmObservationLines(wmSlots),
      totalEvents: events.length,
    };
  }

  /**
   * Sync (Ollama) consolidation driven entirely from a snapshot — the
   * fallback when the batch path terminally fails. Mirrors consolidate()
   * step-for-step but never touches working memory or the sensory buffer.
   */
  async consolidateSnapshot(
    projectName: string,
    sessionId: string,
    snapshot: ConsolidationSnapshot,
    options?: { timeout?: number }
  ): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? config.CONSOLIDATION_TIMEOUT_MS;

    const result: ConsolidationResult = {
      episodic: [],
      semantic: [],
      relationships: [],
      anchors: [],
      patternsDetected: 0,
      totalEventsProcessed: snapshot.totalEvents,
      durationMs: 0,
    };

    try {
      // Step 2: PATTERN DETECTION (same <3-items skip as the live path)
      let patterns: ExtractedPattern[] = [];
      if (
        snapshot.wmSlots.length + snapshot.totalEvents >= 3 &&
        snapshot.eventSummary.trim().length > 0
      ) {
        patterns = await this.detectPatternsFromSummary(
          snapshot.eventSummary,
          timeout - (Date.now() - startTime)
        );
      }
      result.patternsDetected = patterns.length;

      if (Date.now() - startTime > timeout)
        return this.finalize(result, startTime, projectName, sessionId);

      // Step 3 + 4: significance filter, then abstraction
      const significantPatterns = patterns.filter((p) => p.significance >= 0.5);
      const observations = this.buildObservations(significantPatterns, snapshot.wmObservationLines);
      if (!observations.trim()) {
        return this.finalize(result, startTime, projectName, sessionId);
      }

      const abstracted = await this.abstractFromObservations(
        observations,
        timeout - (Date.now() - startTime)
      );

      if (Date.now() - startTime > timeout)
        return this.finalize(result, startTime, projectName, sessionId);

      return await this.storeAbstracted(projectName, sessionId, abstracted, {
        result,
        startTime,
        timeout,
      });
    } catch (error: any) {
      logger.warn('Snapshot consolidation failed', {
        error: error.message,
        projectName,
        sessionId,
      });
      result.durationMs = Date.now() - startTime;
      this.ingestConsolidationEvent(projectName, sessionId, result, false, error.message);
      throw error instanceof ConsolidationFailedError
        ? error
        : new ConsolidationFailedError(`Snapshot consolidation failed: ${error.message}`);
    }
  }

  /**
   * Steps 5 & 6 & 7 — store abstracted memories with relationships and
   * anchors, then finalize. Shared by consolidate(), consolidateSnapshot()
   * and the batch finalize continuation. Relationship classification stays
   * sync Ollama (v1) on every path.
   */
  async storeAbstracted(
    projectName: string,
    sessionId: string,
    abstracted: AbstractedMemory[],
    opts: { result?: ConsolidationResult; startTime?: number; timeout?: number } = {}
  ): Promise<ConsolidationResult> {
    const startTime = opts.startTime ?? Date.now();
    const timeout = opts.timeout ?? config.CONSOLIDATION_TIMEOUT_MS;
    const result: ConsolidationResult = opts.result ?? {
      episodic: [],
      semantic: [],
      relationships: [],
      anchors: [],
      patternsDetected: 0,
      totalEventsProcessed: 0,
      durationMs: 0,
    };

    for (const mem of abstracted) {
      if (Date.now() - startTime > timeout) break;

      try {
        // Step 7: ANCHORING — extract file/symbol references
        const anchors = this.extractAnchors(mem.content, mem.files);
        result.anchors.push(...anchors);

        // File paths from anchors for graph cross-linking
        const anchorFiles = anchors.filter((a) => a.type === 'file').map((a) => a.path);

        if (mem.isEpisodic) {
          // Store as episodic
          const stored = await memoryLtm.storeEpisodic({
            projectName,
            content: mem.content,
            sessionId,
            files: mem.files,
            tags: mem.tags,
            anchors,
          });
          result.episodic.push({ id: stored.id, content: stored.content });

          // Cross-link memory → files in graph
          await graphStore.indexMemoryEdges(projectName, stored.id, 'episodic', anchorFiles);
        } else {
          // Step 5 & 6: Classify relationships with existing semantic memories
          let relationships: MemoryRelation[] = [];
          try {
            relationships = await this.classifyWithExisting(projectName, mem.content, mem.subtype);
            result.relationships.push(
              ...relationships.map((r) => ({
                targetId: r.targetId,
                type: r.type as any,
                reason: r.reason ?? '',
                confidence: 0.7,
              }))
            );
          } catch {
            /* non-critical */
          }

          // Store as semantic
          const stored = await memoryLtm.storeSemantic({
            projectName,
            content: mem.content,
            subtype: mem.subtype,
            confidence: mem.confidence,
            tags: mem.tags,
            anchors,
            relationships,
            source: 'consolidation',
          });
          result.semantic.push({ id: stored.id, content: stored.content, subtype: mem.subtype });

          // Cross-link memory → files in graph
          await graphStore.indexMemoryEdges(projectName, stored.id, mem.subtype, anchorFiles);
        }
      } catch (error: any) {
        logger.debug('Failed to store consolidated memory', { error: error.message });
      }
    }

    return this.finalize(result, startTime, projectName, sessionId);
  }

  // ── Step 2: Pattern Detection ─────────────────────────────

  private buildEventSummary(wmSlots: WorkingMemorySlot[], events: SensoryEvent[]): string {
    return [
      ...wmSlots.map(
        (s) =>
          `[WM] ${s.toolName}: ${s.content} (salience=${s.salience.toFixed(1)}, files=${s.files.join(',')})`
      ),
      ...events
        .slice(-50)
        .map(
          (e) =>
            `[${e.success ? 'OK' : 'ERR'}] ${e.toolName}: ${e.inputSummary} (${e.durationMs}ms)`
        ),
    ].join('\n');
  }

  private async detectPatterns(
    wmSlots: WorkingMemorySlot[],
    events: SensoryEvent[],
    remainingMs: number
  ): Promise<ExtractedPattern[]> {
    if (wmSlots.length + events.length < 3) return [];

    // Build event summary for LLM
    const eventSummary = this.buildEventSummary(wmSlots, events);

    logger.debug('Consolidation REPLAY input', {
      wmSlots: wmSlots.length,
      events: events.length,
      eventSummaryLen: eventSummary.length,
      eventSummaryPreview: eventSummary.slice(0, 500),
    });

    return this.detectPatternsFromSummary(eventSummary, remainingMs);
  }

  private async detectPatternsFromSummary(
    eventSummary: string,
    remainingMs: number
  ): Promise<ExtractedPattern[]> {
    try {
      const result = await this.llmCall(
        `Session events:\n${eventSummary.slice(0, 3000)}`,
        PATTERN_DETECTION_PROMPT,
        Math.min(remainingMs, config.CONSOLIDATION_LLM_TIMEOUT_MS)
      );

      logger.debug('Consolidation PATTERN_DETECTION output', {
        rawLen: result.length,
        rawPreview: result.slice(0, 500),
      });

      const parsed = this.parseJson<{ patterns: ExtractedPattern[] }>(result);
      return parsed?.patterns ?? [];
    } catch (error: any) {
      logger.warn('Pattern detection LLM call failed', { error: error.message });
      // Surface as a failure so consolidate() can fail the job (BullMQ retry).
      throw new ConsolidationFailedError(`Pattern detection failed: ${error.message}`);
    }
  }

  // ── Step 4: Abstraction ───────────────────────────────────

  private buildWmObservationLines(wmSlots: WorkingMemorySlot[]): string[] {
    return wmSlots
      .filter((s) => s.salience >= 0.5)
      .map((s) => `[${s.toolName}] ${s.content} (files: ${s.files.join(', ')})`);
  }

  private buildObservations(patterns: ExtractedPattern[], wmLines: string[]): string {
    return [
      ...patterns.map(
        (p) => `[PATTERN: ${p.type}] ${p.description} (files: ${p.files.join(', ')})`
      ),
      ...wmLines,
    ].join('\n');
  }

  private async abstract(
    wmSlots: WorkingMemorySlot[],
    patterns: ExtractedPattern[],
    remainingMs: number
  ): Promise<AbstractedMemory[]> {
    if (wmSlots.length === 0 && patterns.length === 0) return [];

    const observations = this.buildObservations(patterns, this.buildWmObservationLines(wmSlots));

    logger.debug('Consolidation ABSTRACTION input', {
      patternsCount: patterns.length,
      wmSlotsAboveThreshold: wmSlots.filter((s) => s.salience >= 0.5).length,
      observationsLen: observations.length,
      observationsPreview: observations.slice(0, 500),
    });

    if (!observations.trim()) {
      logger.debug('Consolidation ABSTRACTION: empty observations, skipping LLM call');
      return [];
    }

    return this.abstractFromObservations(observations, remainingMs);
  }

  private async abstractFromObservations(
    observations: string,
    remainingMs: number
  ): Promise<AbstractedMemory[]> {
    try {
      const result = await this.llmCall(
        `Session observations:\n${observations.slice(0, 3000)}`,
        ABSTRACTION_PROMPT,
        Math.min(remainingMs, config.CONSOLIDATION_LLM_TIMEOUT_MS)
      );

      logger.debug('Consolidation ABSTRACTION output', {
        rawLen: result.length,
        rawPreview: result.slice(0, 500),
      });

      const parsed = this.parseJson<{ memories: AbstractedMemory[] }>(result);
      // A well-formed empty list is a legitimate "nothing worth storing" outcome.
      if (!parsed?.memories) return [];

      return this.normalizeAbstracted(parsed.memories);
    } catch (error: any) {
      logger.debug('Abstraction LLM call failed', { error });
      // Surface as a failure so consolidate() can fail the job (BullMQ retry).
      throw new ConsolidationFailedError(`Abstraction failed: ${error?.message ?? error}`);
    }
  }

  /** Validate and normalize raw LLM-produced memories (shared sync + batch). */
  normalizeAbstracted(memories: AbstractedMemory[]): AbstractedMemory[] {
    const validSubtypes = new Set<string>(['decision', 'insight', 'pattern', 'procedure']);
    return memories
      .filter((m) => m.content && m.content.length > 10)
      .map((m) => ({
        content: m.content.slice(0, 2000),
        subtype: validSubtypes.has(m.subtype) ? m.subtype : ('insight' as SemanticSubtype),
        confidence: Math.min(1, Math.max(0, m.confidence ?? 0.6)),
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
        files: Array.isArray(m.files) ? m.files.slice(0, 20) : [],
        isEpisodic: m.isEpisodic ?? false,
      }));
  }

  // ── Step 5 & 6: Relationship Classification + Integration ──

  private async classifyWithExisting(
    projectName: string,
    content: string,
    subtype: SemanticSubtype
  ): Promise<MemoryRelation[]> {
    // Find similar existing semantic memories
    const embedding = await embeddingService.embed(content);
    const collection = `${projectName}_memory_semantic`;

    let candidates;
    try {
      candidates = await vectorStore.search(collection, embedding, 5, undefined, 0.6);
    } catch {
      return []; // Collection may not exist yet
    }

    if (candidates.length === 0) return [];

    // Use LLM classifier
    const classified = await relationshipClassifier.classify(
      { content, type: subtype },
      candidates.map((c) => ({
        id: c.id,
        content: (c.payload.content as string) ?? '',
        type: (c.payload.subtype as string) ?? 'insight',
      }))
    );

    return classified.map((c) => ({
      targetId: c.targetId,
      type: c.type as any,
      reason: c.reason,
    }));
  }

  // ── Step 7: Anchor Extraction ─────────────────────────────

  private extractAnchors(content: string, files: string[]): Anchor[] {
    const anchors: Anchor[] = [];

    // File anchors from explicit file list
    for (const file of files) {
      if ((file && file.includes('/')) || file.includes('.')) {
        anchors.push({ type: 'file', path: file });
      }
    }

    // Extract file paths from content
    const filePattern = /(?:[\w@/.-]+\/)?[\w.-]+\.(ts|js|tsx|jsx|py|go|rs|vue|json|yaml|yml)/g;
    const contentFiles = content.match(filePattern) ?? [];
    for (const f of contentFiles) {
      if (!anchors.some((a) => a.path === f)) {
        anchors.push({ type: 'file', path: f });
      }
    }

    // Extract symbol names (PascalCase identifiers likely to be classes/components)
    const symbolPattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
    const symbols = content.match(symbolPattern) ?? [];
    for (const s of symbols.slice(0, 5)) {
      anchors.push({ type: 'symbol', path: '', name: s });
    }

    return anchors.slice(0, 20);
  }

  // ── Helpers ───────────────────────────────────────────────

  private async llmCall(prompt: string, systemPrompt: string, timeoutMs: number): Promise<string> {
    // Enforce CONSOLIDATION_LLM_TIMEOUT_MS by aborting the in-flight provider call:
    // completeWithBestProvider now threads `signal` into the actual HTTP/SDK request
    // (axios + Anthropic SDK both honor it), so controller.abort() truly cancels the
    // call rather than leaking it. The Promise.race against the timer remains as a
    // backstop so we reject promptly even if a provider ignores the signal.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error(`Consolidation LLM call timed out after ${timeoutMs}ms`));
        },
        Math.max(1, timeoutMs)
      );
    });

    const callPromise = llm
      .completeWithBestProvider(prompt, {
        complexity: 'utility',
        caller: 'consolidation',
        effort: 'medium', // only takes effect if this call is ever routed to Anthropic (e.g. M4 batch path)
        systemPrompt,
        // Note: format:'json' causes empty responses on qwen3.5:9b — rely on prompt instruction instead
        maxTokens: 2000,
        temperature: 0.2,
        think: false,
        signal: controller.signal,
      })
      .then((result) => result.text);

    try {
      return await Promise.race([callPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseJson<T>(text: string): T | null {
    try {
      // Try to find JSON object in response
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) return JSON.parse(objMatch[0]) as T;
      return null;
    } catch {
      return null;
    }
  }

  private finalize(
    result: ConsolidationResult,
    startTime: number,
    projectName?: string,
    sessionId?: string
  ): ConsolidationResult {
    result.durationMs = Date.now() - startTime;
    logger.info('Consolidation complete', {
      episodic: result.episodic.length,
      semantic: result.semantic.length,
      relationships: result.relationships.length,
      patterns: result.patternsDetected,
      events: result.totalEventsProcessed,
      durationMs: result.durationMs,
    });

    // Ingest consolidation result into sensory buffer
    if (projectName && sessionId) {
      this.ingestConsolidationEvent(projectName, sessionId, result, true);
    }

    return result;
  }

  /** Fire-and-forget: capture consolidation result as sensory event */
  private ingestConsolidationEvent(
    projectName: string,
    sessionId: string,
    result: ConsolidationResult,
    success: boolean,
    errorMessage?: string
  ): void {
    const outputParts = [
      `episodic: ${result.episodic.length}`,
      `semantic: ${result.semantic.length}`,
      `patterns: ${result.patternsDetected}`,
      `events: ${result.totalEventsProcessed}`,
      `duration: ${result.durationMs}ms`,
    ];
    if (errorMessage) outputParts.push(`error: ${errorMessage}`);

    sensoryBuffer
      .append(projectName, sessionId, {
        toolName: 'consolidation',
        inputSummary: `Consolidation for session ${sessionId}`,
        outputSummary: outputParts.join(', '),
        filesTouched: result.anchors
          .filter((a) => a.type === 'file')
          .map((a) => a.path)
          .slice(0, 20),
        success,
        durationMs: result.durationMs,
        salience: success ? 0.85 : 1.0,
        timestamp: new Date().toISOString(),
      })
      .catch(() => {});
  }
}

export const consolidationAgent = new ConsolidationAgentService();
