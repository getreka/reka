/**
 * Index Routes - Indexing and stats endpoints
 */

import { Router, Request, Response } from 'express';
import {
  indexProject,
  indexFiles,
  getIndexStatus,
  getProjectStats,
  getCollectionName,
  reindexWithZeroDowntime,
  getAliasInfo,
  indexEventEmitter,
} from '../services/indexer';
import { vectorStore } from '../services/vector-store';
import { confluenceService } from '../services/confluence';
import { usagePatterns } from '../services/usage-patterns';
import { proactiveSuggestions } from '../services/proactive-suggestions';
import { sessionContext } from '../services/session-context';
// feedbackService and queryLearning removed — 0 calls in production audit
import { codeSuggestions } from '../services/code-suggestions';
import { cacheService } from '../services/cache';
import { embeddingService } from '../services/embedding';
import { graphStore } from '../services/graph-store';
import { logger } from '../utils/logger';
import { asyncHandler } from '../middleware/async-handler';
import {
  validate,
  validateProjectName,
  indexUploadSchema,
  indexConfluenceSchema,
  confluenceSearchSchema,
  completionContextSchema,
  importSuggestionsSchema,
  typeContextSchema,
} from '../utils/validation';

const router = Router();

// ============================================
// Eager Collection Creation
// ============================================

/**
 * Ensure critical collections exist for a project.
 * Called fire-and-forget from MCP auto-session start.
 * POST /api/ensure-collections
 */
router.post('/ensure-collections', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const collections = [
    `${projectName}_sessions`,
    `${projectName}_memory_pending`,
    `${projectName}_agent_memory`,
  ];

  await Promise.all(collections.map(c => vectorStore.ensureCollection(c)));

  res.json({ success: true, collections });
}));

// ============================================
// Indexing Routes
// ============================================

/**
 * Start indexing a project
 * POST /api/index
 */
router.post('/index', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const projectPath = req.headers['x-project-path'] as string || req.body.path;
  const { force = false, patterns, excludePatterns } = req.body;

  if (!projectPath) {
    return res.status(400).json({ error: 'path is required (via X-Project-Path header or body)' });
  }

  // Check if already indexing
  const status = getIndexStatus(projectName);
  if (status.status === 'indexing') {
    return res.json({ status: 'already_indexing', progress: status });
  }

  // Start indexing in background
  indexProject({
    projectName,
    projectPath,
    patterns,
    excludePatterns,
    force,
  }).catch(error => {
    logger.error(`Background indexing failed for ${projectName}`, { error: error.message });
  });

  res.json({
    status: 'started',
    message: `Indexing started for ${projectName}`,
    collection: getCollectionName(projectName),
  });
}));

/**
 * Upload and index pre-read file contents (for remote MCP clients).
 * Unlike POST /api/index which is fire-and-forget, this endpoint awaits
 * processing so the client knows when to send the next batch.
 * POST /api/index/upload
 */
router.post('/index/upload', validateProjectName, validate(indexUploadSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, files, force, done } = req.body;

  const stats = await indexFiles({ projectName, files, force, done });

  res.json({
    status: 'ok',
    filesProcessed: stats.indexedFiles,
    chunksCreated: stats.totalChunks,
    errors: stats.errors,
    duration: stats.duration,
    done,
  });
}));

/**
 * Get indexing status
 * GET /api/index/status/:collection
 */
router.get('/index/status/:collection', asyncHandler(async (req: Request, res: Response) => {
  const { collection } = req.params;
  const projectName = collection.replace(/_codebase$|_docs$/, '');

  const status = getIndexStatus(projectName);
  const collectionInfo = await vectorStore.getCollectionInfo(collection);

  res.json({
    ...status,
    vectorCount: collectionInfo.vectorsCount,
    collectionStatus: collectionInfo.status,
  });
}));

/**
 * Get project stats
 * GET /api/stats/:collection
 */
