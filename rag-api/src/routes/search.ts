/**
 * Search Routes - Universal search endpoints
 */

import { Router, Request, Response } from 'express';
import { vectorStore, SearchResult } from '../services/vector-store';
import { embeddingService } from '../services/embedding';
import { llm } from '../services/llm';
import { contextPackBuilder } from '../services/context-pack';
import { smartDispatch } from '../services/smart-dispatch';
import { symbolIndex } from '../services/symbol-index';
import { asyncHandler } from '../middleware/async-handler';
import { validate } from '../utils/validation';
import {
  searchSchema,
  searchSimilarSchema,
  searchGroupedSchema,
  searchHybridSchema,
  askSchema,
  explainSchema,
  findFeatureSchema,
  contextPackSchema,
  smartDispatchSchema,
} from '../utils/validation';
import { buildSearchFilter } from '../utils/filters';
import { graphStore } from '../services/graph-store';
import config from '../config';

const router = Router();

/**
 * Deduplicate search results by file — keep only the highest-scoring chunk per file.
 */
function deduplicateByFile<T extends { payload: Record<string, unknown>; score: number }>(
  results: T[]
): T[] {
  const seen = new Map<string, T>();
  for (const r of results) {
    const file = r.payload.file as string;
    if (!file) {
      seen.set(`__no_file_${seen.size}`, r);
      continue;
    }
    const existing = seen.get(file);
    if (!existing || r.score > existing.score) {
      seen.set(file, r);
    }
  }
  return Array.from(seen.values());
}

/**
 * Apply code-type boosting — give a small score boost to code chunks over docs.
 */
const CODE_BOOST = config.CODE_BOOST;
function applyChunkTypeBoost<T extends { payload: Record<string, unknown>; score: number }>(
  results: T[]
): T[] {
  return results.map((r) => ({
    ...r,
    score: r.payload?.chunkType === 'code' ? r.score * CODE_BOOST : r.score,
  }));
}

// feedbackBoost removed — 0 feedback submissions in production audit

/**
 * Graph-boosted search: expand results by adding 1-hop neighbors from dependency graph.
 * Fetches the best chunk for each neighbor file not already in results.
 */
async function expandWithGraph(
  projectName: string,
  collection: string,
  results: SearchResult[],
  queryEmbedding: number[],
  maxExpand: number = 3
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  const resultFiles = new Set(results.map((r) => r.payload.file as string).filter(Boolean));

  // Get 1-hop neighbors for all result files
  const seedFiles = [...resultFiles].slice(0, 5); // limit seed files
  const expanded = await graphStore.expand(projectName, seedFiles, 1);

  // Find neighbor files not already in results
  const newFiles = expanded.filter((f) => !resultFiles.has(f)).slice(0, maxExpand * 2);
  if (newFiles.length === 0) return results;

  // Search for the best chunk in each neighbor file
  const neighborResults: SearchResult[] = [];
  for (const file of newFiles) {
    const fileResults = await vectorStore.search(collection, queryEmbedding, 1, {
      must: [{ key: 'file', match: { value: file } }],
    });
    if (fileResults.length > 0 && fileResults[0].score > config.GRAPH_EXPAND_SCORE_THRESHOLD) {
      neighborResults.push({
        ...fileResults[0],
        payload: { ...fileResults[0].payload, graphExpanded: true },
      });
    }
  }

  // Sort neighbors by score and append the best ones
  neighborResults.sort((a, b) => b.score - a.score);
  return [...results, ...neighborResults.slice(0, maxExpand)];
}

/**
 * Convert a search result to a compact navigation pointer (no content).
 */
function toNavigateResult(r: SearchResult, connections?: string[]) {
  return {
    file: r.payload.file,
    lines: [r.payload.startLine, r.payload.endLine],
    symbols: r.payload.symbols || [],
    imports: r.payload.imports || [],
    layer: r.payload.layer,
    service: r.payload.service,
    preview: String(r.payload.content || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 1)
      .join(''),
    score: r.score,
    ...(connections?.length ? { connections } : {}),
    ...(r.payload.graphExpanded ? { graphExpanded: true } : {}),
  };
}

/**
 * Fetch 1-hop graph connections for a set of files.
 */
async function getConnectionsMap(
  projectName: string,
  files: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const file of files.slice(0, 10)) {
    const expanded = await graphStore.expand(projectName, [file], 1);
    const connections = expanded.filter((f) => f !== file);
    if (connections.length > 0) map.set(file, connections.slice(0, 5));
  }
  return map;
}

