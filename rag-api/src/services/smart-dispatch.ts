/**
 * Smart Dispatch Service - LLM-driven tool routing
 *
 * Instead of exposing 100+ tools for Claude to pick from,
 * this service reasons about which lookups to execute for a given task.
 *
 * Flow: task → LLM routing decision → parallel execution → consolidated result
 */

import { vectorStore } from './vector-store';
import { embeddingService, SparseVector } from './embedding';
import { memoryService } from './memory';
import { graphStore } from './graph-store';
import { symbolIndex } from './symbol-index';
import { llm } from './llm';
import { parseLLMOutput, routingSchema } from '../utils/llm-output';
import { logger } from '../utils/logger';
import { withSpan } from '../utils/tracing';
import { cacheService } from './cache';
import config from '../config';

export type LookupType =
  | 'memory'
  | 'code_search'
  | 'patterns'
  | 'adrs'
  | 'graph'
  | 'docs'
  | 'symbols';

export interface SmartDispatchRequest {
  projectName: string;
  task: string;
  files?: string[];
  intent?: 'code' | 'research' | 'debug' | 'review' | 'architecture';
}

export interface SmartDispatchResult {
  plan: LookupType[];
  reasoning: string;
  context: {
    memories?: any[];
    codeResults?: any[];
    patterns?: any[];
    adrs?: any[];
    graphDeps?: any[];
    docs?: any[];
    symbols?: any[];
  };
  timing: {
    planMs: number;
    executeMs: number;
    totalMs: number;
  };
}

const ROUTING_PROMPT = `Analyze this development task and decide which lookups are needed.
Available lookups:
- memory: past decisions, bugs, context from previous sessions
- code_search: find relevant source code by semantic similarity
- patterns: architectural patterns (how code should be structured)
- adrs: architecture decision records (why things were decided)
- graph: file dependencies, imports, blast radius
- docs: markdown documentation
- symbols: function/class/type definitions by name

Task: "{task}"
Files: {files}
{intentHint}

Return JSON: {"lookups": ["memory", "code_search", ...], "reasoning": "one sentence why"}
Choose 2-5 lookups. Skip lookups that clearly don't apply.`;

class SmartDispatchService {
  /**
   * Route a task to the appropriate lookups and execute them in parallel.
   */
  async dispatch(request: SmartDispatchRequest): Promise<SmartDispatchResult> {
    return withSpan(
      'smart_dispatch',
      {
        task: request.task.slice(0, 100),
        intent: request.intent || '',
        project: request.projectName,
      },
      async (span) => this._dispatch(request, span)
    );
  }

  private async _dispatch(request: SmartDispatchRequest, span?: any): Promise<SmartDispatchResult> {
    const totalStart = Date.now();
    const { projectName, task, files, intent } = request;

    // 4-Tier routing pipeline
    const planStart = Date.now();
    let plan: LookupType[];
    let reasoning: string;
    let routeSource: string;

    // Tier 0: Symbol pre-filter — deterministic, fast
    const symbolRoute = await this.symbolPreFilter(projectName, task);
    if (symbolRoute) {
      plan = symbolRoute;
      reasoning = 'Symbol pre-filter: found matching symbols → code_search + symbols + graph';
      routeSource = 'symbol-prefilter';
    } else {
      // Tier 1: Cross-session cache
      const cached = await this.getCachedRouting(projectName, task);
      if (cached) {
        plan = cached.lookups;
        reasoning = `Cache hit (confidence: ${cached.confidence.toFixed(2)}): ${cached.reasoning}`;
        routeSource = 'cache-hit';
      } else {
        // Tier 2: LLM routing
        try {
          const routingResult = await this.planLookups(task, files, intent);
          plan = routingResult.lookups;
          reasoning = routingResult.reasoning;
          routeSource = 'llm';
        } catch (error: any) {
          // Tier 3: Heuristic fallback
          logger.warn('LLM routing failed, using heuristic', { error: error.message });
          const heuristic = this.heuristicRoute(task, files, intent);
          plan = heuristic.lookups;
          reasoning = heuristic.reasoning;
          routeSource = 'heuristic';
        }

        // Cache the routing decision for future use (fire-and-forget)
        this.cacheRoutingDecision(projectName, task, plan, reasoning).catch(() => {});
      }
    }
    const planMs = Date.now() - planStart;

    // Execute lookups in parallel
    const executeStart = Date.now();
    const context = await this.executeLookups(projectName, task, files, plan);
    const executeMs = Date.now() - executeStart;

    const result = {
      plan,
      reasoning,
      context,
      timing: {
        planMs,
        executeMs,
        totalMs: Date.now() - totalStart,
      },
    };

    if (span?.setAttribute) {
      span.setAttribute('plan', plan.join(','));
      span.setAttribute('route_source', routeSource);
      span.setAttribute('plan_ms', planMs);
      span.setAttribute('execute_ms', executeMs);
    }

    return result;
  }

