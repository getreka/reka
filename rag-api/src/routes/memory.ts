/**
 * Memory Routes - Agent memory API endpoints
 */

import { Router, Request, Response } from 'express';
import { memoryService, MemoryType, TodoStatus } from '../services/memory';
import { memoryGovernance, PromoteReason } from '../services/memory-governance';
import { qualityGates } from '../services/quality-gates';
import { conversationAnalyzer } from '../services/conversation-analyzer';
import { asyncHandler } from '../middleware/async-handler';
import {
  validate,
  validateProjectName,
  createMemorySchema,
  recallMemorySchema,
  analyzeConversationSchema,
  mergeMemoriesSchema,
  promoteMemorySchema,
  maintenanceSchema,
  forgetOlderThanSchema,
} from '../utils/validation';

const router = Router();

/**
 * Store a memory
 * POST /api/memory
 */
router.post('/memory', validateProjectName, validate(createMemorySchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, content, type, tags, relatedTo, metadata } = req.body;

  // Route auto-generated memories through governance
  const source = metadata?.source as string | undefined;
  if (source && source.startsWith('auto_')) {
    const memory = await memoryGovernance.ingest({
      projectName,
      content,
      type: type as MemoryType,
      tags,
      relatedTo,
      metadata,
      source: source as any,
      confidence: metadata?.confidence as number | undefined,
    });
    return res.json({ success: true, memory });
  }

  const memory = await memoryService.remember({
    projectName,
    content,
    type: type as MemoryType,
    tags,
    relatedTo,
    metadata,
  });

  res.json({ success: true, memory });
}));

/**
 * Recall memories by query
 * POST /api/memory/recall
 */
router.post('/memory/recall', validateProjectName, validate(recallMemorySchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, query, type, limit, tag } = req.body;

  const results = await memoryService.recall({
    projectName,
    query,
    type: type as MemoryType | 'all',
    limit,
    tag,
  });

  res.json({ results });
}));

/**
 * List memories
 * GET /api/memory/list
 */
router.get('/memory/list', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const type = req.query.type as MemoryType | 'all' | undefined;
  const tag = req.query.tag as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

  const memories = await memoryService.list({
    projectName,
    type,
    tag,
    limit,
  });

  res.json({ memories });
}));

/**
 * Delete a memory
 * DELETE /api/memory/:id
 */
router.delete('/memory/:id', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { id } = req.params;

  const success = await memoryService.forget(projectName, id);
  res.json({ success });
}));

/**
 * Delete memories by type
 * DELETE /api/memory/type/:type
 */
router.delete('/memory/type/:type', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { type } = req.params;

  const count = await memoryService.forgetByType(projectName, type as MemoryType);
  res.json({ success: true, deleted: count });
}));

/**
 * Delete memories older than N days (both durable and quarantine)
 * POST /api/memory/forget-older
 */
router.post('/memory/forget-older', validateProjectName, validate(forgetOlderThanSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, olderThanDays } = req.body;

  const [durableDeleted, quarantineDeleted] = await Promise.all([
    memoryService.forgetOlderThan(projectName, olderThanDays),
    memoryService.forgetOlderThan(projectName, olderThanDays, 'quarantine'),
  ]);

  res.json({ success: true, deleted: durableDeleted + quarantineDeleted, durable: durableDeleted, quarantine: quarantineDeleted, olderThanDays });
}));

/**
 * Update todo status
 * PATCH /api/memory/todo/:id
 */
router.patch('/memory/todo/:id', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, status, note } = req.body;
  const { id } = req.params;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const memory = await memoryService.updateTodoStatus(
    projectName,
    id,
    status as TodoStatus,
    note
  );

  if (!memory) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  res.json({ success: true, memory });
}));

/**
 * Get memory stats
 * GET /api/memory/stats
 */
router.get('/memory/stats', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;

  const stats = await memoryService.getStats(projectName);
  res.json({ stats });
}));

/**
 * Merge duplicate/similar memories
 * POST /api/memory/merge
 */
router.post('/memory/merge', validateProjectName, validate(mergeMemoriesSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, type, threshold, dryRun, limit } = req.body;

  const result = await memoryService.mergeMemories({
    projectName,
    type: type as MemoryType | 'all',
    threshold,
    dryRun,
    limit,
  });

  res.json({
    ...result,
    dryRun,
    message: dryRun
      ? `Found ${result.totalMerged} merge candidates (dry run, no changes made)`
      : `Merged ${result.totalMerged} memory clusters`,
  });
}));