router.get('/stats/:collection', asyncHandler(async (req: Request, res: Response) => {
  const { collection } = req.params;
  const projectName = collection.replace(/_codebase$|_docs$/, '');

  const stats = await getProjectStats(projectName);
  const collectionInfo = await vectorStore.getCollectionInfo(collection);

  res.json({
    ...stats,
    vectorCount: collectionInfo.vectorsCount,
    status: collectionInfo.status,
  });
}));

/**
 * SSE stream for indexing progress
 * GET /api/index/status/:collection/stream
 */
router.get('/index/status/:collection/stream', (req: Request, res: Response) => {
  const { collection } = req.params;
  const projectName = collection.replace(/_codebase$|_docs$|_code$/, '');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial status
  const initial = getIndexStatus(projectName);
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  const onProgress = (data: any) => {
    if (data.projectName === projectName || collection.startsWith(data.projectName)) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (data.status === 'completed' || data.status === 'error') {
        res.end();
      }
    }
  };

  indexEventEmitter.on('progress', onProgress);

  req.on('close', () => {
    indexEventEmitter.off('progress', onProgress);
  });
});

// ============================================
// Collection Management Routes
// ============================================

/**
 * List all collections
 * GET /api/collections
 */
router.get('/collections', asyncHandler(async (req: Request, res: Response) => {
  const projectFilter = req.query.project as string | undefined;

  let collections: string[];
  if (projectFilter) {
    collections = await vectorStore.listProjectCollections(projectFilter);
  } else {
    collections = await vectorStore.listCollections();
  }

  const collectionsInfo = await Promise.all(
    collections.map(async name => {
      const info = await vectorStore.getCollectionInfo(name);
      return { name, vectorsCount: info.vectorsCount, status: info.status };
    })
  );

  res.json({ collections: collectionsInfo });
}));

/**
 * Delete a collection
 * DELETE /api/collections/:name
 */
router.delete('/collections/:name', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;
  await vectorStore.deleteCollection(name);
  res.json({ message: `Deleted collection: ${name}` });
}));

/**
 * Clear a collection (keep structure, remove vectors)
 * POST /api/collections/:name/clear
 */
router.post('/collections/:name/clear', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;
  await vectorStore.clearCollection(name);
  res.json({ message: `Cleared collection: ${name}` });
}));

/**
 * Create/ensure payload indexes on a collection
 * POST /api/collections/:name/indexes
 */
router.post('/collections/:name/indexes', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;

  await vectorStore.ensurePayloadIndexes(name);
  const info = await vectorStore.getCollectionInfo(name);

  res.json({
    message: `Created indexes on collection: ${name}`,
    indexedFields: info.indexedFields,
  });
}));

/**
 * Create indexes on all existing collections (migration)
 * POST /api/collections/migrate-indexes
 */
router.post('/collections/migrate-indexes', asyncHandler(async (req: Request, res: Response) => {
  const collections = await vectorStore.listCollections();
  const results: Record<string, string[]> = {};

  for (const name of collections) {
    await vectorStore.ensurePayloadIndexes(name);
    const info = await vectorStore.getCollectionInfo(name);
    results[name] = info.indexedFields || [];
  }

  res.json({
    message: `Migrated ${collections.length} collections`,
    collections: results,
  });
}));

/**
 * Get detailed collection info with indexes
 * GET /api/collections/:name/info
 */
router.get('/collections/:name/info', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;
  const info = await vectorStore.getCollectionInfo(name);
  res.json(info);
}));

/**
 * Scroll collection points (with optional vectors)
 * GET /api/collections/:name/scroll
 */
router.get('/collections/:name/scroll', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = req.query.offset as string | undefined;
  const withVectors = req.query.vectors === 'true';

  const result = await vectorStore.scrollCollection(name, limit, offset, withVectors);
  res.json(result);
}));

// ============================================
// Zero-Downtime Reindex Routes
// ============================================

/**
 * Reindex with zero downtime using aliases
 * POST /api/reindex
 */