  // ── Tier 0: Symbol Pre-Filter ──────────────────────────

  /**
   * If the task mentions recognizable symbols, we know deterministically
   * that code_search + symbols + graph are needed.
   */
  private async symbolPreFilter(projectName: string, task: string): Promise<LookupType[] | null> {
    const symbols = task.match(/[A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*/g) || [];
    const uniqueSymbols = [...new Set(symbols)].slice(0, 3);
    if (uniqueSymbols.length === 0) return null;

    let resolved = 0;
    for (const sym of uniqueSymbols) {
      try {
        const results = await symbolIndex.findSymbol(projectName, sym, undefined, 1);
        if (results.length > 0) resolved++;
      } catch {
        // ignore
      }
    }

    if (resolved === 0) return null;
    return ['code_search', 'symbols', 'graph'];
  }

  // ── Tier 1: Cross-Session Cache ────────────────────────

  /**
   * Check Redis for a cached routing decision based on task embedding similarity.
   */
  private async getCachedRouting(
    projectName: string,
    task: string
  ): Promise<{ lookups: LookupType[]; reasoning: string; confidence: number } | null> {
    if (!cacheService.isEnabled()) return null;

    try {
      const embedding = await embeddingService.embed(task);
      const embeddingHash = this.hashEmbedding(embedding);
      const cacheKey = `routing:${projectName}:${embeddingHash}`;

      const cached = await cacheService.get<{
        lookups: LookupType[];
        reasoning: string;
        confidence: number;
        timestamp: number;
      }>(cacheKey);

      if (!cached) return null;

      // Apply confidence decay
      const daysSinceCreated = (Date.now() - cached.timestamp) / (1000 * 60 * 60 * 24);
      const decayedConfidence =
        cached.confidence * Math.exp(-config.DISPATCH_CONFIDENCE_DECAY * daysSinceCreated);

      if (decayedConfidence < config.DISPATCH_CONFIDENCE_THRESHOLD) {
        logger.debug('Smart dispatch cache expired (confidence decay)', {
          original: cached.confidence,
          decayed: decayedConfidence,
          days: daysSinceCreated,
        });
        return null;
      }

      return {
        lookups: cached.lookups,
        reasoning: cached.reasoning,
        confidence: decayedConfidence,
      };
    } catch (e: any) {
      logger.debug('Smart dispatch cache lookup failed', { error: e.message });
      return null;
    }
  }

  /**
   * Store a routing decision in Redis for cross-session reuse.
   */
  private async cacheRoutingDecision(
    projectName: string,
    task: string,
    lookups: LookupType[],
    reasoning: string
  ): Promise<void> {
    if (!cacheService.isEnabled()) return;

    try {
      const embedding = await embeddingService.embed(task);
      const embeddingHash = this.hashEmbedding(embedding);
      const cacheKey = `routing:${projectName}:${embeddingHash}`;
      const ttlSeconds = config.DISPATCH_CACHE_TTL_DAYS * 24 * 60 * 60;

      await cacheService.set(
        cacheKey,
        {
          lookups,
          reasoning,
          confidence: 1.0,
          timestamp: Date.now(),
        },
        ttlSeconds
      );
    } catch (e: any) {
      logger.debug('Smart dispatch cache write failed', { error: e.message });
    }
  }

  /**
   * Hash an embedding vector to a short string for cache key.
   */
  private hashEmbedding(embedding: number[]): string {
    // Use first 32 dimensions for a fast hash
    const slice = embedding.slice(0, 32).map((v) => Math.round(v * 1000));
    const crypto = require('crypto');
    return crypto.createHash('md5').update(slice.join(',')).digest('hex').slice(0, 16);
  }

  /**
   * LLM-based routing: analyze task and choose lookups.
   */
  private async planLookups(
    task: string,
    files?: string[],
    intent?: string
  ): Promise<{ lookups: LookupType[]; reasoning: string }> {
    const intentHint = intent ? `Intent: ${intent}` : '';
    const prompt = ROUTING_PROMPT.replace('{task}', task)
      .replace('{files}', files?.length ? files.join(', ') : 'none')
      .replace('{intentHint}', intentHint);

    const result = await llm.complete(prompt, {
      systemPrompt: 'You are a routing engine. Return only valid JSON. Be concise.',
      maxTokens: 200,
      temperature: 0.1,
      think: false,
      format: 'json',
    });

    const { data } = parseLLMOutput(
      result.text,
      routingSchema,
      { lookups: ['code_search'], reasoning: 'fallback' },
      'smart-dispatch'
    );
    const validLookups: LookupType[] = [
      'memory',
      'code_search',
      'patterns',
      'adrs',
      'graph',
      'docs',
      'symbols',
    ];
    const lookups = data.lookups.filter((l: string) =>
      validLookups.includes(l as LookupType)
    ) as LookupType[];

    // Ensure at least code_search is always included
    if (lookups.length === 0) {
      lookups.push('code_search');
    }

    return {
      lookups,
      reasoning: data.reasoning || 'LLM routing',
    };
  }

  /**
   * Heuristic routing fallback: pattern-match task text to decide lookups.
   */
  private heuristicRoute(
    task: string,
    files?: string[],
    intent?: string
  ): { lookups: LookupType[]; reasoning: string } {
    const t = task.toLowerCase();
    const lookups: LookupType[] = ['code_search']; // always
    let reasoning = 'Heuristic routing: ';

    // Memory for debug/fix tasks or when prior context matters
    if (/fix|bug|debug|error|broken|issue|wrong|fail/i.test(t)) {
      lookups.push('memory', 'graph');
      reasoning += 'debug task (memory + graph). ';
    }

    // Patterns + ADRs for refactoring/architecture tasks
    if (/refactor|restructur|architect|design|pattern|approach/i.test(t)) {
      lookups.push('patterns', 'adrs');
      reasoning += 'architecture task (patterns + ADRs). ';
    }

    // ADRs for feature implementation
    if (/add|implement|create|build|feature|new/i.test(t)) {
      lookups.push('patterns', 'adrs');
      reasoning += 'new feature (patterns + ADRs). ';
    }

    // Graph when files are specified
    if (files && files.length > 0 && !lookups.includes('graph')) {
      lookups.push('graph');
      reasoning += 'files specified (graph). ';
    }

    // Docs for understanding/explanation tasks
    if (/understand|explain|how does|what is|document/i.test(t)) {
      lookups.push('docs', 'memory');
      reasoning += 'understanding task (docs + memory). ';
    }

    // Review needs patterns and ADRs
    if (/review|check|validate|verify/i.test(t) || intent === 'review') {
      if (!lookups.includes('patterns')) lookups.push('patterns');
      if (!lookups.includes('adrs')) lookups.push('adrs');
      reasoning += 'review task (patterns + ADRs). ';
    }

    // Intent-based overrides
    if (intent === 'architecture') {
      if (!lookups.includes('patterns')) lookups.push('patterns');
      if (!lookups.includes('adrs')) lookups.push('adrs');
      if (!lookups.includes('memory')) lookups.push('memory');
    }

    // Deduplicate
    return { lookups: [...new Set(lookups)], reasoning: reasoning.trim() };
  }

  /**
   * Execute selected lookups in parallel and return consolidated context.
   */
  private async executeLookups(
    projectName: string,
    task: string,
    files: string[] | undefined,
    plan: LookupType[]
  ): Promise<SmartDispatchResult['context']> {
    const context: SmartDispatchResult['context'] = {};
    const lookupSet = new Set(plan);

    const promises: Promise<void>[] = [];

    if (lookupSet.has('memory')) {
      promises.push(
        memoryService
          .recall({ projectName, query: task, limit: 5, type: 'all' })
          .then((results) => {
            context.memories = results;
          })
          .catch((e) => {
            logger.debug('Smart dispatch: memory lookup failed', { error: e.message });
          })
      );
    }

    if (lookupSet.has('code_search')) {
      promises.push(
        this.searchCode(projectName, task)
          .then((results) => {
            context.codeResults = results;
          })
          .catch((e) => {
            logger.debug('Smart dispatch: code search failed', { error: e.message });
          })
      );
    }

    if (lookupSet.has('patterns')) {
      promises.push(
        memoryService
          .recall({ projectName, query: task, type: 'context', limit: 5, tag: 'pattern' })
          .then((results) => {
            context.patterns = results.filter((r: any) => r.memory?.tags?.includes('pattern'));
          })
          .catch((e) => {
            logger.debug('Smart dispatch: patterns lookup failed', { error: e.message });
          })
      );
    }

    if (lookupSet.has('adrs')) {
      promises.push(
        memoryService
          .recall({ projectName, query: task, type: 'decision', limit: 3, tag: 'adr' })
          .then((results) => {
            context.adrs = results.filter((r: any) => r.memory?.tags?.includes('adr'));
          })
          .catch((e) => {
            logger.debug('Smart dispatch: ADR lookup failed', { error: e.message });
          })
      );
    }

    if (lookupSet.has('graph')) {
      // If no files provided, try to infer them from symbols in the task
      const graphFiles =
        files && files.length > 0 ? files : await this.inferFiles(projectName, task);
      if (graphFiles.length > 0) {
        promises.push(
          graphStore
            .expand(projectName, graphFiles.slice(0, 5), 1)
            .then((expanded) => {
              const deps = expanded.filter((f) => !graphFiles.includes(f));
              context.graphDeps = deps.map((f) => ({ file: f }));
            })
            .catch((e) => {
              logger.debug('Smart dispatch: graph lookup failed', { error: e.message });
            })
        );
      }
    }

    if (lookupSet.has('docs')) {
      promises.push(
        this.searchDocs(projectName, task)
          .then((results) => {
            context.docs = results;
          })
          .catch((e) => {
            logger.debug('Smart dispatch: docs lookup failed', { error: e.message });
          })
      );
    }

    if (lookupSet.has('symbols')) {
      promises.push(
        this.searchSymbols(projectName, task)
          .then((results) => {
            context.symbols = results;
          })
          .catch((e) => {
            logger.debug('Smart dispatch: symbols lookup failed', { error: e.message });
          })
      );
    }

    await Promise.allSettled(promises);
    return context;
  }

  /**
   * Infer relevant file paths from symbol names found in the task text.
   */
  private async inferFiles(projectName: string, task: string): Promise<string[]> {
    const symbolCandidates = task.match(/[A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*/g) || [];
    const uniqueSymbols = [...new Set(symbolCandidates)].slice(0, 3);

    const files = new Set<string>();
    for (const sym of uniqueSymbols) {
      try {
        const results = await symbolIndex.findSymbol(projectName, sym, undefined, 1);
        for (const r of results) {
          if (r.file) files.add(r.file);
        }
      } catch {
        // Symbol lookup may fail
      }
    }

    return [...files].slice(0, 5);
  }

  /**
   * Search code collection with hybrid search.
   */
  private async searchCode(projectName: string, query: string): Promise<any[]> {
    const collection = `${projectName}_codebase`;
    let results;

    if (config.SPARSE_VECTORS_ENABLED) {
      const { dense, sparse } = await embeddingService.embedFull(query);
      results = await vectorStore.searchHybridNative(collection, dense, sparse, 8);
    } else {
      const embedding = await embeddingService.embed(query);
      results = await vectorStore.search(collection, embedding, 8);
    }

    // Deduplicate by file
    const seen = new Map<string, any>();
    for (const r of results) {
      const file = r.payload.file as string;
      if (!file) continue;
      if (!seen.has(file) || r.score > seen.get(file).score) {
        seen.set(file, r);
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => ({
        file: r.payload.file,
        symbols: r.payload.symbols || [],
        imports: r.payload.imports || [],
        preview: String(r.payload.content || '')
          .split('\n')
          .filter((l: string) => l.trim())
          .slice(0, 2)
          .join('\n'),
        score: r.score,
      }));
  }

  /**
   * Search docs collection.
   */
  private async searchDocs(projectName: string, query: string): Promise<any[]> {
    const collection = `${projectName}_docs`;
    try {
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(collection, embedding, 3);
      return results.map((r) => ({
        file: r.payload.file,
        content: String(r.payload.content || '').slice(0, 300),
        score: r.score,
      }));
    } catch (e: any) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  /**
   * Search symbol index for named entities in the task.
   */
  private async searchSymbols(projectName: string, task: string): Promise<any[]> {
    // Extract potential symbol names from task (camelCase, PascalCase, snake_case words)
    const symbolCandidates =
      task.match(/[A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*|[a-z_]{3,}/g) || [];
    const uniqueSymbols = [...new Set(symbolCandidates)].slice(0, 3);

    const allResults: any[] = [];
    for (const sym of uniqueSymbols) {
      try {
        const results = await symbolIndex.findSymbol(projectName, sym, undefined, 3);
        allResults.push(...results);
      } catch {
        // Symbol lookup may fail
      }
    }

    return allResults.slice(0, 5);
  }
}

export const smartDispatch = new SmartDispatchService();
export default smartDispatch;
