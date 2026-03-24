/**
 * Session Context Service - Manage session state and context persistence
 *
 * Features:
 * - Session lifecycle management (start, get, end)
 * - Context persistence across interactions
 * - Session summary and learnings extraction on end
 * - Cross-session context transfer
 */

import { v4 as uuidv4 } from 'uuid';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';
import { memoryService } from './memory';
import { memoryGovernance } from './memory-governance';
import { conversationAnalyzer } from './conversation-analyzer';
import { usagePatterns } from './usage-patterns';
import { predictiveLoader } from './predictive-loader';
import { cacheService } from './cache';
import { projectProfileService } from './project-profile';
import { staleMemoryDetector } from './stale-memory-detector';
import { workingMemory } from './working-memory';
import { sensoryBuffer } from './sensory-buffer';
import { consolidationAgent } from './consolidation-agent';
import { logger } from '../utils/logger';
import config from '../config';

export interface SessionContext {
  sessionId: string;
  projectName: string;
  startedAt: string;
  lastActivityAt: string;
  status: 'active' | 'paused' | 'ended';
  // Context data
  currentFiles: string[];
  recentQueries: string[];
  activeFeatures: string[];
  toolsUsed: string[];
  // Accumulated learnings
  pendingLearnings: string[];
  decisions: string[];
  // Metadata
  metadata?: Record<string, unknown>;
}

export interface StartSessionOptions {
  projectName: string;
  sessionId?: string;
  initialContext?: string;
  resumeFrom?: string; // Previous session ID to resume from
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  projectName: string;
  sessionId: string;
  summary?: string;
  autoSaveLearnings?: boolean;
  feedback?: 'productive' | 'neutral' | 'unproductive';
}

export interface SessionSummary {
  sessionId: string;
  duration: number;
  toolsUsed: string[];
  filesAffected: string[];
  queriesCount: number;
  learningsSaved: number;
  summary: string;
  staleMemoriesCount?: number;
  workingMemorySlots?: number;
  sensoryEventCount?: number;
}

class SessionContextService {
  private getCollectionName(projectName: string): string {
    return `${projectName}_sessions`;
  }

  private getCacheKey(projectName: string, sessionId: string): string {
    return `session:${projectName}:${sessionId}`;
  }

  /**
   * Start a new session or resume existing
   */
  async startSession(options: StartSessionOptions): Promise<SessionContext> {
    const {
      projectName,
      sessionId = uuidv4(),
      initialContext,
      resumeFrom,
      metadata,
    } = options;

    // Cleanup stale active sessions before looking for resumable ones
    await this.cleanupStaleSessions(projectName);

    let context: SessionContext;

    // Try to resume from previous session (explicit or auto-detected)
    const resumeId = resumeFrom || await this.findLastSessionId(projectName);
    if (resumeId) {
      const previousContext = await this.getSession(projectName, resumeId);
      if (previousContext) {
        context = {
          sessionId,
          projectName,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          status: 'active',
          currentFiles: previousContext.currentFiles,
          recentQueries: previousContext.recentQueries.slice(-5),
          activeFeatures: previousContext.activeFeatures,
          toolsUsed: [],
          pendingLearnings: [],
          decisions: previousContext.decisions,
          metadata: { ...previousContext.metadata, ...metadata, resumedFrom: resumeId },
        };
      } else {
        context = this.createNewContext(sessionId, projectName, metadata);
      }
    } else {
      context = this.createNewContext(sessionId, projectName, metadata);
    }

    // Process initial context
    if (initialContext) {
      const extracted = await conversationAnalyzer.extractEntities(initialContext);
      context.currentFiles = [...context.currentFiles, ...extracted.files];
      context.activeFeatures = [...context.activeFeatures, ...extracted.concepts];
    }

    // Store in cache for fast access
    await cacheService.set(
      this.getCacheKey(projectName, sessionId),
      context,
      3600 // 1 hour TTL
    );

    // Also persist to Qdrant for durability
    await this.persistSession(context);

    logger.info(`Session started: ${sessionId}`, { projectName, resumeFrom });

    // Initialize working memory for this session (human memory layer)
    workingMemory.init(projectName, sessionId).catch(err =>
      logger.debug('Working memory init failed', { error: err.message })
    );

    // Background: generate predictions and prefetch likely-needed resources
    this.triggerPredictivePrefetch(context).catch(err =>
      logger.debug('Background prefetch failed', { error: err.message })
    );

    // Background: auto-merge similar memories to prevent bloat
    this.triggerAutoMerge(projectName).catch(err =>
      logger.debug('Background auto-merge failed', { error: err.message })
    );

    // Build briefing with project profile + recalled context
    try {
      const briefing = await this.buildSessionBriefing(context);
      if (briefing) {
        context.metadata = { ...context.metadata, briefing };
      }
    } catch (err: any) {
      logger.debug('Failed to build session briefing', { error: err.message });
    }

    return context;
  }

