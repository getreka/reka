/**
 * Memory Routes - Agent memory API endpoints
 */

import { Router, Request, Response } from 'express';
import { memoryService, MemoryType, TodoStatus } from '../services/memory';
import { memoryGovernance, PromoteReason } from '../services/memory-governance';
import { qualityGates } from '../services/quality-gates';
import { conversationAnalyzer } from '../services/conversation-analyzer';
import { consolidationAgent } from '../services/consolidation-agent';
import { memoryLtm } from '../services/memory-ltm';
import { reconsolidation } from '../services/reconsolidation';
import { memoryGraph } from '../services/memory-graph';
import { memoryMigration } from '../services/memory-migration';
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
  consolidateSchema,
  batchCreateMemorySchema,
} from '../utils/validation';

const router = Router();

/**
 * Store a memory
 * POST /api/memory
 */
router.post(
  '/memory',
  validateProjectName,
  validate(createMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Recall memories by query
 * POST /api/memory/recall
 */
router.post(
  '/memory/recall',
  validateProjectName,
  validate(recallMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      projectName,
      query,
      type,
      limit = 5,
      tag,
      graphRecall,
      ragFusion,
      recencyBoost,
    } = req.body;
    const config = (await import('../config')).default;

    // Always search durable (legacy) collection
    const durableResults = await memoryService.recall({
      projectName,
      query,
      type: type as MemoryType | 'all',
      limit,
      tag,
      graphRecall,
    });

    // When consolidation enabled, also search episodic+semantic LTM and merge
    if (config.CONSOLIDATION_ENABLED) {
      try {
        const ltmResults = await memoryLtm.recall({
          projectName,
          query,
          limit,
        });

        if (ltmResults.length > 0) {
          // Merge: add LTM results that aren't already in durable results
          const existingIds = new Set(durableResults.map((r) => r.memory.id));
          for (const ltm of ltmResults) {
            if (existingIds.has(ltm.memory.id)) continue;
            durableResults.push({
              memory: {
                id: ltm.memory.id,
                type: ('subtype' in ltm.memory ? ltm.memory.subtype : 'insight') as MemoryType,
                content: ltm.memory.content,
                tags: ltm.memory.tags ?? [],
                relatedTo: undefined,
                createdAt: ('createdAt' in ltm.memory
                  ? ltm.memory.createdAt
                  : ltm.memory.timestamp) as string,
                updatedAt: ('updatedAt' in ltm.memory ? ltm.memory.updatedAt : '') as string,
                metadata: { ltmCollection: ltm.collection, retention: ltm.retention },
                status: undefined,
                statusHistory: undefined,
                relationships: ltm.memory.relationships,
                supersededBy: ('supersededBy' in ltm.memory
                  ? ltm.memory.supersededBy
                  : undefined) as string | undefined,
              },
              score: ltm.score,
            });
          }

          // Re-sort and re-limit
          durableResults.sort((a, b) => b.score - a.score);
          durableResults.splice(limit);
        }
      } catch {
        // LTM search failed — return durable-only results
      }
    }

    res.json({ results: durableResults });
  })
);

/**
 * List memories
 * GET /api/memory/list
 */
router.get(
  '/memory/list',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Delete a memory
 * DELETE /api/memory/:id
 */
router.delete(
  '/memory/:id',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { id } = req.params;

    const success = await memoryService.forget(projectName, id);
    res.json({ success });
  })
);

/**
 * Delete memories by type
 * DELETE /api/memory/type/:type
 */
router.delete(
  '/memory/type/:type',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { type } = req.params;

    const count = await memoryService.forgetByType(projectName, type as MemoryType);
    res.json({ success: true, deleted: count });
  })
);

/**
 * Delete memories older than N days (both durable and quarantine)
 * POST /api/memory/forget-older
 */
router.post(
  '/memory/forget-older',
  validateProjectName,
  validate(forgetOlderThanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, olderThanDays } = req.body;

    const [durableDeleted, quarantineDeleted] = await Promise.all([
      memoryService.forgetOlderThan(projectName, olderThanDays),
      memoryService.forgetOlderThan(projectName, olderThanDays, 'quarantine'),
    ]);

    res.json({
      success: true,
      deleted: durableDeleted + quarantineDeleted,
      durable: durableDeleted,
      quarantine: quarantineDeleted,
      olderThanDays,
    });
  })
);

