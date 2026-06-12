/**
 * Analytics Routes - Conversation analysis and tool usage tracking
 */

import { Router, Request, Response } from 'express';
import { conversationAnalyzer } from '../services/conversation-analyzer';
import { usageTracker } from '../services/usage-tracker';
import { workRegistry, type WorkType, type WorkState } from '../services/work-handler';
import { llmUsageLogger } from '../services/llm-usage-logger';
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

/**
 * LLM usage summary — totals + per-model breakdown from {project}_llm_usage.
 * GET /api/analytics/llm-usage?from=ISO&to=ISO
 *
 * Note: routes/index.ts defines GET /api/analytics/:collection and is mounted
 * before this router; its handler explicitly falls through for `llm-usage`.
 */
router.get(
  '/analytics/llm-usage',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    for (const [name, value] of Object.entries({ from, to })) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        return res.status(400).json({ error: `${name} must be an ISO-8601 date` });
      }
    }

    const summary = await llmUsageLogger.summarize(projectName, { from, to });
    res.json(summary);
  })
);

// ============================================
// Memory ROI (M3 validate-or-kill metric)
// ============================================

/**
 * PINNED tool-name → category mapping (dated 2026-06-12 — Subtraction-plan
 * merges rename tools mid-window; this mapping is the defense). Includes the
 * M2 `memory` tool from day one:
 *
 *   remember-side: channel `manual`     = remember, batch_remember,
 *                                         record_adr, record_pattern
 *                  channel `memory_tool` = memory:create, memory:insert,
 *                                          memory:str_replace
 *   recall-side:   channel `manual`     = recall, get_adrs, get_patterns
 *                  channel `memory_tool` = memory:view
 *
 * The strict-ratio denominator includes adapter-channel writes — otherwise
 * Direction-4 success (manual remembers → ~0 as the adapter takes over) would
 * collapse the Direction-3 denominator and trivially inflate recall/remember
 * past the 0.3 gate.
 */
const ROI_REMEMBER_MANUAL = ['remember', 'batch_remember', 'record_adr', 'record_pattern'] as const;
const ROI_REMEMBER_MEMORY_TOOL = ['memory:create', 'memory:insert', 'memory:str_replace'] as const;
const ROI_RECALL_MANUAL = ['recall', 'get_adrs', 'get_patterns'] as const;
const ROI_RECALL_MEMORY_TOOL = ['memory:view'] as const;

function pickCounts(
  counts: Record<string, number>,
  names: readonly string[],
  stripPrefix?: string
): { byTool: Record<string, number>; total: number } {
  const byTool: Record<string, number> = {};
  let total = 0;
  for (const name of names) {
    const count = counts[name] || 0;
    const key = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
    byTool[key] = count;
    total += count;
  }
  return { byTool, total };
}

/**
 * Validate-or-kill metric — channel-aware recall/remember counts + digest
 * coverage + session hook reliability.
 * GET /api/analytics/memory-roi?projectName=&days=30
 */