/**
 * Recall only from durable storage (for enrichment)
 * POST /api/memory/recall-durable
 */
router.post('/memory/recall-durable', validateProjectName, validate(recallMemorySchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, query, type, limit, tag } = req.body;

  const results = await memoryGovernance.recallDurable({
    projectName,
    query,
    type: type as MemoryType | 'all',
    limit,
    tag,
  });

  res.json({ results });
}));

/**
 * Promote memory from quarantine to durable
 * POST /api/memory/promote
 */
router.post('/memory/promote', validateProjectName, validate(promoteMemorySchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, memoryId, reason, evidence, runGates, projectPath, affectedFiles } = req.body;

  const memory = await memoryGovernance.promote(
    projectName,
    memoryId,
    reason as PromoteReason,
    evidence,
    runGates ? { runGates, projectPath, affectedFiles } : undefined
  );

  res.json({ success: true, memory });
}));

/**
 * List quarantine memories for review
 * GET /api/memory/quarantine
 */
router.get('/memory/quarantine', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = req.query.offset as string | undefined;

  const memories = await memoryGovernance.listQuarantine(projectName, limit, offset);
  res.json({ memories, count: memories.length });
}));

// ============================================
// Batch & Auto-learning Routes
// ============================================

/**
 * Batch store memories
 * POST /api/memory/batch
 */
router.post('/memory/batch', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, items } = req.body;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const result = await memoryService.batchRemember(projectName, items);
  res.json({
    success: result.errors.length === 0,
    savedCount: result.saved.length,
    memories: result.saved,
    errors: result.errors,
  });
}));

/**
 * Extract learnings from text/conversation
 * POST /api/memory/extract
 */
router.post('/memory/extract', validateProjectName, validate(analyzeConversationSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, conversation, context, autoSave, minConfidence } = req.body;

  const analysis = await conversationAnalyzer.analyze({
    projectName,
    conversation,
    context,
    autoSave,
    minConfidence,
  });

  res.json({
    learnings: analysis.learnings,
    entities: analysis.entities,
    summary: analysis.summary,
    savedCount: autoSave ? analysis.learnings.length : 0,
  });
}));

/**
 * Validate an auto-extracted memory
 * PATCH /api/memory/:id/validate
 */
router.patch('/memory/:id/validate', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, validated } = req.body;
  const { id } = req.params;

  if (validated === undefined) {
    return res.status(400).json({ error: 'validated (true/false) is required' });
  }

  const memory = await memoryService.validateMemory(projectName, id, validated);

  if (!memory) {
    return res.status(404).json({ error: 'Memory not found' });
  }

  res.json({ success: true, memory });
}));

/**
 * Get unvalidated auto-extracted memories for review
 * GET /api/memory/unvalidated
 */
router.get('/memory/unvalidated', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const limit = parseInt(req.query.limit as string) || 20;

  const memories = await memoryService.getUnvalidatedMemories(projectName, limit);
  res.json({ memories, count: memories.length });
}));

// ============================================
// Quality Gate Routes
// ============================================

/**
 * Run quality gates on demand
 * POST /api/quality/run
 */
router.post('/quality/run', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, projectPath, affectedFiles, skipGates } = req.body;

  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath is required' });
  }

  const report = await qualityGates.runGates({
    projectName,
    projectPath,
    affectedFiles,
    skipGates,
  });

  res.json(report);
}));

/**
 * Blast radius analysis
 * POST /api/quality/blast-radius
 */
router.post('/quality/blast-radius', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName, files, maxDepth = 3 } = req.body;

  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'files array is required' });
  }

  const { graphStore } = await import('../services/graph-store');
  const result = await graphStore.getBlastRadius(projectName, files, maxDepth);
  res.json(result);
}));

// ============================================
// Feedback-Driven Memory Maintenance
// ============================================

/**
 * Run memory maintenance (quarantine cleanup, feedback, compaction)
 * POST /api/memory/maintenance
 */
router.post('/memory/maintenance', validateProjectName, validate(maintenanceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, operations } = req.body;
  const result = await memoryGovernance.runMaintenance(projectName, operations);
  res.json(result);
}));

/**
 * Get developer profile (accumulated usage patterns)
 * GET /api/developer-profile
 */
router.get('/developer-profile', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { usagePatterns } = await import('../services/usage-patterns');
  const profile = await usagePatterns.buildDeveloperProfile(projectName);
  res.json(profile);
}));

export default router;