/**
 * Update todo status
 * PATCH /api/memory/todo/:id
 */
router.patch(
  '/memory/todo/:id',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Get memory stats
 * GET /api/memory/stats
 */
router.get(
  '/memory/stats',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;

    const stats = await memoryService.getStats(projectName);
    res.json({ stats });
  })
);

/**
 * Merge duplicate/similar memories
 * POST /api/memory/merge
 */
router.post(
  '/memory/merge',
  validateProjectName,
  validate(mergeMemoriesSchema),
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Recall only from durable storage (for enrichment)
 * POST /api/memory/recall-durable
 */
router.post(
  '/memory/recall-durable',
  validateProjectName,
  validate(recallMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, query, type, limit, tag } = req.body;

    const results = await memoryGovernance.recallDurable({
      projectName,
      query,
      type: type as MemoryType | 'all',
      limit,
      tag,
    });

    res.json({ results });
  })
);

/**
 * Promote memory from quarantine to durable
 * POST /api/memory/promote
 */
router.post(
  '/memory/promote',
  validateProjectName,
  validate(promoteMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, memoryId, reason, evidence, runGates, projectPath, affectedFiles } =
      req.body;

    const memory = await memoryGovernance.promote(
      projectName,
      memoryId,
      reason as PromoteReason,
      evidence,
      runGates ? { runGates, projectPath, affectedFiles } : undefined
    );

    res.json({ success: true, memory });
  })
);

/**
 * List quarantine memories for review
 * GET /api/memory/quarantine
 */
router.get(
  '/memory/quarantine',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = req.query.offset as string | undefined;

    const memories = await memoryGovernance.listQuarantine(projectName, limit, offset);
    res.json({ memories, count: memories.length });
  })
);

// ============================================
// Batch & Auto-learning Routes
// ============================================

/**
 * Batch store memories
 * POST /api/memory/batch
 */
router.post(
  '/memory/batch',
  validateProjectName,
  validate(batchCreateMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, items } = req.body;

    const result = await memoryService.batchRemember(projectName, items);
    res.json({
      success: result.errors.length === 0,
      savedCount: result.saved.length,
      memories: result.saved,
      errors: result.errors,
    });
  })
);

/**
 * Extract learnings from text/conversation
 * POST /api/memory/extract
 */
router.post(
  '/memory/extract',
  validateProjectName,
  validate(analyzeConversationSchema),
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Validate an auto-extracted memory
 * PATCH /api/memory/:id/validate
 */
router.patch(
  '/memory/:id/validate',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Get unvalidated auto-extracted memories for review
 * GET /api/memory/unvalidated
 */
router.get(
  '/memory/unvalidated',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const limit = parseInt(req.query.limit as string) || 20;

    const memories = await memoryService.getUnvalidatedMemories(projectName, limit);
    res.json({ memories, count: memories.length });
  })
);

// ============================================
// Quality Gate Routes
// ============================================

/**
 * Run quality gates on demand
 * POST /api/quality/run
 */
router.post(
  '/quality/run',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

/**
 * Blast radius analysis
 * POST /api/quality/blast-radius
 */
router.post(
  '/quality/blast-radius',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, files, maxDepth = 3 } = req.body;

    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'files array is required' });
    }

    const { graphStore } = await import('../services/graph-store');
    const result = await graphStore.getBlastRadius(projectName, files, maxDepth);
    res.json(result);
  })
);

// ============================================
// Feedback-Driven Memory Maintenance
// ============================================

/**
 * Run memory maintenance (quarantine cleanup, feedback, compaction)
 * POST /api/memory/maintenance
 */
router.post(
  '/memory/maintenance',
  validateProjectName,
  validate(maintenanceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, operations } = req.body;
    const result = await memoryGovernance.runMaintenance(projectName, operations);
    res.json(result);
  })
);

/**
 * Get developer profile (accumulated usage patterns)
 * GET /api/developer-profile
 */
