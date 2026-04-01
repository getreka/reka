/**
 * Context Pack Builder - Deterministic faceted context assembly with reranking and token budget.
 *
 * Replaces simple top-K concatenation with:
 * 1. Facet decomposition (which collections to query)
 * 2. Per-facet retrieval from typed collections
 * 3. Hybrid fusion (semantic + keyword)
 * 4. LLM-based reranking
 * 5. Token budget compression
 * 6. Guardrails (ADRs, test commands)
 */

import { vectorStore, SearchResult } from './vector-store';
import { embeddingService, SparseVector } from './embedding';
import { llm } from './llm';
import { memoryService } from './memory';
import { graphStore } from './graph-store';
import { logger } from '../utils/logger';
import config from '../config';
import { contextPackDuration, contextPackTokens, rerankDuration } from '../utils/metrics';

export interface ContextPackOptions {
  projectName: string;
  query: string;
  maxTokens: number;
  semanticWeight?: number;
  includeADRs?: boolean;
  includeTests?: boolean;
  graphExpand?: boolean;
}

interface ContextFacet {
  name: string;
  collection: string;
  priority: number; // lower = higher priority
  limit: number;
}

interface RankedChunk {
  file: string;
  content: string;
  language: string;
  score: number;
  facet: string;
  tokens: number;
}

export interface ContextPack {
  facets: Array<{
    name: string;
    chunks: Array<{ file: string; content: string; score: number }>;
  }>;
  totalTokens: number;
  guardrails: {
    relatedADRs: string[];
    testCommands: string[];
    invariants: string[];
  };
  assembled: string;
}

class ContextPackBuilder {
  /**
   * Build a context pack with faceted retrieval, reranking, and token budget.
   */
  async build(options: ContextPackOptions): Promise<ContextPack> {
    const startTime = Date.now();
    const {
      projectName,
      query,
      maxTokens = 8000,
      semanticWeight = 0.7,
      includeADRs = true,
      includeTests = false,
      graphExpand = true,
    } = options;

    try {
      // Step 1: Decompose into facets
      const facets = this.decomposeFacets(query, projectName);

      // Step 2: Retrieve per-facet
      let embedding: number[];
      let sparseEmbedding: SparseVector | undefined;

      if (config.SPARSE_VECTORS_ENABLED) {
        const full = await embeddingService.embedFull(query);
        embedding = full.dense;
        sparseEmbedding = full.sparse;
      } else {
        embedding = await embeddingService.embed(query);
      }

      const allChunks: RankedChunk[] = [];

      // Parallel facet retrieval
      const facetResults = await Promise.allSettled(
        facets.map((facet) =>
          this.retrieveFacet(facet, embedding, query, semanticWeight, sparseEmbedding).then(
            (results) => ({ facet, results })
          )
        )
      );

      for (const result of facetResults) {
        if (result.status === 'fulfilled') {
          const { facet, results } = result.value;
          for (const r of results) {
            allChunks.push({
              file: (r.payload.file as string) || 'unknown',
              content: (r.payload.content as string) || '',
              language: (r.payload.language as string) || '',
              score: r.score,
              facet: facet.name,
              tokens: this.estimateTokens((r.payload.content as string) || ''),
            });
          }
        } else {
          logger.debug(`Facet retrieval failed`, { error: result.reason?.message });
        }
      }

      // Step 3: Graph expansion (add connected files)
      if (graphExpand && allChunks.length > 0) {
        const seedFiles = [...new Set(allChunks.map((c) => c.file).filter(Boolean))];
        try {
          const expandedFiles = await graphStore.expand(projectName, seedFiles.slice(0, 5), 1);
          const newFiles = expandedFiles.filter((f) => !seedFiles.includes(f)).slice(0, 5);

          for (const file of newFiles) {
            try {
              const results = await vectorStore.search(`${projectName}_codebase`, embedding, 1, {
                must: [{ key: 'file', match: { value: file } }],
              });
              for (const r of results) {
                allChunks.push({
                  file: (r.payload.file as string) || file,
                  content: (r.payload.content as string) || '',
                  language: (r.payload.language as string) || '',
                  score: r.score * 0.8, // Slightly lower score for graph-expanded
                  facet: 'graph',
                  tokens: this.estimateTokens((r.payload.content as string) || ''),
                });
              }
            } catch {
              // Skip files that fail
            }
          }
        } catch (error: any) {
          logger.debug('Graph expansion failed', { error: error.message });
        }
      }

      // Step 4: Rerank (LLM-based if enough chunks)
      let rankedChunks = allChunks;
      if (allChunks.length > 5) {
        try {
          rankedChunks = await this.rerank(query, allChunks);
        } catch (error: any) {
          logger.debug('Reranking failed, using score-based order', { error: error.message });
          rankedChunks = allChunks.sort((a, b) => b.score - a.score);
        }
      } else {
        rankedChunks = allChunks.sort((a, b) => b.score - a.score);
      }

      // Step 5: Compress to token budget
      const selectedChunks = this.compressToTokenBudget(rankedChunks, maxTokens);

      // Step 6: Add guardrails
      const guardrails = await this.addGuardrails(projectName, query, includeADRs, includeTests);

      // Assemble final context
      const assembled = this.assembleContext(selectedChunks, guardrails);

      // Group by facet for response
      const facetGroups = new Map<string, RankedChunk[]>();
      for (const chunk of selectedChunks) {
        if (!facetGroups.has(chunk.facet)) {
          facetGroups.set(chunk.facet, []);
        }
        facetGroups.get(chunk.facet)!.push(chunk);
      }

      const totalTokens = selectedChunks.reduce((sum, c) => sum + c.tokens, 0);

      contextPackTokens.observe({ project: projectName }, totalTokens);
      contextPackDuration.observe({ project: projectName }, (Date.now() - startTime) / 1000);

      return {
        facets: Array.from(facetGroups.entries()).map(([name, chunks]) => ({
          name,
          chunks: chunks.map((c) => ({ file: c.file, content: c.content, score: c.score })),
        })),
        totalTokens,
        guardrails,
        assembled,
      };
    } catch (error: any) {
      contextPackDuration.observe({ project: projectName }, (Date.now() - startTime) / 1000);
      throw error;
    }
  }