/**
 * Search in a collection
 * POST /api/search
 */
router.post(
  '/search',
  validate(searchSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, query, limit = 5, filters, scoreThreshold, mode = 'content' } = req.body;
    const projectName = (req.headers['x-project-name'] as string) || collection.split('_')[0];

    const queryEmbedding = await embeddingService.embedQuery(query, 'code_search');
    const filter = buildSearchFilter(filters);
    const rawResults = await vectorStore.search(
      collection,
      queryEmbedding,
      limit * 3,
      filter,
      scoreThreshold
    );

    // Cross-encoder reranking
    const { reranker } = await import('../services/reranker');
    const reranked = await reranker.rerank(query, rawResults, limit * 2);

    const boosted = applyChunkTypeBoost(reranked);
    boosted.sort((a, b) => b.score - a.score);
    const deduped = deduplicateByFile(boosted).slice(0, limit);

    // Graph-boosted expansion: add related files from dependency graph
    const results = await expandWithGraph(projectName, collection, deduped, queryEmbedding, 3);

    if (mode === 'navigate') {
      const connectionsMap = await getConnectionsMap(
        projectName,
        results.map((r) => r.payload.file as string)
      );
      return res.json({
        results: results.map((r) =>
          toNavigateResult(r, connectionsMap.get(r.payload.file as string))
        ),
      });
    }

    res.json({
      results: results.map((r) => ({
        file: r.payload.file,
        content: r.payload.content,
        language: r.payload.language,
        score: r.score,
        startLine: r.payload.startLine,
        endLine: r.payload.endLine,
        ...(r.payload.graphExpanded ? { graphExpanded: true } : {}),
      })),
    });
  })
);

/**
 * Search for similar code
 * POST /api/search-similar
 */
router.post(
  '/search-similar',
  validate(searchSimilarSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, code, limit = 5, scoreThreshold = 0.7 } = req.body;

    const codeEmbedding = await embeddingService.embed(code);
    const results = await vectorStore.search(
      collection,
      codeEmbedding,
      limit,
      undefined,
      scoreThreshold
    );

    res.json({
      results: results.map((r) => ({
        file: r.payload.file,
        content: r.payload.content,
        language: r.payload.language,
        score: r.score,
      })),
    });
  })
);

/**
 * Search with grouping (one result per file/group)
 * POST /api/search-grouped
 */
router.post(
  '/search-grouped',
  validate(searchGroupedSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      collection,
      query,
      groupBy = 'file',
      limit = 10,
      groupSize = 1,
      filters,
      scoreThreshold,
      mode = 'content',
    } = req.body;

    const queryEmbedding = await embeddingService.embedQuery(query, 'code_search');
    const filter = buildSearchFilter(filters);

    const projectName = (req.headers['x-project-name'] as string) || collection.split('_')[0];
    const groups = await vectorStore.searchGroups(
      collection,
      queryEmbedding,
      groupBy,
      limit,
      groupSize,
      filter,
      scoreThreshold
    );

    if (mode === 'navigate') {
      const allFiles = groups.flatMap((g) => g.results.map((r) => r.payload.file as string));
      const connectionsMap = await getConnectionsMap(projectName, allFiles);
      return res.json({
        groups: groups.map((g) => ({
          [groupBy]: g.group,
          results: g.results.map((r) =>
            toNavigateResult(r, connectionsMap.get(r.payload.file as string))
          ),
        })),
        totalGroups: groups.length,
      });
    }

    res.json({
      groups: groups.map((g) => ({
        [groupBy]: g.group,
        results: g.results.map((r) => ({
          file: r.payload.file,
          content: r.payload.content,
          language: r.payload.language,
          score: r.score,
        })),
      })),
      totalGroups: groups.length,
    });
  })
);

/**
 * Hybrid search (keyword + semantic)
 * POST /api/search-hybrid
 */