router.post('/reindex', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const projectPath = req.headers['x-project-path'] as string || req.body.path;
  const { patterns, excludePatterns, aliasName } = req.body;

  if (!projectPath) {
    return res.status(400).json({ error: 'path is required (via X-Project-Path header or body)' });
  }

  const status = getIndexStatus(projectName);
  if (status.status === 'indexing') {
    return res.json({ status: 'already_indexing', progress: status });
  }

  reindexWithZeroDowntime({
    projectName,
    projectPath,
    patterns,
    excludePatterns,
    aliasName,
  }).catch(error => {
    logger.error(`Zero-downtime reindex failed for ${projectName}`, { error: error.message });
  });

  res.json({
    status: 'started',
    message: `Zero-downtime reindexing started for ${projectName}`,
    alias: aliasName || getCollectionName(projectName),
  });
}));

/**
 * Get alias info for a project
 * GET /api/alias/:project
 */
router.get('/alias/:project', asyncHandler(async (req: Request, res: Response) => {
  const { project } = req.params;
  const info = await getAliasInfo(project);
  res.json(info);
}));

/**
 * List all aliases
 * GET /api/aliases
 */
router.get('/aliases', asyncHandler(async (req: Request, res: Response) => {
  const aliases = await vectorStore.listAliases();
  res.json({ aliases });
}));

// ============================================
// Clustering & Similarity Routes
// ============================================

/**
 * Find code clusters based on seed IDs
 * POST /api/clusters
 */
router.post('/clusters', asyncHandler(async (req: Request, res: Response) => {
  const { collection, seedIds, limit = 10, threshold = 0.8 } = req.body;

  if (!collection || !seedIds || !Array.isArray(seedIds)) {
    return res.status(400).json({ error: 'collection and seedIds array are required' });
  }

  const clusters = await vectorStore.findClusters(collection, seedIds, limit, threshold);
  res.json({ clusters });
}));

/**
 * Find duplicate code in a collection
 * POST /api/duplicates
 */
router.post('/duplicates', asyncHandler(async (req: Request, res: Response) => {
  const { collection, limit = 100, threshold = 0.95 } = req.body;

  if (!collection) {
    return res.status(400).json({ error: 'collection is required' });
  }

  const duplicates = await vectorStore.findDuplicates(collection, limit, threshold);
  res.json({
    duplicates: duplicates.map(d => ({
      files: d.group.map(g => ({
        id: g.id,
        file: g.payload.file,
        content: (g.payload.content as string)?.slice(0, 200),
      })),
      similarity: d.similarity,
    })),
    totalGroups: duplicates.length,
  });
}));

/**
 * Get recommendations based on positive/negative examples
 * POST /api/recommend
 */
router.post('/recommend', asyncHandler(async (req: Request, res: Response) => {
  const { collection, positiveIds, negativeIds = [], limit = 10 } = req.body;

  if (!collection || !positiveIds || !Array.isArray(positiveIds)) {
    return res.status(400).json({ error: 'collection and positiveIds array are required' });
  }

  const results = await vectorStore.recommend(collection, positiveIds, negativeIds, limit);
  res.json({
    results: results.map(r => ({
      id: r.id,
      file: r.payload.file,
      content: r.payload.content,
      score: r.score,
    })),
  });
}));

// ============================================
// Usage Patterns Routes
// ============================================

/**
 * Analyze usage patterns
 * GET /api/patterns/:project
 */
router.get('/patterns/:project', asyncHandler(async (req: Request, res: Response) => {
  const { project } = req.params;
  const days = parseInt(req.query.days as string) || 7;

  const analysis = await usagePatterns.analyzePatterns(project, days);
  res.json(analysis);
}));

/**
 * Summarize current context
 * GET /api/context/:project
 */
router.get('/context/:project', asyncHandler(async (req: Request, res: Response) => {
  const { project } = req.params;
  const sessionId = req.query.sessionId as string | undefined;

  const summary = await usagePatterns.summarizeContext(project, sessionId);
  res.json(summary);
}));