  /**
   * Step 1: Determine which collections to query based on query keywords.
   */
  private decomposeFacets(query: string, projectName: string): ContextFacet[] {
    const q = query.toLowerCase();
    const facets: ContextFacet[] = [];

    // Always include code
    facets.push({
      name: 'code',
      collection: `${projectName}_codebase`,
      priority: 1,
      limit: 8,
    });

    // Include docs if query mentions docs, readme, documentation
    if (/doc|readme|guide|how to|tutorial|explain/i.test(q)) {
      facets.push({
        name: 'docs',
        collection: `${projectName}_docs`,
        priority: 2,
        limit: 4,
      });
    }

    // Include config if query mentions config, env, settings, yaml
    if (/config|env|setting|yaml|json|deploy|docker/i.test(q)) {
      facets.push({
        name: 'config',
        collection: `${projectName}_config`,
        priority: 3,
        limit: 3,
      });
    }

    // Include contracts if query mentions API, schema, proto, graphql
    if (/api|schema|proto|graphql|openapi|swagger|endpoint|contract/i.test(q)) {
      facets.push({
        name: 'contracts',
        collection: `${projectName}_contracts`,
        priority: 2,
        limit: 4,
      });
    }

    return facets;
  }

  /**
   * Step 2: Retrieve results for a facet using hybrid search.
   */
  private async retrieveFacet(
    facet: ContextFacet,
    embedding: number[],
    query: string,
    semanticWeight: number,
    sparseEmbedding?: SparseVector
  ): Promise<SearchResult[]> {
    // Use native hybrid search if sparse vectors available
    if (config.SPARSE_VECTORS_ENABLED && sparseEmbedding) {
      return vectorStore.searchHybridNative(
        facet.collection,
        embedding,
        sparseEmbedding,
        facet.limit
      );
    }

    // Fallback: semantic + text-match fusion
    const semanticResults = await vectorStore.search(facet.collection, embedding, facet.limit * 2);

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    let keywordResults: SearchResult[] = [];

    if (keywords.length > 0 && semanticWeight < 1) {
      try {
        const keywordFilter = {
          should: keywords.map((kw) => ({
            key: 'content',
            match: { text: kw },
          })),
        };
        keywordResults = await vectorStore.search(
          facet.collection,
          embedding,
          facet.limit * 2,
          keywordFilter
        );
      } catch {
        // Keyword search may fail on some collections
      }
    }

    return this.hybridFusion(semanticResults, keywordResults, semanticWeight, facet.limit);
  }