router.post(
  '/search-hybrid',
  validate(searchHybridSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      collection,
      query,
      limit = 10,
      semanticWeight = 0.7,
      filters,
      mode = 'content',
    } = req.body;
    const projectName = (req.headers['x-project-name'] as string) || collection.split('_')[0];

    const filter = buildSearchFilter(filters);

    // Native sparse hybrid search (when enabled)
    if (config.SPARSE_VECTORS_ENABLED) {
      const { dense, sparse } = await embeddingService.embedFull(query);
      const rawResults = await vectorStore.searchHybridNative(
        collection,
        dense,
        sparse,
        limit * 3,
        filter
      );
      const boosted = applyChunkTypeBoost(rawResults);
      boosted.sort((a, b) => b.score - a.score);
      const deduped = deduplicateByFile(boosted).slice(0, limit);
      const results = await expandWithGraph(projectName, collection, deduped, dense, 3);

      if (mode === 'navigate') {
        const connectionsMap = await getConnectionsMap(
          projectName,
          results.map((r) => r.payload.file as string)
        );
        return res.json({
          results: results.map((r) =>
            toNavigateResult(r, connectionsMap.get(r.payload.file as string))
          ),
          query,
          searchMode: 'native-sparse',
        });
      }

      return res.json({
        results: results.map((r) => ({
          file: r.payload.file,
          content: r.payload.content,
          language: r.payload.language,
          score: r.score,
          semanticScore: r.score,
          keywordScore: r.score,
          ...(r.payload.graphExpanded ? { graphExpanded: true } : {}),
        })),
        query,
        mode: 'native-sparse',
      });
    }

    // Fallback: client-side weighted fusion (dense + text match)

    // 1. Semantic search
    const queryEmbedding = await embeddingService.embed(query);
    const semanticResults = await vectorStore.search(collection, queryEmbedding, limit * 2, filter);

    // 2. Keyword search (using Qdrant text match)
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w: string) => w.length > 2);
    let keywordResults: typeof semanticResults = [];

    if (keywords.length > 0 && semanticWeight < 1) {
      const keywordFilter = {
        should: keywords.map((kw: string) => ({
          key: 'content',
          match: { text: kw },
        })),
        ...(filter ? { must: (filter as Record<string, unknown>).must } : {}),
      };

      keywordResults = await vectorStore.search(
        collection,
        queryEmbedding,
        limit * 2,
        keywordFilter
      );
    }

    // 3. Fusion: Combine and re-rank results
    const resultMap = new Map<
      string,
      { result: (typeof semanticResults)[0]; semanticScore: number; keywordScore: number }
    >();

    for (const r of semanticResults) {
      resultMap.set(r.id, { result: r, semanticScore: r.score, keywordScore: 0 });
    }

    for (const r of keywordResults) {
      const content = String(r.payload.content || '').toLowerCase();
      const matchCount = keywords.filter((kw: string) => content.includes(kw)).length;
      const keywordScore = matchCount / keywords.length;

      if (resultMap.has(r.id)) {
        resultMap.get(r.id)!.keywordScore = keywordScore;
      } else {
        resultMap.set(r.id, {
          result: r,
          semanticScore: r.score * 0.5,
          keywordScore,
        });
      }
    }

    const fusedResults = Array.from(resultMap.values()).map(
      ({ result, semanticScore, keywordScore }) => ({
        ...result,
        score: semanticWeight * semanticScore + (1 - semanticWeight) * keywordScore,
        semanticScore,
        keywordScore,
      })
    );

    // Apply code-type boost, re-sort, dedup, trim
    const boostedFused = applyChunkTypeBoost(fusedResults).map((r) => ({
      ...r,
      semanticScore: (r as any).semanticScore as number,
      keywordScore: (r as any).keywordScore as number,
    }));
    boostedFused.sort((a, b) => b.score - a.score);
    const combinedResults = deduplicateByFile(boostedFused).slice(0, limit);

    if (mode === 'navigate') {
      const connectionsMap = await getConnectionsMap(
        projectName,
        combinedResults.map((r) => r.payload.file as string)
      );
      return res.json({
        results: combinedResults.map((r) =>
          toNavigateResult(r, connectionsMap.get(r.payload.file as string))
        ),
        query,
        searchMode: 'text-match-fusion',
      });
    }

    res.json({
      results: combinedResults.map((r) => ({
        file: r.payload.file,
        content: r.payload.content,
        language: r.payload.language,
        score: r.score,
        semanticScore: (r as any).semanticScore,
        keywordScore: (r as any).keywordScore,
      })),
      query,
      semanticWeight,
      mode: 'text-match-fusion',
    });
  })
);

/**
 * Ask a question about the codebase (RAG)
 * POST /api/ask
 */