/**
 * Summarize changes in a session
 * GET /api/changes/:project/:sessionId
 */
router.get('/changes/:project/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { project, sessionId } = req.params;
  const includeCode = req.query.includeCode === 'true';

  const summary = await usagePatterns.summarizeChanges(project, sessionId, { includeCode });
  res.json(summary);
}));

// ============================================
// Quantization Routes
// ============================================

/**
 * Enable scalar quantization on a collection
 * POST /api/collections/:name/quantization
 */
router.post('/collections/:name/quantization', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;
  const { quantile = 0.99 } = req.body;

  await vectorStore.enableQuantization(name, quantile);
  res.json({ success: true, message: `Quantization enabled on ${name}` });
}));

/**
 * Disable quantization on a collection
 * DELETE /api/collections/:name/quantization
 */
router.delete('/collections/:name/quantization', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;

  await vectorStore.disableQuantization(name);
  res.json({ success: true, message: `Quantization disabled on ${name}` });
}));

// ============================================
// Snapshot Routes
// ============================================

/**
 * Create a snapshot of a collection
 * POST /api/collections/:name/snapshots
 */
router.post('/collections/:name/snapshots', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;

  const snapshot = await vectorStore.createSnapshot(name);
  res.json({ success: true, snapshot });
}));

/**
 * List snapshots for a collection
 * GET /api/collections/:name/snapshots
 */
router.get('/collections/:name/snapshots', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.params;

  const snapshots = await vectorStore.listSnapshots(name);
  res.json({ snapshots });
}));

/**
 * Delete a snapshot
 * DELETE /api/collections/:name/snapshots/:snapshotName
 */
router.delete('/collections/:name/snapshots/:snapshotName', asyncHandler(async (req: Request, res: Response) => {
  const { name, snapshotName } = req.params;

  await vectorStore.deleteSnapshot(name, snapshotName);
  res.json({ success: true, message: `Snapshot ${snapshotName} deleted` });
}));

// ============================================
// Analytics Routes
// ============================================

/**
 * Get detailed collection analytics
 * GET /api/analytics/:collection
 */
router.get('/analytics/:collection', asyncHandler(async (req: Request, res: Response) => {
  const { collection } = req.params;

  const analytics = await vectorStore.getCollectionAnalytics(collection);
  res.json(analytics);
}));

/**
 * Get cluster-wide health info
 * GET /api/analytics/cluster/health
 */
router.get('/analytics/cluster/health', asyncHandler(async (req: Request, res: Response) => {
  const info = await vectorStore.getClusterInfo();
  res.json(info);
}));

// ============================================
// Proactive Suggestions Routes
// ============================================

/**
 * Get contextual suggestions
 * POST /api/suggestions
 */
router.post('/suggestions', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, text, currentFile, recentFiles, sessionId } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const analysis = await proactiveSuggestions.analyzeContext({
    projectName,
    text,
    currentFile,
    recentFiles,
    sessionId,
  });

  res.json(analysis);
}));

// ============================================
// Session Routes
// ============================================

/**
 * Start a new session
 * POST /api/session/start
 */
router.post('/session/start', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, sessionId, initialContext, resumeFrom, metadata } = req.body;

  const session = await sessionContext.startSession({
    projectName,
    sessionId,
    initialContext,
    resumeFrom,
    metadata,
  });

  res.json({ success: true, session });
}));

/**
 * Get session context
 * GET /api/session/:sessionId
 */
router.get('/session/:sessionId', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { sessionId } = req.params;

  const session = await sessionContext.getSession(projectName, sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ session });
}));

/**
 * Add activity to session
 * POST /api/session/:sessionId/activity
 */
router.post('/session/:sessionId/activity', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, type, value } = req.body;
  const { sessionId } = req.params;

  if (!type || !value) {
    return res.status(400).json({ error: 'type and value are required' });
  }

  await sessionContext.addActivity(projectName, sessionId, { type, value });
  res.json({ success: true });
}));

/**
 * End a session
 * POST /api/session/:sessionId/end
 */