  /**
   * Step 3: Combine semantic and keyword results.
   */
  private hybridFusion(
    semantic: SearchResult[],
    keyword: SearchResult[],
    weight: number,
    limit: number
  ): SearchResult[] {
    const resultMap = new Map<
      string,
      { result: SearchResult; semanticScore: number; keywordScore: number }
    >();

    for (const r of semantic) {
      resultMap.set(r.id, { result: r, semanticScore: r.score, keywordScore: 0 });
    }

    for (const r of keyword) {
      if (resultMap.has(r.id)) {
        resultMap.get(r.id)!.keywordScore = r.score;
      } else {
        resultMap.set(r.id, { result: r, semanticScore: r.score * 0.5, keywordScore: r.score });
      }
    }

    return Array.from(resultMap.values())
      .map(({ result, semanticScore, keywordScore }) => ({
        ...result,
        score: weight * semanticScore + (1 - weight) * keywordScore,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Step 4: LLM-based reranking of candidates.
   */
  private async rerank(query: string, chunks: RankedChunk[]): Promise<RankedChunk[]> {
    const startTime = Date.now();

    // Prepare candidates for reranking (top 20 by score)
    const candidates = chunks.sort((a, b) => b.score - a.score).slice(0, 20);

    const candidateList = candidates
      .map((c, i) => `[${i}] ${c.file}: ${c.content.slice(0, 200)}`)
      .join('\n');

    try {
      const result = await llm.complete(
        `Given the query: "${query}"\n\nRank these code snippets by relevance (most relevant first). Return ONLY a JSON array of indices, e.g. [3, 0, 7, 1, ...].\n\nSnippets:\n${candidateList}`,
        {
          systemPrompt:
            'You are a code relevance ranker. Return only a JSON array of snippet indices ordered by relevance.',
          maxTokens: 256,
          temperature: 0,
          think: false,
          format: 'json',
        }
      );

      // Parse ranking
      const match = result.text.match(/\[[\d,\s]+\]/);
      if (match) {
        const indices: number[] = JSON.parse(match[0]);
        const reranked: RankedChunk[] = [];
        const used = new Set<number>();

        for (const idx of indices) {
          if (idx >= 0 && idx < candidates.length && !used.has(idx)) {
            const chunk = candidates[idx];
            reranked.push({
              ...chunk,
              score: 1 - reranked.length * 0.05, // Normalize scores by rank position
            });
            used.add(idx);
          }
        }

        // Add any candidates not in the ranking
        for (let i = 0; i < candidates.length; i++) {
          if (!used.has(i)) {
            reranked.push(candidates[i]);
          }
        }

        // Add remaining chunks not in candidates
        const candidateFiles = new Set(candidates.map((c) => c.file + c.content.slice(0, 50)));
        for (const chunk of chunks) {
          if (!candidateFiles.has(chunk.file + chunk.content.slice(0, 50))) {
            reranked.push(chunk);
          }
        }

        rerankDuration.observe({}, (Date.now() - startTime) / 1000);
        return reranked;
      }
    } catch (error: any) {
      logger.debug('LLM reranking failed', { error: error.message });
    }

    rerankDuration.observe({}, (Date.now() - startTime) / 1000);
    return chunks.sort((a, b) => b.score - a.score);
  }

  /**
   * Step 5: Select chunks that fit within token budget.
   */
  private compressToTokenBudget(chunks: RankedChunk[], maxTokens: number): RankedChunk[] {
    const selected: RankedChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      if (currentTokens + chunk.tokens <= maxTokens) {
        selected.push(chunk);
        currentTokens += chunk.tokens;
      } else if (currentTokens < maxTokens * 0.9) {
        // Try to fit a truncated version
        const remainingTokens = maxTokens - currentTokens;
        const truncatedContent = chunk.content.slice(0, remainingTokens * 4); // ~4 chars per token
        if (truncatedContent.length > 50) {
          selected.push({
            ...chunk,
            content: truncatedContent + '\n... [truncated]',
            tokens: this.estimateTokens(truncatedContent),
          });
        }
        break;
      } else {
        break;
      }
    }

    return selected;
  }

  /**
   * Step 6: Add guardrails (related ADRs, test commands).
   */
  private async addGuardrails(
    projectName: string,
    query: string,
    includeADRs: boolean,
    includeTests: boolean
  ): Promise<ContextPack['guardrails']> {
    const guardrails: ContextPack['guardrails'] = {
      relatedADRs: [],
      testCommands: [],
      invariants: [],
    };

    if (includeADRs) {
      try {
        const adrs = await memoryService.recall({
          projectName,
          query: `decision ${query}`,
          type: 'decision',
          limit: 3,
        });
        guardrails.relatedADRs = adrs
          .filter((a) => a.score >= 0.5)
          .map((a) => a.memory.content.slice(0, 200));
      } catch {
        // Non-critical
      }
    }

    if (includeTests) {
      try {
        const tests = await memoryService.recall({
          projectName,
          query: `test command ${query}`,
          type: 'context',
          limit: 3,
        });
        guardrails.testCommands = tests
          .filter((t) => t.score >= 0.5)
          .map((t) => t.memory.content.slice(0, 200));
      } catch {
        // Non-critical
      }
    }

    return guardrails;
  }

  /**
   * Assemble final context string from selected chunks and guardrails.
   */
  private assembleContext(chunks: RankedChunk[], guardrails: ContextPack['guardrails']): string {
    const parts: string[] = [];

    // Group chunks by file for readability
    const fileGroups = new Map<string, RankedChunk[]>();
    for (const chunk of chunks) {
      if (!fileGroups.has(chunk.file)) {
        fileGroups.set(chunk.file, []);
      }
      fileGroups.get(chunk.file)!.push(chunk);
    }

    for (const [file, fileChunks] of fileGroups) {
      parts.push(`--- ${file} ---`);
      for (const chunk of fileChunks) {
        parts.push(`\`\`\`${chunk.language}\n${chunk.content}\n\`\`\``);
      }
    }

    // Add guardrails
    if (guardrails.relatedADRs.length > 0) {
      parts.push('\n--- Related Decisions ---');
      for (const adr of guardrails.relatedADRs) {
        parts.push(`- ${adr}`);
      }
    }

    if (guardrails.testCommands.length > 0) {
      parts.push('\n--- Test Commands ---');
      for (const cmd of guardrails.testCommands) {
        parts.push(`- ${cmd}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Estimate token count (~4 chars per token).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

export const contextPackBuilder = new ContextPackBuilder();
export default contextPackBuilder;
