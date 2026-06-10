/**
 * Analytics Routes - Conversation analysis and tool usage tracking
 */

import { Router, Request, Response } from 'express';
import { conversationAnalyzer } from '../services/conversation-analyzer';
import { usageTracker } from '../services/usage-tracker';
import { workRegistry, type WorkType, type WorkState } from '../services/work-handler';
// predictiveLoader removed — 0 calls in production audit
import { asyncHandler } from '../middleware/async-handler';
import {
  validate,
  validateProjectName,
  analyzeConversationSchema,
  trackUsageSchema,
} from '../utils/validation';

const router = Router();

// ============================================
// Conversation Analysis
// ============================================

/**
 * Analyze a conversation and extract learnings
 * POST /api/analyze-conversation
 */
router.post(
  '/analyze-conversation',
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
 * Extract entities from text (fast, no LLM)
 * POST /api/extract-entities
 */
router.post(
  '/extract-entities',
  asyncHandler(async (req: Request, res: Response) => {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const entities = await conversationAnalyzer.extractEntities(text);
    res.json(entities);
  })
);

// ============================================
// Tool Usage Tracking
// ============================================

/**
 * Track a tool invocation
 * POST /api/track-usage
 */
router.post(
  '/track-usage',
  validateProjectName,
  validate(trackUsageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      projectName,
      sessionId,
      toolName,
      inputSummary,
      startTime,
      resultCount,
      success,
      errorMessage,
      metadata,
    } = req.body;

    const usage = await usageTracker.track({
      projectName,
      sessionId,
      toolName,
      inputSummary: inputSummary || '',
      startTime: startTime || Date.now(),
      resultCount,
      success: success !== false,
      errorMessage,
      metadata,
    });

    res.json({ tracked: true, id: usage.id });
  })
);

/**
 * Get tool usage statistics
 * GET /api/tool-analytics
 */
router.get(
  '/tool-analytics',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const days = parseInt(req.query.days as string) || 7;

    const stats = await usageTracker.getStats(projectName, days);
    res.json(stats);
  })
);

/**
 * Get knowledge gaps (queries with low results)
 * GET /api/knowledge-gaps
 */
router.get(
  '/knowledge-gaps',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const limit = parseInt(req.query.limit as string) || 20;

    const gaps = await usageTracker.getKnowledgeGaps(projectName, limit);
    res.json({ gaps });
  })
);

/**
 * Find similar past queries
 * POST /api/similar-queries
 */
router.post(
  '/similar-queries',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, query, limit = 5 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const similar = await usageTracker.findSimilarQueries(projectName, query, limit);
    res.json({
      similar: similar.map((s) => ({
        toolName: s.usage.toolName,
        inputSummary: s.usage.inputSummary,
        resultCount: s.usage.resultCount,
        success: s.usage.success,
        score: s.score,
      })),
    });
  })
);

// ============================================
// Behavior Patterns Routes
// ============================================

/**
 * Get user behavior patterns from tool usage
 * GET /api/behavior-patterns
 */
router.get(
  '/behavior-patterns',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const days = parseInt(req.query.days as string) || 7;
    const sessionId = req.query.sessionId as string | undefined;

    const patterns = await usageTracker.getBehaviorPatterns(projectName, { days, sessionId });
    res.json(patterns);
  })
);

// Prediction Routes REMOVED — 0 calls in production audit

// ============================================
// Enrichment Tracking (from MCP server)
// ============================================

/**
 * Track a context enrichment event
 * POST /api/track-enrichment
 */
router.post(
  '/track-enrichment',
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, tool, result, recallCount, durationMs } = req.body;

    // Import metrics lazily to avoid circular deps
    const metrics = await import('../utils/metrics');
    if (projectName && tool) {
      metrics.enrichmentTotal.inc({ project: projectName, tool, result: result || 'unknown' });
    }
    if (projectName && durationMs) {
      metrics.enrichmentDuration.observe({ project: projectName }, durationMs / 1000);
    }
    if (projectName && recallCount !== undefined) {
      metrics.enrichmentRecallCount.observe({ project: projectName }, recallCount);
    }

    res.json({ tracked: true });
  })
);

// ============================================
// Work Registry (unified status for indexer/agent/claude-agent)
// ============================================

/**
 * List active work items
 * GET /api/work
 */
router.get(
  '/work',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.query.type as WorkType | undefined;
    const projectName = req.query.projectName as string | undefined;
    const state = req.query.state as WorkState | undefined;

    const items = workRegistry.list({ type, projectName, state });
    const counts = workRegistry.getRunningCounts();

    res.json({ items, running: counts });
  })
);

/**
 * Get a specific work item
 * GET /api/work/:id
 */
router.get(
  '/work/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const item = workRegistry.get(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Work item not found' });
    }
    res.json(item);
  })
);

/**
 * Cancel a work item
 * POST /api/work/:id/cancel
 */
router.post(
  '/work/:id/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const cancelled = workRegistry.cancel(req.params.id);
    res.json({ cancelled });
  })
);

// ============================================
// Cost Tracking
// ============================================

// ============================================
// Platform Analytics (cross-project)
// ============================================

/**
 * Get aggregated platform stats across all projects
 * GET /api/platform/stats
 */
router.get(
  '/platform/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const { vectorStore } = await import('../services/vector-store');
    const collections = await vectorStore.listCollections();

    // Group collections by project
    const projects = new Map<string, string[]>();
    for (const col of collections) {
      const parts = col.split('_');
      if (parts.length >= 2) {
        const project = parts[0];
        if (!projects.has(project)) projects.set(project, []);
        projects.get(project)!.push(col);
      }
    }

    const projectStats = [];
    for (const [project, cols] of projects) {
      let totalVectors = 0;
      for (const col of cols) {
        try {
          const info = await vectorStore.getCollectionInfo(col);
          totalVectors += info.vectorsCount;
        } catch {
          // Skip inaccessible collections
        }
      }
      projectStats.push({
        project,
        collections: cols.length,
        totalVectors,
      });
    }

    res.json({
      totalProjects: projects.size,
      totalCollections: collections.length,
      projects: projectStats,
    });
  })
);

/**
 * Get agent statistics across all projects
 * GET /api/platform/agent-stats
 */
router.get(
  '/platform/agent-stats',
  asyncHandler(async (req: Request, res: Response) => {
    const metrics = await import('../utils/metrics');
    const agentMetrics = await metrics.registry.getSingleMetricAsString('agent_runs_total');
    const durationMetrics =
      await metrics.registry.getSingleMetricAsString('agent_duration_seconds');

    res.json({
      message: 'Agent statistics available via /metrics endpoint (Prometheus format)',
      agentRuns: agentMetrics,
      agentDuration: durationMetrics,
    });
  })
);

/**
 * Get enrichment statistics across all projects
 * GET /api/platform/enrichment-stats
 */
router.get(
  '/platform/enrichment-stats',
  asyncHandler(async (req: Request, res: Response) => {
    const metrics = await import('../utils/metrics');
    const enrichmentMetrics = await metrics.registry.getSingleMetricAsString('enrichment_total');
    const durationMetrics = await metrics.registry.getSingleMetricAsString(
      'enrichment_duration_seconds'
    );

    res.json({
      message: 'Enrichment statistics available via /metrics endpoint (Prometheus format)',
      enrichmentTotal: enrichmentMetrics,
      enrichmentDuration: durationMetrics,
    });
  })
);

export default router;