  /**
   * Get current session context
   */
  async getSession(projectName: string, sessionId: string): Promise<SessionContext | null> {
    // Try cache first
    const cached = await cacheService.get<SessionContext>(
      this.getCacheKey(projectName, sessionId)
    );
    if (cached) {
      return cached;
    }

    // Fall back to Qdrant
    const collection = this.getCollectionName(projectName);
    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 1,
        with_payload: true,
        filter: {
          must: [{ key: 'sessionId', match: { value: sessionId } }],
        },
      });

      if (results.points.length > 0) {
        const context = results.points[0].payload as unknown as SessionContext;
        // Refresh cache
        await cacheService.set(
          this.getCacheKey(projectName, sessionId),
          context,
          3600
        );
        return context;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.error('Failed to get session', { error: error.message });
      }
    }

    return null;
  }

  /**
   * Update session context
   */
  async updateSession(
    projectName: string,
    sessionId: string,
    updates: Partial<SessionContext>
  ): Promise<SessionContext | null> {
    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      return null;
    }

    const updatedContext: SessionContext = {
      ...context,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    // Update cache
    await cacheService.set(
      this.getCacheKey(projectName, sessionId),
      updatedContext,
      3600
    );

    // Persist to Qdrant
    await this.persistSession(updatedContext);

    return updatedContext;
  }

  /**
   * Add activity to session (file, query, tool)
   */
  async addActivity(
    projectName: string,
    sessionId: string,
    activity: {
      type: 'file' | 'query' | 'tool' | 'learning' | 'decision';
      value: string;
    }
  ): Promise<void> {
    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      logger.warn(`Session not found: ${sessionId}`);
      return;
    }

    switch (activity.type) {
      case 'file':
        if (!context.currentFiles.includes(activity.value)) {
          context.currentFiles = [...context.currentFiles, activity.value].slice(-20);
        }
        break;
      case 'query':
        context.recentQueries = [...context.recentQueries, activity.value].slice(-50);
        break;
      case 'tool':
        if (!context.toolsUsed.includes(activity.value)) {
          context.toolsUsed.push(activity.value);
        }
        break;
      case 'learning':
        context.pendingLearnings.push(activity.value);
        break;
      case 'decision':
        context.decisions.push(activity.value);
        break;
    }

    await this.updateSession(projectName, sessionId, context);

    // Background: update predictions on new activity
    this.triggerPredictivePrefetch(context).catch(err =>
      logger.debug('Background prefetch on activity failed', { error: err.message })
    );
  }

  /**
   * End a session and save learnings
   */
  async endSession(options: EndSessionOptions): Promise<SessionSummary> {
    const { projectName, sessionId, summary, autoSaveLearnings = false, feedback } = options;

    const context = await this.getSession(projectName, sessionId);
    if (!context) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Calculate duration
    const startTime = new Date(context.startedAt).getTime();
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Get usage summary
    let usageSummary: any = { toolsUsed: [], filesAffected: [], keyActions: [] };
    try {
      usageSummary = await usagePatterns.summarizeChanges(projectName, sessionId);
    } catch {
      // Ignore errors
    }

    // Save learnings: use consolidation agent (Phase 2) or legacy path
    let learningsSaved = 0;
    if (config.CONSOLIDATION_ENABLED && autoSaveLearnings) {
      // Phase 2: Consolidation agent processes WM + sensory buffer → episodic/semantic LTM
      try {
        const consolidation = await consolidationAgent.consolidate(projectName, sessionId);
        learningsSaved = consolidation.episodic.length + consolidation.semantic.length;
        logger.info(`Consolidation produced ${learningsSaved} memories`, {
          episodic: consolidation.episodic.length,
          semantic: consolidation.semantic.length,
          patterns: consolidation.patternsDetected,
          durationMs: consolidation.durationMs,
        });
      } catch (err: any) {
        logger.warn('Consolidation failed, falling back to legacy path', { error: err.message });
        // Fall through to legacy path below
        learningsSaved = await this.legacyExtractLearnings(projectName, sessionId, context, autoSaveLearnings);
      }
    } else {
      // Legacy path: pending learnings + conversation analyzer
      learningsSaved = await this.legacyExtractLearnings(projectName, sessionId, context, autoSaveLearnings);
    }

    // Update session status
    await this.updateSession(projectName, sessionId, {
      status: 'ended',
      metadata: {
        ...context.metadata,
        endedAt: new Date().toISOString(),
        feedback,
        summary: summary || usageSummary.summary,
      },
    });

    // Clear from active cache
    await cacheService.delete(this.getCacheKey(projectName, sessionId));

    // Detect stale memories (non-blocking)
    let staleMemoriesCount = 0;
    try {
      const staleResult = await staleMemoryDetector.detectStaleMemories(projectName);
      staleMemoriesCount = staleResult.staleMemories.length;
      if (staleMemoriesCount > 0) {
        logger.info(`Found ${staleMemoriesCount} stale memories for ${projectName}`, {
          reasons: staleResult.staleMemories.slice(0, 5).map(m => m.reason),
        });
      }
    } catch {
      // Non-critical, ignore
    }

    // Log working memory state before cleanup (Phase 2 will use this for consolidation)
    let workingMemorySlots = 0;
    let sensoryEventCount = 0;
    try {
      const wmState = await workingMemory.getState(projectName, sessionId);
      workingMemorySlots = wmState.slots.length;
      sensoryEventCount = await sensoryBuffer.getLength(projectName, sessionId);
      if (workingMemorySlots > 0) {
        logger.info(`Session ${sessionId} working memory: ${workingMemorySlots} slots, ${sensoryEventCount} sensory events`);
      }
    } catch {
      // Non-critical
    }

    // Cleanup working memory and schedule sensory buffer TTL expiry
    workingMemory.clear(projectName, sessionId).catch(() => {});
    // Sensory buffer has its own TTL and will auto-expire

    const result: SessionSummary = {
      sessionId,
      duration,
      toolsUsed: usageSummary.toolsUsed || context.toolsUsed,
      filesAffected: usageSummary.filesAffected || context.currentFiles,
      queriesCount: context.recentQueries.length,
      learningsSaved,
      summary: summary || usageSummary.summary || 'Session ended',
      staleMemoriesCount,
      workingMemorySlots,
      sensoryEventCount,
    };

    logger.info(`Session ended: ${sessionId}`, {
      duration: Math.round(duration / 1000),
      learningsSaved,
      staleMemories: staleMemoriesCount,
      workingMemorySlots,
      sensoryEventCount,
    });

    return result;
  }

  /**
   * List recent sessions for a project
   */
  async listSessions(
    projectName: string,
    options: { limit?: number; status?: 'active' | 'ended' | 'all' } = {}
  ): Promise<Array<{ sessionId: string; startedAt: string; status: string }>> {
    const { limit = 20, status = 'all' } = options;
    const collection = this.getCollectionName(projectName);

    try {
      const filter: any = { must: [] };
      if (status !== 'all') {
        filter.must.push({ key: 'status', match: { value: status } });
      }

      const results = await vectorStore['client'].scroll(collection, {
        limit,
        with_payload: true,
        filter: filter.must.length > 0 ? filter : undefined,
      });

      return results.points.map(p => ({
        sessionId: (p.payload as any).sessionId,
        startedAt: (p.payload as any).startedAt,
        status: (p.payload as any).status,
      }));
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Trigger predictive prefetch in the background (fire-and-forget)
   */
  private async triggerPredictivePrefetch(context: SessionContext): Promise<void> {
    const predictions = await predictiveLoader.predict(
      context.projectName,
      context.sessionId,
      {
        currentFiles: context.currentFiles,
        recentQueries: context.recentQueries,
        toolsUsed: context.toolsUsed,
        activeFeatures: context.activeFeatures,
      }
    );

    if (predictions.length > 0) {
      await predictiveLoader.prefetch(context.projectName, context.sessionId, predictions);
    }
  }

  /**
   * Build a session briefing with project profile + developer profile + recalled context.
   */
  private async buildSessionBriefing(context: SessionContext): Promise<string | null> {
    const parts: string[] = [];

    // Get project profile summary
    try {
      const summary = await projectProfileService.getCompactSummary(context.projectName);
      if (summary) {
        parts.push(summary);
      }
    } catch {
      // Profile not available yet
    }

    // Add developer profile highlights
    try {
      const devProfile = await usagePatterns.buildDeveloperProfile(context.projectName);
      if (devProfile.totalToolCalls > 0) {
        const topFiles = devProfile.frequentFiles.slice(0, 5).map(f => f.file).join(', ');
        const topTools = devProfile.preferredTools.slice(0, 3).map(t => t.tool).join(', ');
        const peakHrs = devProfile.peakHours.slice(0, 2).map(h => `${h.hour}:00`).join(', ');
        parts.push(`Developer: ${devProfile.totalSessions} sessions, top files: ${topFiles}, top tools: ${topTools}, peak hours: ${peakHrs}`);
      }
    } catch {
      // Non-critical
    }

    // Auto-recall memories relevant to initial context
    if (context.activeFeatures.length > 0 || context.recentQueries.length > 0) {
      try {
        const query = [...context.activeFeatures, ...context.recentQueries.slice(-3)].join(' ');
        const memories = await memoryService.recall({
          projectName: context.projectName,
          query,
          limit: 5,
          type: 'all',
        });

        const relevant = memories.filter(m => m.score >= 0.6);
        if (relevant.length > 0) {
          parts.push('Relevant context:');
          for (const m of relevant.slice(0, 5)) {
            parts.push(`- [${m.memory.type}] ${m.memory.content.slice(0, 150)}`);
          }
        }
      } catch {
        // Non-critical
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Trigger auto-merge of similar durable memories (fire-and-forget).
   * Runs at most once per hour per project via simple time tracking.
   */
  private lastMergeTime = new Map<string, number>();

  private async triggerAutoMerge(projectName: string): Promise<void> {
    const lastMerge = this.lastMergeTime.get(projectName) || 0;
    if (Date.now() - lastMerge < 60 * 60 * 1000) return; // Skip if merged < 1h ago

    this.lastMergeTime.set(projectName, Date.now());

    const result = await memoryService.mergeMemories({
      projectName,
      type: 'all',
      threshold: 0.9,
      dryRun: false,
      limit: 50,
    });

    if (result.totalMerged > 0) {
      logger.info(`Auto-merged ${result.totalMerged} memory clusters on session start`, { project: projectName });
    }
  }

  /**
   * End stale active sessions (no activity for 2+ hours).
   */
  private async cleanupStaleSessions(projectName: string): Promise<void> {
    const collection = this.getCollectionName(projectName);
    const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 20,
        with_payload: true,
        filter: {
          must: [
            { key: 'status', match: { value: 'active' } },
            { key: 'lastActivityAt', range: { lte: staleCutoff } },
          ],
        },
      });

      for (const point of results.points) {
        const session = point.payload as unknown as SessionContext;
        await this.updateSession(projectName, session.sessionId, {
          status: 'ended',
          metadata: {
            ...session.metadata,
            endedAt: new Date().toISOString(),
            endReason: 'stale_cleanup',
          },
        });
        logger.info(`Cleaned up stale session: ${session.sessionId}`, { projectName });
      }
    } catch (error: any) {
      if (error.status !== 404) {
        logger.debug('Failed to cleanup stale sessions', { error: error.message });
      }
    }
  }

  /**
   * Find the most recent ended session within 24h for auto-continuity.
   */
  private async findLastSessionId(projectName: string): Promise<string | null> {
    const collection = this.getCollectionName(projectName);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const results = await vectorStore['client'].scroll(collection, {
        limit: 5,
        with_payload: true,
        filter: {
          should: [
            { key: 'status', match: { value: 'ended' } },
            { key: 'status', match: { value: 'active' } },
          ],
          must: [
            { key: 'startedAt', range: { gte: cutoff } },
          ],
        },
      });

      if (results.points.length === 0) return null;

      // Sort by startedAt desc and return the most recent
      const sorted = results.points
        .map(p => p.payload as unknown as SessionContext)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      return sorted[0]?.sessionId || null;
    } catch (error: any) {
      if (error.status === 404) return null;
      logger.debug('Failed to find last session', { error: error.message });
      return null;
    }
  }

  /**
   * Legacy learning extraction path (pre-consolidation).
   * Saves pending learnings + decisions via governance, then runs conversation analyzer.
   */
  private async legacyExtractLearnings(
    projectName: string,
    sessionId: string,
    context: SessionContext,
    autoSaveLearnings: boolean
  ): Promise<number> {
    let learningsSaved = 0;

    if (autoSaveLearnings && context.pendingLearnings.length > 0) {
      for (const learning of context.pendingLearnings) {
        try {
          await memoryGovernance.ingest({
            projectName,
            content: learning,
            type: 'insight',
            tags: ['session', sessionId.slice(0, 8)],
            metadata: { sessionId },
            source: 'auto_conversation',
          });
          learningsSaved++;
        } catch {
          // Ignore individual failures
        }
      }
    }

    for (const decision of context.decisions) {
      try {
        await memoryGovernance.ingest({
          projectName,
          content: decision,
          type: 'decision',
          tags: ['session', sessionId.slice(0, 8)],
          metadata: { sessionId },
          source: 'auto_conversation',
        });
        learningsSaved++;
      } catch {
        // Ignore individual failures
      }
    }

    if (autoSaveLearnings && context.recentQueries.length > 5) {
      try {
        const querySummary = context.recentQueries.slice(-10).join('\n');
        const extracted = await conversationAnalyzer.analyze({
          projectName,
          conversation: querySummary,
          context: `Session ${sessionId} tool interactions`,
          autoSave: true,
          minConfidence: 0.7,
        });
        learningsSaved += extracted.learnings?.length || 0;
      } catch {
        // Non-critical, ignore
      }
    }

    return learningsSaved;
  }

  private createNewContext(
    sessionId: string,
    projectName: string,
    metadata?: Record<string, unknown>
  ): SessionContext {
    return {
      sessionId,
      projectName,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: 'active',
      currentFiles: [],
      recentQueries: [],
      activeFeatures: [],
      toolsUsed: [],
      pendingLearnings: [],
      decisions: [],
      metadata,
    };
  }

  private async persistSession(context: SessionContext): Promise<void> {
    const collection = this.getCollectionName(context.projectName);

    try {
      // Create embedding from session context
      const contextText = [
        ...context.currentFiles,
        ...context.activeFeatures,
        ...context.recentQueries.slice(-5),
      ].join(' ');

      const embedding = await embeddingService.embed(
        contextText || `session ${context.sessionId}`
      );

      const point: VectorPoint = {
        id: context.sessionId,
        vector: embedding,
        payload: context as unknown as Record<string, unknown>,
      };

      await vectorStore.upsert(collection, [point]);
    } catch (error: any) {
      logger.error('Failed to persist session', { error: error.message });
    }
  }
}

export const sessionContext = new SessionContextService();
export default sessionContext;