router.post(
  '/ask',
  validate(askSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, question, includeThinking } = req.body;

    const queryEmbedding = await embeddingService.embedQuery(question, 'code_search');
    const rawResults = await vectorStore.search(collection, queryEmbedding, 24);
    const searchResults = deduplicateByFile(
      applyChunkTypeBoost(rawResults).sort((a, b) => b.score - a.score)
    ).slice(0, 5);

    if (searchResults.length === 0) {
      return res.json({
        answer:
          'No relevant code found to answer this question. Please make sure the codebase is indexed.',
      });
    }

    // Truncate each chunk to ~800 chars to fit within context window
    const context = searchResults
      .map((r) => {
        const content = String(r.payload.content || '').slice(0, 800);
        return `File: ${r.payload.file}\n\`\`\`${r.payload.language}\n${content}\n\`\`\``;
      })
      .join('\n\n');

    const result = await llm.complete(
      `Based on the following code context, answer this question: ${question}\n\nContext:\n${context}`,
      {
        systemPrompt:
          'You are a helpful code assistant. Answer questions about the codebase based on the provided context. Be specific and reference the relevant files when possible.',
        maxTokens: 1024,
        temperature: 0.3,
      }
    );

    res.json({
      answer: result.text,
      ...(includeThinking && result.thinking ? { thinking: result.thinking } : {}),
    });
  })
);

/**
 * Explain code
 * POST /api/explain
 */
router.post(
  '/explain',
  validate(explainSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, code, filePath, includeThinking } = req.body;

    let context = '';
    if (collection) {
      const codeEmbedding = await embeddingService.embed(code);
      const related = await vectorStore.search(collection, codeEmbedding, 3);
      if (related.length > 0) {
        context =
          '\n\nRelated code in the project:\n' +
          related
            .map((r) => `File: ${r.payload.file}\n\`\`\`\n${r.payload.content}\n\`\`\``)
            .join('\n\n');
      }
    }

    const result = await llm.complete(
      `Explain the following code${filePath ? ` from ${filePath}` : ''}:\n\n\`\`\`\n${code}\n\`\`\`${context}`,
      {
        systemPrompt: `You are a code explanation expert. Provide a clear, structured explanation including:
1. A brief summary
2. The purpose of the code
3. Key components and their roles
4. Dependencies used
5. Any potential issues or improvements (if obvious)

Format your response as JSON with keys: summary, purpose, keyComponents (array), dependencies (array), potentialIssues (array, optional)`,
        maxTokens: 1500,
        temperature: 0.3,
        format: 'json',
      }
    );

    try {
      const parsed = JSON.parse(result.text);
      res.json({
        ...parsed,
        ...(includeThinking && result.thinking ? { thinking: result.thinking } : {}),
      });
    } catch {
      res.json({
        summary: result.text,
        purpose: '',
        keyComponents: [],
        dependencies: [],
        ...(includeThinking && result.thinking ? { thinking: result.thinking } : {}),
      });
    }
  })
);

/**
 * Find feature implementation
 * POST /api/find-feature
 */
router.post(
  '/find-feature',
  validate(findFeatureSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, description } = req.body;

    const queryEmbedding = await embeddingService.embedQuery(description, 'code_search');
    const results = await vectorStore.search(collection, queryEmbedding, 10);

    if (results.length === 0) {
      return res.json({
        explanation: 'No relevant code found for this feature.',
        mainFiles: [],
        relatedFiles: [],
      });
    }

    // Group by file
    const fileMap = new Map<string, { score: number; chunks: Record<string, unknown>[] }>();
    for (const r of results) {
      const file = r.payload.file as string;
      if (!fileMap.has(file)) {
        fileMap.set(file, { score: r.score, chunks: [] });
      }
      fileMap.get(file)!.chunks.push(r.payload);
    }

    const sortedFiles = Array.from(fileMap.entries()).sort((a, b) => b[1].score - a[1].score);

    const mainFiles = sortedFiles.slice(0, 3).map(([file, data]) => ({ file, score: data.score }));
    const relatedFiles = sortedFiles
      .slice(3, 6)
      .map(([file, data]) => ({ file, score: data.score }));

    const context = sortedFiles
      .slice(0, 5)
      .map(([file, data]) => `File: ${file}\n${data.chunks.map((c) => c.content).join('\n---\n')}`)
      .join('\n\n');

    const result = await llm.complete(
      `Where is "${description}" implemented in this codebase? Based on the context, explain how it works.\n\nContext:\n${context}`,
      {
        systemPrompt:
          'You are a code analyst. Explain where and how the requested feature is implemented. Be specific about file locations and key functions.',
        maxTokens: 1000,
        temperature: 0.3,
      }
    );

    res.json({ explanation: result.text, mainFiles, relatedFiles });
  })
);