router.get(
  '/developer-profile',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { usagePatterns } = await import('../services/usage-patterns');
    const profile = await usagePatterns.buildDeveloperProfile(projectName);
    res.json(profile);
  })
);

/**
 * Detect stale memories
 * GET /api/memory/stale
 */
router.get(
  '/memory/stale',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { staleMemoryDetector } = await import('../services/stale-memory-detector');
    const result = await staleMemoryDetector.detectStaleMemories(projectName);
    res.json(result);
  })
);

// ── Phase 2: Consolidation + Episodic/Semantic LTM ──────

/**
 * Recall from LTM only (episodic + semantic with Ebbinghaus decay)
 * POST /api/memory/recall-ltm
 */
router.post(
  '/memory/recall-ltm',
  validateProjectName,
  validate(recallMemorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, query, limit = 5 } = req.body;
    const subtype = req.body.subtype as string | undefined;

    const results = await memoryLtm.recall({
      projectName,
      query,
      limit,
      subtype: subtype as any,
    });

    res.json({
      results: results.map((r) => ({
        memory: r.memory,
        score: r.score,
        retention: r.retention,
        collection: r.collection,
      })),
      count: results.length,
    });
  })
);

/**
 * Trigger consolidation for a session
 * POST /api/memory/consolidate
 */
router.post(
  '/memory/consolidate',
  validateProjectName,
  validate(consolidateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, sessionId, timeout } = req.body;
    const result = await consolidationAgent.consolidate(projectName, sessionId, { timeout });
    res.json({ success: true, ...result });
  })
);

/**
 * List episodic long-term memories
 * GET /api/memory/episodic
 */
router.get(
  '/memory/episodic',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const memories = await memoryLtm.list(projectName, 'episodic', { limit });
    res.json({ memories, count: memories.length });
  })
);

/**
 * List semantic long-term memories
 * GET /api/memory/semantic
 */
router.get(
  '/memory/semantic',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const subtype = req.query.subtype as string | undefined;
    const memories = await memoryLtm.list(projectName, 'semantic', {
      limit,
      subtype: subtype as any,
    });
    res.json({ memories, count: memories.length });
  })
);

/**
 * Get LTM stats (episodic + semantic counts)
 * GET /api/memory/ltm-stats
 */
router.get(
  '/memory/ltm-stats',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const stats = await memoryLtm.getStats(projectName);
    res.json(stats);
  })
);

// ── Phase 3: Reconsolidation ────────────────────────────

/**
 * Process pending co-recall relationships
 * POST /api/memory/process-corecalls
 */
router.post(
  '/memory/process-corecalls',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const result = await reconsolidation.processCoRecalls(projectName);
    res.json({ success: true, ...result });
  })
);

/**
 * Get co-recall stats for a specific memory
 * GET /api/memory/corecall-stats/:memoryId
 */
router.get(
  '/memory/corecall-stats/:memoryId',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { memoryId } = req.params;
    const stats = await reconsolidation.getCoRecallStats(projectName, memoryId);
    res.json(stats);
  })
);

// ── Phase 4: Graph-Aware Recall ─────────────────────────

/**
 * Get relationship subgraph around a memory
 * GET /api/memory/graph/:memoryId
 */
router.get(
  '/memory/graph/:memoryId',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const { memoryId } = req.params;
    const subgraph = await memoryGraph.getSubgraph(projectName, [memoryId]);
    res.json(subgraph);
  })
);

/**
 * Visualize full memory graph (for dashboard)
 * POST /api/memory/graph/visualize
 */
router.post(
  '/memory/graph/visualize',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, memoryIds } = req.body;
    const ids = Array.isArray(memoryIds) ? memoryIds : [];
    const subgraph = await memoryGraph.getSubgraph(projectName, ids);
    res.json(subgraph);
  })
);

// ── Migration ───────────────────────────────────────────

/**
 * Migrate durable memories to episodic/semantic LTM
 * POST /api/memory/migrate-ltm
 */
router.post(
  '/memory/migrate-ltm',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const dryRun = req.body.dryRun !== false; // default: dry run

    const result = await memoryMigration.migrate(projectName, { dryRun });
    res.json({ success: true, dryRun, ...result });
  })
);

export default router;