router.get(
  '/analytics/memory-roi',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // 1. Tool-call counts from {project}_tool_usage (timestampMs numeric range)
    const counts = await usageTracker.getToolCallCounts(projectName, days);

    const rememberManual = pickCounts(counts, ROI_REMEMBER_MANUAL);
    const rememberMemoryTool = pickCounts(counts, ROI_REMEMBER_MEMORY_TOOL, 'memory:');
    const recallManual = pickCounts(counts, ROI_RECALL_MANUAL);
    const recallMemoryTool = pickCounts(counts, ROI_RECALL_MEMORY_TOOL, 'memory:');

    const remembersTotal = rememberManual.total + rememberMemoryTool.total;
    const recallsTotal = recallManual.total + recallMemoryTool.total;

    // 2. Digest deliveries from the retrieval audit log
    const { retrievalLog } = await import('../services/retrieval-log');
    const digestStats = await retrievalLog.getDigestStats(projectName, days);

    // 3. Session hook reliability from {project}_sessions (window app-side —
    //    startedAt is an ISO string, not range-filterable in Qdrant)
    const { vectorStore } = await import('../services/vector-store');
    let started = 0;
    let ended = 0;
    let endedExplicit = 0;
    const endedSessionIds = new Set<string>();
    try {
      let offset: string | undefined = undefined;
      let scanned = 0;
      do {
        const page = await vectorStore.scrollCollection(
          `${projectName}_sessions`,
          200,
          offset,
          false
        );
        for (const point of page.points) {
          const payload = point.payload as Record<string, unknown>;
          const startedAt = payload.startedAt as string | undefined;
          if (!startedAt || startedAt < since) continue;
          started++;
          if (payload.status === 'ended') {
            ended++;
            const sid = payload.sessionId as string | undefined;
            if (sid) endedSessionIds.add(sid);
            const endReason = (payload.metadata as Record<string, unknown> | undefined)?.endReason;
            if (endReason !== 'stale_cleanup') endedExplicit++;
          }
        }
        scanned += page.points.length;
        offset = page.nextOffset as string | undefined;
      } while (offset && scanned < 10000);
    } catch {
      /* sessions collection unavailable — report zeros */
    }

    // 4. Consolidation completion evidence: episodic LTM writes carry the
    //    sessionId they were consolidated from. (Semantic-only/zero-write
    //    consolidations leave no durable per-session trace — this undercounts
    //    until M4's episodic fix; the day-30 review rider applies.)
    const consolidatedSessions = new Set<string>();
    try {
      let offset: string | undefined = undefined;
      let scanned = 0;
      do {
        const page = await vectorStore.scrollCollection(
          `${projectName}_memory_episodic`,
          200,
          offset,
          false
        );
        for (const point of page.points) {
          const sid = (point.payload as Record<string, unknown>).sessionId as string | undefined;
          if (sid && endedSessionIds.has(sid)) consolidatedSessions.add(sid);
        }
        scanned += page.points.length;
        offset = page.nextOffset as string | undefined;
      } while (offset && scanned < 10000);
    } catch {
      /* episodic collection unavailable — report zeros */
    }

    const ratio = (numerator: number, denominator: number): number | null =>
      denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

    // 5. Capture-channel funnel (M5 validate-or-kill gate: the transcript
    //    channel survives only if its promotion rate stays within 20% of the
    //    memory-tool baseline). ingested/promoted/rejected come from the
    //    per-source governance counters and are CUMULATIVE — they are never
    //    windowed or reset, so the day-30 review reads deltas between
    //    snapshots. pendingInWindow IS windowed: quarantine entries with that
    //    source created since the window start.
    const CAPTURE_SOURCES = ['auto_memory_tool', 'auto_transcript'] as const;
    const { memoryGovernance } = await import('../services/memory-governance');
    const sourceCounters = await memoryGovernance.getSourceCounters(projectName, CAPTURE_SOURCES);

    const pendingBySource: Record<string, number> = {};
    for (const source of CAPTURE_SOURCES) pendingBySource[source] = 0;
    try {
      let offset: string | undefined = undefined;
      let scanned = 0;
      do {
        const page = await vectorStore.scrollCollection(
          `${projectName}_memory_pending`,
          200,
          offset,
          false
        );
        for (const point of page.points) {
          const payload = point.payload as Record<string, unknown>;
          const source = payload.source as string | undefined;
          const createdAt = payload.createdAt as string | undefined;
          if (source && source in pendingBySource && createdAt && createdAt >= since) {
            pendingBySource[source]++;
          }
        }
        scanned += page.points.length;
        offset = page.nextOffset as string | undefined;
      } while (offset && scanned < 10000);
    } catch {
      /* quarantine collection unavailable — report zeros */
    }

    const captureBySource: Record<
      string,
      {
        ingested: number;
        promoted: number;
        rejected: number;
        promotionRate: number | null;
        pendingInWindow: number;
      }
    > = {};
    for (const source of CAPTURE_SOURCES) {
      const counts = sourceCounters[source];
      captureBySource[source] = {
        ingested: counts.ingested,
        promoted: counts.promoted,
        rejected: counts.rejected,
        promotionRate: ratio(counts.promoted, counts.promoted + counts.rejected),
        pendingInWindow: pendingBySource[source],
      };
    }

    res.json({
      projectName,
      days,
      since,
      remembers: {
        total: remembersTotal,
        byChannel: {
          manual: { ...rememberManual.byTool, total: rememberManual.total },
          memory_tool: { ...rememberMemoryTool.byTool, total: rememberMemoryTool.total },
        },
      },
      recalls: {
        total: recallsTotal,
        byChannel: {
          manual: { ...recallManual.byTool, total: recallManual.total },
          memory_tool: { ...recallMemoryTool.byTool, total: recallMemoryTool.total },
        },
      },
      digest: {
        deliveries: digestStats.deliveries,
        nonEmptyDeliveries: digestStats.nonEmptyDeliveries,
        sessionsWithDigest: digestStats.sessionsWithDigest,
        coverage: ratio(digestStats.sessionsWithDigest, started),
      },
      ratios: {
        // Strict = model-initiated recalls / all remembers (both channels) —
        // the named Direction-3 signal.
        strict: ratio(recallsTotal, remembersTotal),
        // Assisted additionally counts non-empty digest deliveries as reads,
        // so the day-30 review can distinguish "digest replaced recall" from
        // "nothing is read".
        assisted: ratio(recallsTotal + digestStats.nonEmptyDeliveries, remembersTotal),
      },
      sessions: {
        started,
        ended,
        endedExplicit,
        staleAutoEnded: ended - endedExplicit,
        endSessionTriggerRate: ratio(endedExplicit, started),
        consolidatedWithLtmEvidence: consolidatedSessions.size,
        consolidationCompletionRate: ratio(consolidatedSessions.size, ended),
      },
      capture: {
        bySource: captureBySource,
      },
    });
  })
);

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
