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
import { logger } from '../utils/logger';
import config from '../config';

export type LookupType = 'memory' | 'code_search' | 'patterns' | 'adrs' | 'graph' | 'docs' | 'symbols';

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
    const totalStart = Date.now();
    const { projectName, task, files, intent } = request;

    // Step 1: LLM routing decision
    const planStart = Date.now();
    let plan: LookupType[];
    let reasoning: string;

    try {
      const routingResult = await this.planLookups(task, files, intent);
      plan = routingResult.lookups;
      reasoning = routingResult.reasoning;
    } catch (error: any) {
      // Fallback: if LLM fails, use heuristic routing
      logger.warn('LLM routing failed, using heuristic', { error: error.message });
      const heuristic = this.heuristicRoute(task, files, intent);
      plan = heuristic.lookups;
      reasoning = heuristic.reasoning;
    }
    const planMs = Date.now() - planStart;

    // Step 2: Execute lookups in parallel
    const executeStart = Date.now();
    const context = await this.executeLookups(projectName, task, files, plan);
    const executeMs = Date.now() - executeStart;

    return {
      plan,
      reasoning,
      context,
      timing: {
        planMs,
        executeMs,
        totalMs: Date.now() - totalStart,
      },
    };
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
    const prompt = ROUTING_PROMPT
      .replace('{task}', task)
      .replace('{files}', files?.length ? files.join(', ') : 'none')
      .replace('{intentHint}', intentHint);

    const result = await llm.complete(prompt, {
      systemPrompt: 'You are a routing engine. Return only valid JSON. Be concise.',
      maxTokens: 200,
      temperature: 0.1,
      think: false,
      format: 'json',
    });

    const parsed = JSON.parse(result.text);
    const validLookups: LookupType[] = ['memory', 'code_search', 'patterns', 'adrs', 'graph', 'docs', 'symbols'];
    const lookups = (parsed.lookups || []).filter((l: string) => validLookups.includes(l as LookupType)) as LookupType[];

    // Ensure at least code_search is always included
    if (lookups.length === 0) {
      lookups.push('code_search');
    }

    return {
      lookups,
      reasoning: parsed.reasoning || 'LLM routing',
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
        memoryService.recall({ projectName, query: task, limit: 5, type: 'all' })
          .then(results => { context.memories = results; })
          .catch(e => { logger.debug('Smart dispatch: memory lookup failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('code_search')) {
      promises.push(
        this.searchCode(projectName, task)
          .then(results => { context.codeResults = results; })
          .catch(e => { logger.debug('Smart dispatch: code search failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('patterns')) {
      promises.push(
        memoryService.recall({ projectName, query: task, type: 'context', limit: 5, tag: 'pattern' })
          .then(results => { context.patterns = results.filter((r: any) => r.memory?.tags?.includes('pattern')); })
          .catch(e => { logger.debug('Smart dispatch: patterns lookup failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('adrs')) {
      promises.push(
        memoryService.recall({ projectName, query: task, type: 'decision', limit: 3, tag: 'adr' })
          .then(results => { context.adrs = results.filter((r: any) => r.memory?.tags?.includes('adr')); })
          .catch(e => { logger.debug('Smart dispatch: ADR lookup failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('graph') && files && files.length > 0) {
      promises.push(
        graphStore.expand(projectName, files.slice(0, 5), 1)
          .then(expanded => {
            const deps = expanded.filter(f => !files.includes(f));
            context.graphDeps = deps.map(f => ({ file: f }));
          })
          .catch(e => { logger.debug('Smart dispatch: graph lookup failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('docs')) {
      promises.push(
        this.searchDocs(projectName, task)
          .then(results => { context.docs = results; })
          .catch(e => { logger.debug('Smart dispatch: docs lookup failed', { error: e.message }); })
      );
    }

    if (lookupSet.has('symbols')) {
      promises.push(
        this.searchSymbols(projectName, task)
          .then(results => { context.symbols = results; })
          .catch(e => { logger.debug('Smart dispatch: symbols lookup failed', { error: e.message }); })
      );
    }

    await Promise.allSettled(promises);
    return context;
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
      .map(r => ({
        file: r.payload.file,
        symbols: r.payload.symbols || [],
        imports: r.payload.imports || [],
        preview: String(r.payload.content || '').split('\n').filter((l: string) => l.trim()).slice(0, 2).join('\n'),
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
      return results.map(r => ({
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
    const symbolCandidates = task.match(/[A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*|[a-z_]{3,}/g) || [];
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