router.post('/session/:sessionId/end', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, summary, autoSaveLearnings = true, feedback } = req.body;
  const { sessionId } = req.params;

  const result = await sessionContext.endSession({
    projectName,
    sessionId,
    summary,
    autoSaveLearnings,
    feedback,
  });

  res.json(result);
}));

/**
 * List sessions
 * GET /api/sessions
 */
router.get('/sessions', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as 'active' | 'ended' | 'all' || 'all';

  const sessions = await sessionContext.listSessions(projectName, { limit, status });
  res.json({ sessions });
}));

// Feedback & Quality Routes REMOVED — 0 calls in production audit (no data source)

// Query Learning Routes REMOVED — 0 calls in production audit (cold start, no data)

// ============================================
// Code Suggestions Routes
// ============================================

/**
 * Find related code
 * POST /api/code/related
 */
router.post('/code/related', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, code, description, currentFile, limit, minScore } = req.body;

  if (!code && !description) {
    return res.status(400).json({ error: 'code or description is required' });
  }

  const result = await codeSuggestions.findRelatedCode({
    projectName,
    code,
    description,
    currentFile,
    limit,
    minScore,
  });

  res.json(result);
}));

/**
 * Suggest implementation patterns
 * POST /api/code/suggest-implementation
 */
router.post('/code/suggest-implementation', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, targetCode, targetDescription, currentFile, limit } = req.body;

  if (!targetCode) {
    return res.status(400).json({ error: 'targetCode is required' });
  }

  const suggestions = await codeSuggestions.suggestImplementation({
    projectName,
    targetCode,
    targetDescription,
    currentFile,
    limit,
  });

  res.json({ suggestions });
}));

/**
 * Suggest test patterns
 * POST /api/code/suggest-tests
 */
router.post('/code/suggest-tests', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, code, filePath, testType, limit } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const suggestions = await codeSuggestions.suggestTests({
    projectName,
    code,
    filePath,
    testType,
    limit,
  });

  res.json({ suggestions });
}));

/**
 * Get comprehensive code context
 * POST /api/code/context
 */
router.post('/code/context', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, code, includeRelated, includeTests, includeImports } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const context = await codeSuggestions.getCodeContext({
    projectName,
    code,
    includeRelated,
    includeTests,
    includeImports,
  });

  res.json(context);
}));

// ============================================
// Advanced Code Suggestion Routes
// ============================================

/**
 * Get code completion context
 * POST /api/code/completion-context
 */
router.post('/code/completion-context', validateProjectName, validate(completionContextSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, currentFile, currentCode, language, limit } = req.body;

  const context = await codeSuggestions.getCompletionContext({
    projectName,
    currentFile,
    currentCode,
    language,
    limit,
  });

  res.json(context);
}));

/**
 * Get import suggestions
 * POST /api/code/import-suggestions
 */
router.post('/code/import-suggestions', validateProjectName, validate(importSuggestionsSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, currentFile, currentCode, language, limit } = req.body;

  const suggestions = await codeSuggestions.getImportSuggestions({
    projectName,
    currentFile,
    currentCode,
    language,
    limit,
  });

  res.json(suggestions);
}));

/**
 * Get type/interface context
 * POST /api/code/type-context
 */
router.post('/code/type-context', validateProjectName, validate(typeContextSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, typeName, code, currentFile, limit } = req.body;

  if (!typeName && !code) {
    return res.status(400).json({ error: 'typeName or code is required' });
  }

  const context = await codeSuggestions.getTypeContext({
    projectName,
    typeName,
    code,
    currentFile,
    limit,
  });

  res.json(context);
}));

// ============================================
// Cache Analytics Routes
// ============================================

/**
 * Get cache analytics
 * GET /api/cache/analytics
 */
router.get('/cache/analytics', asyncHandler(async (req: Request, res: Response) => {
  const analytics = await cacheService.getCacheAnalytics();
  res.json(analytics);
}));

/**
 * Get session cache stats
 * GET /api/cache/session/:sessionId
 */