/**
 * Search with graph expansion
 * POST /api/search-graph
 */
router.post(
  '/search-graph',
  asyncHandler(async (req: Request, res: Response) => {
    const { collection, query, limit = 10, expandHops = 1, mode = 'content' } = req.body;

    if (!collection || !query) {
      return res.status(400).json({ error: 'collection and query are required' });
    }

    const projectName = collection.replace(/_codebase$|_code$/, '');

    // 1. Semantic search
    const queryEmbedding = await embeddingService.embedQuery(query, 'code_search');
    const semanticResults = await vectorStore.search(collection, queryEmbedding, limit);

    // 2. Get files from results
    const seedFiles = [
      ...new Set(semanticResults.map((r) => r.payload.file as string).filter(Boolean)),
    ];

    // 3. Graph expand
    let expandedFiles: string[] = [];
    if (seedFiles.length > 0 && expandHops > 0) {
      expandedFiles = await graphStore.expand(projectName, seedFiles, expandHops);
      // Remove seed files from expanded
      expandedFiles = expandedFiles.filter((f) => !seedFiles.includes(f));
    }

    // 4. Get graph-expanded results
    let graphResults: typeof semanticResults = [];
    if (expandedFiles.length > 0) {
      // Search for each expanded file
      for (const file of expandedFiles.slice(0, 10)) {
        const fileResults = await vectorStore.search(collection, queryEmbedding, 2, {
          must: [{ key: 'file', match: { value: file } }],
        });
        graphResults.push(...fileResults);
      }
    }

    if (mode === 'navigate') {
      const allFiles = [
        ...semanticResults.map((r) => r.payload.file as string),
        ...graphResults.map((r) => r.payload.file as string),
      ];
      const connectionsMap = await getConnectionsMap(projectName, allFiles);
      return res.json({
        results: semanticResults.map((r) =>
          toNavigateResult(r, connectionsMap.get(r.payload.file as string))
        ),
        graphExpanded: graphResults.map((r) => ({
          ...toNavigateResult(r, connectionsMap.get(r.payload.file as string)),
          graphExpanded: true,
        })),
        expandedFiles,
      });
    }

    res.json({
      results: semanticResults.map((r) => ({
        file: r.payload.file,
        content: r.payload.content,
        language: r.payload.language,
        score: r.score,
        source: 'semantic',
      })),
      graphExpanded: graphResults.map((r) => ({
        file: r.payload.file,
        content: r.payload.content,
        language: r.payload.language,
        score: r.score,
        source: 'graph',
      })),
      expandedFiles,
    });
  })
);

/**
 * Build a context pack with faceted retrieval and reranking
 * POST /api/context-pack
 */
router.post(
  '/context-pack',
  validate(contextPackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      projectName,
      query,
      maxTokens,
      semanticWeight,
      includeADRs,
      includeTests,
      graphExpand,
    } = req.body;

    const pack = await contextPackBuilder.build({
      projectName,
      query,
      maxTokens,
      semanticWeight,
      includeADRs,
      includeTests,
      graphExpand,
    });

    res.json(pack);
  })
);

/**
 * Find symbols (functions, classes, types) by name
 * POST /api/find-symbol
 */
router.post(
  '/find-symbol',
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, symbol, kind, limit = 10 } = req.body;

    if (!projectName || !symbol) {
      return res.status(400).json({ error: 'projectName and symbol are required' });
    }

    const results = await symbolIndex.findSymbol(projectName, symbol, kind, limit);
    res.json({ results });
  })
);

/**
 * Get exported symbols from a specific file
 * POST /api/file-exports
 */
router.post(
  '/file-exports',
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, filePath } = req.body;

    if (!projectName || !filePath) {
      return res.status(400).json({ error: 'projectName and filePath are required' });
    }

    const exports = await symbolIndex.getFileExports(projectName, filePath);
    res.json({ exports });
  })
);

/**
 * Smart Dispatch — LLM-driven tool routing
 * POST /api/smart-dispatch
 */
router.post(
  '/smart-dispatch',
  validate(smartDispatchSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, task, files, intent } = req.body;
    const effectiveProject = projectName || (req.headers['x-project-name'] as string);

    if (!effectiveProject) {
      return res.status(400).json({ error: 'projectName or X-Project-Name header required' });
    }

    const result = await smartDispatch.dispatch({
      projectName: effectiveProject,
      task,
      files,
      intent,
    });

    res.json(result);
  })
);

export default router;