router.get('/cache/session/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const stats = await embeddingService.getCacheStats(sessionId);
  res.json(stats);
}));

/**
 * Warm session cache
 * POST /api/cache/warm
 */
router.post('/cache/warm', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, sessionId, previousSessionId, recentQueries } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const result = await embeddingService.warmSessionCache({
    sessionId,
    projectName,
    previousSessionId,
    recentQueries,
  });

  res.json({ success: true, ...result });
}));

/**
 * Prune old session caches
 * POST /api/cache/prune
 */
router.post('/cache/prune', asyncHandler(async (req: Request, res: Response) => {
  const { maxAgeDays = 7 } = req.body;
  const pruned = await cacheService.pruneOldSessions(maxAgeDays);
  res.json({ success: true, prunedCount: pruned });
}));

// ============================================
// Confluence Routes
// ============================================

/**
 * Check Confluence configuration status
 * GET /api/confluence/status
 */
router.get('/confluence/status', asyncHandler(async (req: Request, res: Response) => {
  const configured = confluenceService.isConfigured();
  res.json({
    configured,
    message: configured
      ? 'Confluence is configured and ready'
      : 'Confluence not configured. Set CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN',
  });
}));

/**
 * List Confluence spaces
 * GET /api/confluence/spaces
 */
router.get('/confluence/spaces', asyncHandler(async (req: Request, res: Response) => {
  if (!confluenceService.isConfigured()) {
    return res.status(400).json({ error: 'Confluence not configured' });
  }

  const spaces = await confluenceService.getSpaces();
  res.json({ spaces });
}));

/**
 * Index Confluence content
 * POST /api/index/confluence
 */
router.post('/index/confluence', validateProjectName, validate(indexConfluenceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, spaceKeys, pageIds, labels, maxPages, force } = req.body;

  if (!confluenceService.isConfigured()) {
    return res.status(400).json({ error: 'Confluence not configured' });
  }

  confluenceService.indexConfluence({
    projectName,
    spaceKeys,
    pageIds,
    labels,
    maxPages,
    force,
  }).catch(error => {
    logger.error(`Confluence indexing failed for ${projectName}`, { error: error.message });
  });

  res.json({
    status: 'started',
    message: `Confluence indexing started for ${projectName}`,
    collection: `${projectName}_confluence`,
    options: { spaceKeys, pageIds, labels, maxPages, force },
  });
}));

/**
 * Search Confluence pages by CQL
 * POST /api/confluence/search
 */
router.post('/confluence/search', validate(confluenceSearchSchema), asyncHandler(async (req: Request, res: Response) => {
  if (!confluenceService.isConfigured()) {
    return res.status(400).json({ error: 'Confluence not configured' });
  }

  const { cql, limit } = req.body;
  const pages = await confluenceService.searchPages(cql, limit);
  res.json({ pages, count: pages.length });
}));

// ============================================
// Graph Routes
// ============================================

/**
 * Get dependents of a file
 * GET /api/graph/dependents
 */
router.get('/graph/dependents', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const file = req.query.file as string;
  if (!file) return res.status(400).json({ error: 'file query parameter is required' });

  const edges = await graphStore.getDependents(projectName, file);
  res.json({ file, dependents: edges });
}));

/**
 * Get dependencies of a file
 * GET /api/graph/dependencies
 */
router.get('/graph/dependencies', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const file = req.query.file as string;
  if (!file) return res.status(400).json({ error: 'file query parameter is required' });

  const edges = await graphStore.getDependencies(projectName, file);
  res.json({ file, dependencies: edges });
}));

/**
 * Blast radius analysis
 * POST /api/graph/blast-radius
 */
router.post('/graph/blast-radius', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, files, maxDepth = 3 } = req.body;
  if (!files || !Array.isArray(files)) return res.status(400).json({ error: 'files array is required' });

  const result = await graphStore.getBlastRadius(projectName, files, maxDepth);
  res.json(result);
}));

export default router;
